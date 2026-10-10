/** The detached worker's turn engine: one engine turn for a task, then any follow-ups steered in meanwhile. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  appendTaskLog,
  claimSteers,
  loadTask,
  resolveTaskDir,
  resolveWorkspaceRoot,
  touchActivity,
  writeTask,
  type TaskLogEntry,
} from '../state';
import { writeJsonFileAtomic } from '../../utils/fsx';
import { runTurn } from '../engines/codex';
import { runClaudeTurn } from '../engines/claude';
import { createApprovalHandler, probeApproval } from '../approvals';
import { startChatBridge } from '../engines/codex/chat-bridge';
import {
  PERMISSION_MODES,
  isEndpointModel,
  loadConfig,
  persistModelPatch,
  resolveCodexNetworkAccess,
  resolveCodexModel,
  resolveCustomModel,
} from '../config';
import { detectWireApi } from '../engines/codex/wire';
import { resolveMcpServers } from '../dispatch';
import type { Task, ProgressUpdate, TurnResult } from '../types';
import { agentMailboxDir, MAILBOX_ENV } from '../mailbox';

// Prepended to the initial turn only; resumed turns inherit it from the thread.
const WORKER_SYSTEM_PROMPT = `
You are running inside a coder task: do the work yourself, directly.
Do not load the coder skill (recursive), and never dispatch through the \`coder\` CLI - nested dispatch is disabled.
When finished, provide a concise implementation result summary.
Your turn is one-shot: background processes will not re-invoke you after it ends, so verify synchronously before finishing.
Never run git write operations (commit, checkout, stash, reset, rebase, merge, push, etc.); leave changes uncommitted for the caller to review.
`.trim();

// Agent tasks may run flows from their shell.
const AGENT_FLOW_PROMPT =
  "Flows are the exception: run one from your shell with `coder flow run <name> --wait --json --args '<json>'`; it runs as a script in your sandbox.";

function taskPrompt(task: Task): string {
  // Resumed turns run currentPrompt; task.prompt stays the original task text.
  if (task.resumeThreadId) return task.currentPrompt ?? task.prompt ?? '';
  // --system instructions sit below the worker preamble inside the <system> element.
  const system = task.system ? `\n-------\n${task.system}` : '';
  const flows = task.agentId ? `\n${AGENT_FLOW_PROMPT}` : '';
  return `<system>
${WORKER_SYSTEM_PROMPT}${flows}${system}
</system>

${task.prompt ?? ''}`;
}

// Throttled sign-of-life marker: engines fire this on every server event
// (including unlogged output deltas); a 10s floor keeps the file writes cheap.
function buildHeartbeat(cwd: string, taskId: string) {
  let last = 0;
  return () => {
    if (Date.now() - last >= 10_000) {
      last = Date.now();
      touchActivity(cwd, taskId);
    }
  };
}

function buildProgressLogger(cwd: string, taskId: string, { echo }: { echo: boolean }) {
  return (update: ProgressUpdate) => {
    const entry = typeof update === 'string' ? { message: update } : update;
    appendTaskLog(cwd, taskId, entry);
    if (echo && entry.message) {
      process.stderr.write(`[coder] ${entry.message}\n`);
    }
  };
}

async function executeCodexTurn(
  cwd: string,
  task: Task,
  { echo }: { echo: boolean },
): Promise<TurnResult> {
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const taskDir = resolveTaskDir(cwd, task.id);
  const config = loadConfig(cwd);
  const onProgress = buildProgressLogger(cwd, task.id, { echo });

  const mode = PERMISSION_MODES[task.permissions ?? 'auto'] ?? PERMISSION_MODES.auto;
  const onApprovalRequest =
    mode.approvalPolicy === 'never'
      ? undefined
      : createApprovalHandler({
          workspaceRoot,
          taskDir,
          mode: mode.approvalMode,
          escalationTimeoutMs: config.approvals.escalationTimeoutMs,
          allowedNetworkHosts: config.approvals.allowedNetworkHosts,
          onEvent: event => {
            appendTaskLog(cwd, task.id, event as TaskLogEntry);
            if (echo && event.message) {
              process.stderr.write(`[coder] ${event.message}\n`);
            }
          },
        });

  // A custom-model alias runs on codex pointed at the user's endpoint; the
  // provider entry travels as per-thread config overrides. Chat-completions
  // endpoints get a per-turn responses->chat bridge in front.
  const configuredEntry = task.model ? config.models?.[task.model] : undefined;
  let customEntry =
    configuredEntry && isEndpointModel(configuredEntry) ? configuredEntry : undefined;
  // `coder model add` writes wireApi (and the resolved base URL) explicitly; a
  // missing field means a hand-written entry, so run the same detection here
  // and save it back so later turns skip the probe. On no answer (endpoint
  // down), fall back to chat for this turn without persisting.
  if (customEntry && !customEntry.wireApi && task.model) {
    const detected = await detectWireApi(customEntry);
    if (detected) {
      customEntry = { ...customEntry, ...detected };
      config.models![task.model] = customEntry;
      persistModelPatch(cwd, task.model, detected);
      appendTaskLog(cwd, task.id, {
        kind: 'info',
        message: `detected wire api for ${task.model}: ${detected.wireApi} @ ${customEntry.baseUrl}`,
      } as TaskLogEntry);
    }
  }
  // Every custom model goes through the loopback bridge: it runs here in the
  // worker, whose env is the caller's, and injects the API key itself.
  // codex's own env_key would resolve inside the shared broker, whose env is
  // frozen from whenever it was first spawned.
  if (customEntry?.envKey && !process.env[customEntry.envKey]) {
    throw new Error(`Missing environment variable: \`${customEntry.envKey}\`.`);
  }
  const bridge = customEntry
    ? await startChatBridge(customEntry, customEntry.wireApi ?? 'chat')
    : null;
  const custom = resolveCustomModel(config, task.model, bridge ?? undefined);
  const mailbox = agentMailboxDir(cwd, task);
  try {
    const result = await runTurn(cwd, {
      prompt: taskPrompt(task),
      outputSchema: task.outputSchema,
      model: custom?.model ?? resolveCodexModel(task.model),
      modelProvider: custom?.modelProvider ?? null,
      // The mailbox path reaches the sandboxed shell per thread, not through the shared app-server's env.
      configOverrides: mailbox
        ? { ...custom?.configOverrides, 'shell_environment_policy.set': { [MAILBOX_ENV]: mailbox } }
        : (custom?.configOverrides ?? null),
      effort: task.effort,
      sandbox: mode.sandbox,
      approvalPolicy: mode.approvalPolicy,
      networkAccess: resolveCodexNetworkAccess(
        task.permissions ?? 'auto',
        config.engines.codex?.network,
      ),
      approvalsReviewer: mode.approvalMode === 'auto' ? 'auto_review' : null,
      mcpServers: resolveMcpServers(task.mcp),
      nativeMcp: task.nativeMcp ?? false,
      // Read-only: the mailbox is the one writable path; extra directories stay read-only.
      writableRoots: [
        ...(mode.sandbox === 'read-only' ? [] : (task.addDirs ?? [])),
        ...(mailbox ? [mailbox] : []),
      ],
      onApprovalRequest,
      onHeartbeat: buildHeartbeat(cwd, task.id),
      resumeThreadId: task.resumeThreadId ?? null,
      onControlReady: (steerEndpoint, threadId, turnId) => {
        writeTask(cwd, task.id, { status: 'running', steerEndpoint, threadId, turnId });
      },
      onProgress: (update: ProgressUpdate) => {
        onProgress(update);
        const threadId = typeof update === 'object' ? update.threadId : null;
        const turnId = typeof update === 'object' ? update.turnId : null;
        if (threadId || turnId) {
          writeTask(cwd, task.id, {
            status: 'running',
            ...(threadId ? { threadId } : {}),
            ...(turnId ? { turnId } : {}),
          });
        }
      },
    });

    writeTask(cwd, task.id, {
      status: result.status === 0 ? 'completed' : 'failed',
      threadId: result.threadId,
      turnId: result.turnId,
      steerEndpoint: null,
      completedAt: new Date().toISOString(),
    });
    recordTurnResult(cwd, task, taskDir, result);
    return result;
  } finally {
    // Clear the owner endpoint after normal completion, client close, or any
    // startup/protocol error. The outer worker catch owns final failure state.
    writeTask(cwd, task.id, { steerEndpoint: null });
    await bridge?.close();
  }
}

async function executeClaudeTurn(
  cwd: string,
  task: Task,
  { echo }: { echo: boolean },
): Promise<TurnResult> {
  const taskDir = resolveTaskDir(cwd, task.id);
  const config = loadConfig(cwd);
  const onProgress = buildProgressLogger(cwd, task.id, { echo });

  const mode = PERMISSION_MODES[task.permissions ?? 'auto'] ?? PERMISSION_MODES.auto;
  const mailbox = agentMailboxDir(cwd, task);
  try {
    const result = await runClaudeTurn(cwd, {
      prompt: taskPrompt(task),
      outputSchema: task.outputSchema,
      model: task.model,
      effort: task.effort,
      permissions: task.permissions,
      approvalTaskId: mode.approvalMode === 'auto' ? task.id : null,
      allowedNetworkHosts: config.approvals.allowedNetworkHosts,
      additionalDirectories: task.addDirs,
      ...(mailbox ? { writableDirectories: [mailbox], env: { [MAILBOX_ENV]: mailbox } } : {}),
      mcpServers: resolveMcpServers(task.mcp),
      nativeMcp: task.nativeMcp ?? false,
      taskRoot: taskDir,
      resumeSessionId: task.resumeThreadId ?? null,
      onHeartbeat: buildHeartbeat(cwd, task.id),
      onSteerReady: steerEndpoint => {
        writeTask(cwd, task.id, { status: 'running', steerEndpoint });
      },
      onProgress: update => {
        onProgress(update);
        if (update.threadId) {
          writeTask(cwd, task.id, { status: 'running', threadId: update.threadId });
        }
      },
    });

    writeTask(cwd, task.id, {
      status: result.status === 0 ? 'completed' : 'failed',
      threadId: result.threadId,
      steerEndpoint: null,
      completedAt: new Date().toISOString(),
    });
    recordTurnResult(cwd, task, taskDir, result);
    return result;
  } finally {
    // Also clear a stale endpoint on spawn/protocol failures. The worker's
    // outer catch owns the final failed status and error log in that case.
    writeTask(cwd, task.id, { steerEndpoint: null });
  }
}

// result.json holds the LATEST turn; results.jsonl accretes every turn so a
// follow-up never displaces the original deliverable (`result --turns`).
function recordTurnResult(cwd: string, task: Task, taskDir: string, result: TurnResult): void {
  writeJsonFileAtomic(path.join(taskDir, 'result.json'), result);
  const entry = {
    at: new Date().toISOString(),
    prompt: task.currentPrompt ?? task.prompt ?? null,
    ...result,
  };
  fs.appendFileSync(path.join(taskDir, 'results.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
}

// The turn executor for a task's engine. Exported so the detached worker can run it.
export function executeTurnFor(task: Task) {
  return task.engine === 'claude' ? executeClaudeTurn : executeCodexTurn;
}

// After a turn completes, run any follow-ups that were queued by `coder task
// steer` while the task was running but could not be injected into the live
// turn (an engine startup/completion race). Each runs as a
// resumed turn on the same thread, in order. A short grace re-check closes the
// race with a steer that lands as the turn is completing; a failed/cancelled
// task is left terminal rather than resumed.
export async function drainSteerQueue(cwd: string, taskId: string): Promise<void> {
  for (let idleChecks = 0; idleChecks < 2;) {
    const current = loadTask(cwd, taskId);
    if (!current || current.status === 'failed' || current.status === 'cancelled') {
      return;
    }
    const followUps = claimSteers(cwd, taskId);
    if (followUps.length === 0) {
      idleChecks += 1;
      await new Promise(resolve => setTimeout(resolve, 300));
      continue;
    }
    idleChecks = 0;
    for (const text of followUps) {
      const resumeTask = writeTask(cwd, taskId, {
        status: 'running',
        currentPrompt: text,
        resumeThreadId: current.threadId ?? null,
      });
      appendTaskLog(cwd, taskId, { message: 'Running steered follow-up.' });
      try {
        await executeTurnFor(resumeTask)(cwd, resumeTask, { echo: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeTask(cwd, taskId, { status: 'failed', error: message });
        appendTaskLog(cwd, taskId, { kind: 'error', message });
        return;
      }
    }
  }
}

/** The detached worker: mark the task running, run its turn and any steered follow-ups; `startMailbox` serves the agent mailbox meanwhile. */
export async function runWorker(
  cwd: string,
  task: Task,
  startMailbox: (cwd: string, task: Task) => () => void,
): Promise<void> {
  if (task.dispatchId && !task.resumedAt) {
    try {
      fs.writeFileSync(path.join(resolveTaskDir(cwd, task.id), `start-${task.dispatchId}`), '', {
        flag: 'wx',
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
  }
  writeTask(cwd, task.id, { status: 'running', pid: process.pid });
  let stopMailbox = () => {};
  let inbox: { close(): Promise<void> } | undefined;
  try {
    stopMailbox = startMailbox(cwd, task);
    if (task.name?.startsWith('agent:')) {
      const { startInboxControl, applyTaskMessage } = await import('../../runner/task');
      inbox = startInboxControl(resolveTaskDir(cwd, task.id), task.name.slice(6), entry =>
        applyTaskMessage(cwd, loadTask(cwd, task.id) ?? task, entry),
      );
    }
    // Dev hook: raise one real pending approval and block on it before the turn,
    // so the escalate -> --wait exit 4 -> `coder task approve` loop can be exercised.
    if (task.simulateApproval) {
      const decision = await probeApproval(resolveTaskDir(cwd, task.id), {
        onEvent: event => appendTaskLog(cwd, task.id, event as TaskLogEntry),
      });
      appendTaskLog(cwd, task.id, { message: `simulated approval: ${decision}` });
      if (decision === 'decline') {
        writeTask(cwd, task.id, {
          status: 'cancelled',
          completedAt: new Date().toISOString(),
          error: 'simulated approval denied',
        });
        return;
      }
    }
    await executeTurnFor(task)(cwd, task, { echo: false });
    // Run any follow-ups steered in while this turn was mid-flight.
    await drainSteerQueue(cwd, task.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeTask(cwd, task.id, { status: 'failed', error: message });
    appendTaskLog(cwd, task.id, { kind: 'error', message });
    throw error;
  } finally {
    stopMailbox();
    await inbox?.close();
  }
}
