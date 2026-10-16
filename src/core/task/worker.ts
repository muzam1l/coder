/** The detached worker's turn engine: one engine turn for a task, then any follow-ups steered in meanwhile. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { processTiming } from '../../utils/process';

import {
  appendTaskLog,
  claimSteers,
  withTaskAdmission,
  LIVE_STEER,
  loadTask,
  resolveTaskDir,
  resolveWorkspaceRoot,
  touchActivity,
  writeTask,
  type TaskLogEntry,
  type TurnResultEntry,
} from '../state';
import { createJsonlTail, writeJsonFileAtomic } from '../../utils/fsx';
import { addTokens, logEntry } from './log-view';
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
import { injectedConnectionEnvironment, redactConnectionSecrets } from '../connections';
import type { Task, ProgressUpdate, TurnResult } from '../types';
import { agentMailboxDir, MAILBOX_ENV } from '../mailbox';
import { gitToolEnvironment, turnToolServers } from '../../agent/mcp';
import { recentExchanges } from '../engines/history';
import { rolloverPrompt, SUMMARY_REQUEST } from '../prompts';

// Agent tasks serve several people in one workspace, so the engine keeps no memories between them.
const AGENT_MEMORY_OFF = {
  claude: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  codex: { 'features.memories': false },
};

type TurnControls = {
  echo: boolean;
  env?: Record<string, string>;
  privateTurn?: boolean;
  steerable?: boolean;
  onResult?: (result: TurnResult) => void;
};

function taskPrompt(task: Task): string {
  // Resumed turns run currentPrompt; task.prompt stays the original task text.
  const prompt = task.currentPrompt ?? task.prompt ?? '';
  if (task.resumeThreadId || !task.pendingRollover) return prompt;

  return rolloverPrompt(task.pendingRollover, prompt);
}

export async function runConversationTurn(
  cwd: string,
  task: Task,
  budget: number,
  execute: (
    task: Task,
    options: Pick<TurnControls, 'privateTurn' | 'steerable' | 'onResult'>,
  ) => Promise<TurnResult>,
): Promise<TurnResult> {
  const switching = Boolean(task.pendingRollover);
  writeTask(cwd, task.id, {
    status: 'running',
    steerEndpoint: null,
    turnId: null,
    turnUsage: task.turnUsage ?? [],
  });
  const taskDir = resolveTaskDir(cwd, task.id);
  const log = path.join(taskDir, 'log.jsonl');
  const logged = createJsonlTail(log, fs.existsSync(log) ? fs.statSync(log).size : 0);
  const current = switching ? { ...task, resumeThreadId: null } : task;
  let recordedAt: string | undefined;
  const record = (result: TurnResult) => {
    const entries = logged().flatMap(line => {
      const entry = logEntry(line);
      return entry ? [entry] : [];
    });
    const steers = entries.flatMap(entry =>
      entry.message?.startsWith(LIVE_STEER) ? [entry.message.slice(LIVE_STEER.length)] : [],
    );
    const lastReply = entries.filter(entry => entry.kind === 'reply').at(-1)?.message;
    processTiming('worker.record.start', { taskId: task.id, finalized: false });
    return recordTurnResult(cwd, task, result, { steers, lastReply });
  };
  let result: TurnResult;
  try {
    // The new conversation's first turn is a normal turn, steerable only once it succeeds.
    result = await execute(current, {
      privateTurn: false,
      steerable: !switching,
      onResult: result => {
        if (!recordedAt && result.status === 0 && !result.error) recordedAt = record(result);
      },
    });
  } catch (error) {
    if (switching)
      writeTask(cwd, task.id, {
        threadId: task.threadId,
        resumeThreadId: task.threadId,
        steerEndpoint: null,
      });
    throw error;
  }
  if (result.status !== 0 && switching) result = { ...result, threadId: task.threadId ?? null };
  const previousThreadIds = [...(task.previousThreadIds ?? [])];
  if (
    result.status === 0 &&
    task.threadId &&
    result.threadId &&
    task.threadId !== result.threadId &&
    !previousThreadIds.includes(task.threadId)
  )
    previousThreadIds.push(task.threadId);
  const rollingOver =
    result.status === 0 && Boolean(result.threadId) && Number(result.contextTokens) > budget;
  const completedAt = new Date().toISOString();
  processTiming('worker.engine.closed', { taskId: task.id });
  recordedAt ??= record(result);
  writeJsonFileAtomic(
    path.join(taskDir, 'result.json'),
    JSON.parse(redactConnectionSecrets(result)),
  );
  processTiming('worker.record.start', { taskId: task.id, finalized: true });
  const active = writeTask(cwd, task.id, {
    turnUsage: [
      ...(loadTask(cwd, task.id)?.turnUsage ?? []),
      { at: recordedAt, tokens: result.tokens, model: result.model },
    ],
    status: result.status === 0 ? 'completed' : 'failed',
    completedAt,
    rollingOver,
    ...(rollingOver ? { pid: process.pid } : {}),
    threadId: result.threadId,
    resumeThreadId: result.threadId,
    previousThreadIds,
    ...(result.status === 0 ? { pendingRollover: undefined } : {}),
    steerEndpoint: null,
    turnId: result.turnId ?? null,
  });
  processTiming('worker.result.recorded', { taskId: task.id, finalized: true });
  if (switching && result.status === 0)
    appendTaskLog(cwd, task.id, {
      kind: 'status',
      message: `Context rolled over: summary plus the last ${task.pendingRollover!.exchanges} exchanges`,
    });
  if (!rollingOver) return result;

  try {
    const recent = await recentExchanges(active);
    const summary = await execute(
      { ...active, currentPrompt: SUMMARY_REQUEST, outputSchema: undefined },
      { privateTurn: true },
    );
    if (!loadTask(cwd, task.id)) return result;
    if (summary.tokens) {
      const at = new Date(Math.max(Date.now(), Date.parse(recordedAt) + 1)).toISOString();
      writeTask(cwd, task.id, {
        turnUsage: [
          ...(loadTask(cwd, task.id)?.turnUsage ?? []),
          { at, tokens: summary.tokens, model: summary.model },
        ],
      });
      result = {
        ...result,
        tokens: addTokens(result.tokens ?? null, summary.tokens),
      };
      writeJsonFileAtomic(
        path.join(taskDir, 'result.json'),
        JSON.parse(redactConnectionSecrets(result)),
      );
    }
    if (summary.status !== 0 || !summary.finalMessage?.trim())
      throw new Error(summary.error?.message ?? 'Summary turn returned no summary');
    if (Buffer.byteLength(summary.finalMessage) > 64_000)
      throw new Error('Summary exceeded the context budget');
    if (loadTask(cwd, task.id)?.status === 'cancelled') return result;
    writeTask(cwd, task.id, {
      pendingRollover: {
        summary: summary.finalMessage,
        recent: recent.text,
        exchanges: recent.exchanges,
      },
    });
  } catch (error) {
    appendTaskLog(cwd, task.id, {
      kind: 'warning',
      message: `Context rollover deferred: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    if (loadTask(cwd, task.id)) writeTask(cwd, task.id, { rollingOver: false });
  }

  return result;
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
  const log = (update: ProgressUpdate) => {
    const entry = JSON.parse(
      redactConnectionSecrets(typeof update === 'string' ? { message: update } : update),
    );
    appendTaskLog(cwd, taskId, entry);
    if (echo && entry.message) {
      process.stderr.write(`[coder] ${entry.message}\n`);
    }
  };
  for (const name of Object.keys(injectedConnectionEnvironment()))
    if (process.env[name] !== undefined)
      log({
        kind: 'warning',
        message: `${name} is temporarily unavailable; skipped for this task.`,
      });

  return log;
}

async function executeCodexTurn(
  cwd: string,
  task: Task,
  { echo, env = {}, privateTurn = false, steerable = !privateTurn, onResult }: TurnControls,
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
          onEvent: event => onProgress(event as TaskLogEntry),
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
      availabilityChecked: process.env.CODER_ENGINE_CHECKED === '1',
      prompt: taskPrompt(task),
      developerInstructions: task.systemPrompt,
      outputSchema: task.outputSchema,
      model: custom?.model ?? resolveCodexModel(task.model),
      modelProvider: custom?.modelProvider ?? null,
      // The mailbox path reaches the sandboxed shell per thread, not through the shared app-server's env.
      configOverrides: {
        ...custom?.configOverrides,
        ...(mailbox || Object.keys(env).length
          ? {
              'shell_environment_policy.set': {
                ...env,
                ...(mailbox ? { [MAILBOX_ENV]: mailbox } : {}),
              },
            }
          : {}),
        ...(task.agentId ? AGENT_MEMORY_OFF.codex : {}),
      },
      effort: task.effort,
      sandbox: mode.sandbox,
      approvalPolicy: mode.approvalPolicy,
      networkAccess: resolveCodexNetworkAccess(
        task.permissions ?? 'auto',
        config.engines.codex?.network,
      ),
      approvalsReviewer: mode.approvalMode === 'auto' ? 'auto_review' : null,
      mcpServers: turnToolServers(
        task,
        taskDir,
        resolveMcpServers(task.mcp, process.env, undefined, {
          onWarning: message => onProgress({ kind: 'warning', message }),
        }),
      ),
      nativeMcp: task.nativeMcp ?? false,
      // Read-only: the mailbox is the one writable path; extra directories stay read-only.
      writableRoots: [
        ...(mode.sandbox === 'read-only' ? [] : (task.addDirs ?? [])),
        ...(mailbox ? [mailbox] : []),
      ],
      onApprovalRequest,
      onHeartbeat: buildHeartbeat(cwd, task.id),
      onResult,
      resumeThreadId: task.resumeThreadId ?? null,
      onControlReady: steerable
        ? (steerEndpoint, threadId, turnId) => {
            writeTask(cwd, task.id, { status: 'running', steerEndpoint, threadId, turnId });
          }
        : undefined,
      onProgress: (update: ProgressUpdate) => {
        if (privateTurn) return;
        onProgress(update);
        if (!steerable) return;
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
  { echo, env = {}, privateTurn = false, steerable = !privateTurn, onResult }: TurnControls,
): Promise<TurnResult> {
  const taskDir = resolveTaskDir(cwd, task.id);
  const config = loadConfig(cwd);
  const onProgress = buildProgressLogger(cwd, task.id, { echo });

  const mode = PERMISSION_MODES[task.permissions ?? 'auto'] ?? PERMISSION_MODES.auto;
  const mailbox = agentMailboxDir(cwd, task);
  try {
    const result = await runClaudeTurn(cwd, {
      env: {
        ...env,
        ...(mailbox ? { [MAILBOX_ENV]: mailbox } : {}),
        ...(task.agentId ? AGENT_MEMORY_OFF.claude : {}),
      },
      prompt: taskPrompt(task),
      systemPrompt: task.systemPrompt,
      excludeDynamicSections: task.conversation,
      settingSources:
        task.agentId && task.source && !['cli', 'dashboard', 'schedule'].includes(task.source)
          ? 'project,local'
          : undefined,
      outputSchema: task.outputSchema,
      model: task.model,
      effort: task.effort,
      permissions: task.permissions,
      approvalTaskId: mode.approvalMode === 'auto' ? task.id : null,
      allowedNetworkHosts: config.approvals.allowedNetworkHosts,
      additionalDirectories: task.addDirs,
      ...(mailbox ? { writableDirectories: [mailbox] } : {}),
      mcpServers: turnToolServers(
        task,
        taskDir,
        resolveMcpServers(task.mcp, process.env, undefined, {
          onWarning: message => onProgress({ kind: 'warning', message }),
        }),
      ),
      nativeMcp: task.nativeMcp ?? false,
      promptCacheTtl:
        task.conversation && (env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)
          ? '1h'
          : undefined,
      taskRoot: taskDir,
      resumeSessionId: task.resumeThreadId ?? null,
      onHeartbeat: buildHeartbeat(cwd, task.id),
      onResult,
      onSteerReady: steerable
        ? steerEndpoint => {
            writeTask(cwd, task.id, { status: 'running', steerEndpoint });
          }
        : undefined,
      onProgress: update => {
        if (privateTurn) return;
        onProgress(update);
        if (steerable && update.threadId) {
          writeTask(cwd, task.id, { status: 'running', threadId: update.threadId });
        }
      },
    });

    return result;
  } finally {
    // Also clear a stale endpoint on spawn/protocol failures. The worker's
    // outer catch owns the final failed status and error log in that case.
    writeTask(cwd, task.id, { steerEndpoint: null });
  }
}

// result.json holds the LATEST turn; results.jsonl accretes every turn so a
// follow-up never displaces the original deliverable (`result --turns`).
function recordTurnResult(
  cwd: string,
  task: Task,
  result: TurnResult,
  metadata: Pick<TurnResultEntry, 'steers' | 'lastReply'> = {},
): string {
  const { steers = [], lastReply } = metadata;
  const after = task.turnUsage?.at(-1)?.at;
  const taskDir = resolveTaskDir(cwd, task.id);
  writeJsonFileAtomic(
    path.join(taskDir, 'result.json'),
    JSON.parse(redactConnectionSecrets(result)),
  );
  const entry = {
    at: new Date(Math.max(Date.now(), after ? Date.parse(after) + 1 : 0)).toISOString(),
    prompt: task.currentPrompt ?? task.prompt ?? null,
    ...(steers.length ? { steers } : {}),
    ...(lastReply ? { lastReply } : {}),
    ...result,
  };
  fs.appendFileSync(
    path.join(taskDir, 'results.jsonl'),
    `${redactConnectionSecrets(entry)}\n`,
    'utf8',
  );

  processTiming('worker.result.recorded', { taskId: task.id, finalized: false });
  if (process.connected) process.send?.('result');
  return entry.at;
}

// The turn executor for a task's engine. Exported so the detached worker can run it.
export function executeTurnFor(task: Task) {
  return async (cwd: string, current: Task, options: { echo: boolean }) => {
    const git = await gitToolEnvironment(
      resolveMcpServers(current.mcp, process.env, undefined, {
        onWarning: () => {},
      }),
    );
    try {
      const execute = current.engine === 'claude' ? executeClaudeTurn : executeCodexTurn;

      return await runConversationTurn(
        cwd,
        current,
        current.conversation ? loadConfig(cwd).conversationCompactTokens : Infinity,
        (next, controls) => execute(cwd, next, { ...options, ...controls, env: git.env }),
      );
    } finally {
      await git.close();
    }
  };
}

// Close admission and claim the last queued follow-ups under the same fence as steer callers.
export async function drainSteerQueue(cwd: string, taskId: string): Promise<void> {
  for (;;) {
    const followUps = await withTaskAdmission(cwd, taskId, () => {
      const current = loadTask(cwd, taskId);
      if (!current) return [];
      const queued =
        current.status === 'failed' || current.status === 'cancelled'
          ? []
          : claimSteers(cwd, taskId);
      if (!queued.length) {
        writeTask(cwd, taskId, { steerClosed: true, steerEndpoint: null });
        if (process.connected) process.send?.('settled');
      }
      return queued;
    });
    if (!followUps.length) return;
    for (const text of followUps) {
      const resumeTask = writeTask(cwd, taskId, {
        status: 'running',
        currentPrompt: text,
        resumeThreadId: loadTask(cwd, taskId)?.threadId ?? null,
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
  writeTask(cwd, task.id, { status: 'running', pid: process.pid, steerClosed: false });
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
    await withTaskAdmission(cwd, task.id, () => {
      if (loadTask(cwd, task.id)?.pid === process.pid) {
        writeTask(cwd, task.id, { steerClosed: true, steerEndpoint: null });
        if (process.connected) process.send?.('settled');
      }
    });
    stopMailbox();
    await inbox?.close();
  }
}
