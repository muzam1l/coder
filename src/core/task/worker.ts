/** The detached worker's turn engine: one engine turn for a task, then any follow-ups steered in meanwhile. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { processTiming } from '../../utils/process';

import {
  appendTaskLog,
  claimSteers,
  clearPendingSteers,
  withTaskAdmission,
  LIVE_STEER,
  loadTask,
  resolveTaskDir,
  scratchDir,
  touchActivity,
  writeTask,
  type TaskLogEntry,
  type TurnResultEntry,
} from '../state';
import { createJsonlTail, writeJsonFileAtomic } from '../../utils/fsx';
import { logEntry } from './view';
import { runTurn } from '../engines/codex';
import { runClaudeTurn } from '../engines/claude';
import { SIMULATE_APPROVAL_ENV, codexApprovalHandler, escalate } from '../approvals';
import {
  ACCESS_MODES,
  isEndpointModel,
  loadConfig,
  persistModelPatch,
  codexTurnNetwork,
  turnHosts,
  resolveCodexModel,
  strictestAccess,
} from '../config';
import { detectWireApi } from '../models';
import { resolveMcpServers } from '../dispatch';
import { injectedConnectionEnvironment, redactConnectionSecrets } from '../connection-env';
import type { Task, ProgressUpdate, TurnResult } from '../types';
import { gitToolEnvironment } from '../../agent/mcp';
import { turnToolServers } from './mcp';
import { taskSystemPrompt, type SystemPromptParts } from './context/system';
import { serverScope } from '../tool-search/context';

// Agent tasks serve several people in one workspace, so the engine keeps no memories between them.
const AGENT_MEMORY_OFF = {
  claude: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  codex: { 'features.memories': false },
};

type TurnControls = {
  echo: boolean;
  env?: Record<string, string>;
  onResult?: (result: TurnResult) => void;
};

/** A turn's MCP servers and the system prompt that lists them. */
async function turnTools(
  cwd: string,
  task: Task,
  onProgress: (update: ProgressUpdate) => void,
  parts: Partial<SystemPromptParts> = {},
) {
  const onWarning = (message: string) =>
    onProgress({ kind: 'warning', phase: 'starting', message });
  const access = strictestAccess(task.access, task.promptParts?.access);
  const tools = await turnToolServers(
    task,
    resolveTaskDir(cwd, task.id),
    resolveMcpServers(task.mcp, process.env, undefined, { onWarning }),
    { access },
  );
  if (tools.listed.length)
    onProgress({
      kind: 'status',
      phase: 'starting',
      message: `This turn's servers are ${tools.listed.map(server => server.name).join(', ')}.`,
    });
  const systemPrompt = task.promptParts
    ? taskSystemPrompt({
        ...task.promptParts,
        ...parts,
        access,
        connections: tools.listed.some(server => serverScope(server)),
      })
    : task.systemPrompt;

  return { ...tools, systemPrompt };
}

/** Tells the parent, if it still listens; a parent that left meanwhile is no error. */
function notifyParent(message: 'result' | 'settled') {
  if (!process.connected) return;
  process.send?.(message, undefined, undefined, error => {
    if (error && (error as NodeJS.ErrnoException).code !== 'EPIPE')
      process.stderr.write(`coder worker: ${error.message}\n`);
  });
}

function taskPrompt(task: Task): string {
  // Resumed turns run currentPrompt; task.prompt stays the original task text.
  return task.currentPrompt ?? task.prompt ?? '';
}

export async function runConversationTurn(
  cwd: string,
  task: Task,
  execute: (task: Task, options: Pick<TurnControls, 'onResult'>) => Promise<TurnResult>,
): Promise<TurnResult> {
  writeTask(cwd, task.id, {
    status: 'running',
    steerEndpoint: null,
    turnId: null,
    turnUsage: task.turnUsage ?? [],
  });
  const taskDir = resolveTaskDir(cwd, task.id);
  const log = path.join(taskDir, 'log.jsonl');
  const logged = createJsonlTail(log, fs.existsSync(log) ? fs.statSync(log).size : 0);
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
  const result = await execute(task, {
    onResult: result => {
      if (!recordedAt && result.status === 0 && !result.error) recordedAt = record(result);
    },
  });
  const previousThreadIds = [...(task.previousThreadIds ?? [])];
  if (
    result.status === 0 &&
    task.threadId &&
    result.threadId &&
    task.threadId !== result.threadId &&
    !previousThreadIds.includes(task.threadId)
  )
    previousThreadIds.push(task.threadId);
  const completedAt = new Date().toISOString();
  processTiming('worker.engine.closed', { taskId: task.id });
  recordedAt ??= record(result);
  writeJsonFileAtomic(
    path.join(taskDir, 'result.json'),
    JSON.parse(redactConnectionSecrets(result)),
  );
  processTiming('worker.record.start', { taskId: task.id, finalized: true });
  writeTask(cwd, task.id, {
    turnUsage: [
      ...(loadTask(cwd, task.id)?.turnUsage ?? []),
      { at: recordedAt, tokens: result.tokens, model: result.model },
    ],
    status: result.status === 0 ? 'completed' : 'failed',
    completedAt,
    threadId: result.threadId,
    resumeThreadId: result.threadId,
    previousThreadIds,
    steerEndpoint: null,
    turnId: result.turnId ?? null,
  });
  processTiming('worker.result.recorded', { taskId: task.id, finalized: true });

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
  { echo, env = {}, onResult }: TurnControls,
): Promise<TurnResult> {
  const config = loadConfig(cwd);
  const onProgress = buildProgressLogger(cwd, task.id, { echo });

  // A custom-model alias runs on codex through the app-server's bridge to the
  // user's endpoint; the provider entry travels as per-thread config overrides.
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

  const mode = ACCESS_MODES[task.access ?? 'auto'] ?? ACCESS_MODES.auto;
  const auto = mode.approvalMode === 'auto';
  const hosts = turnHosts(task.access ?? 'auto', config.network);
  const network = codexTurnNetwork(task.access ?? 'auto', hosts);
  // Auto review answers Codex's approval requests; one that still reaches Coder is declined.
  const approvals = {
    approvalPolicy: mode.approvalPolicy,
    approvalsReviewer: mode.approvalsReviewer,
    ...(auto
      ? { onApprovalRequest: codexApprovalHandler(event => onProgress(event as TaskLogEntry)) }
      : {}),
  };
  const tools = await turnTools(cwd, task, onProgress);
  try {
    const result = await runTurn(cwd, {
      availabilityChecked: process.env.CODER_ENGINE_CHECKED === '1',
      prompt: taskPrompt(task),
      developerInstructions: tools.systemPrompt,
      outputSchema: task.outputSchema,
      model: resolveCodexModel(task.model),
      ...(customEntry && task.model
        ? { customModel: { alias: task.model, entry: customEntry } }
        : {}),
      // The env reaches the sandboxed shell per thread, not through the shared app-server's env.
      configOverrides: {
        ...(Object.keys(env).length ? { 'shell_environment_policy.set': env } : {}),
        ...(task.agentId ? AGENT_MEMORY_OFF.codex : {}),
        ...network.configOverrides,
      },
      effort: task.effort,
      sandbox: mode.sandbox,
      ...approvals,
      networkAccess: network.networkAccess,
      mcpServers: tools.servers,
      nativeMcp: task.nativeMcp ?? false,
      // Read-only: extra directories stay read-only, and there is no scratch to write.
      writableRoots:
        mode.sandbox === 'read-only' ? [] : [...(task.addDirs ?? []), scratchDir(task.id)],
      onHeartbeat: buildHeartbeat(cwd, task.id),
      onResult,
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

    return result;
  } finally {
    // Clear the owner endpoint after normal completion, client close, or any
    // startup/protocol error. The outer worker catch owns final failure state.
    writeTask(cwd, task.id, { steerEndpoint: null });
  }
}

async function executeClaudeTurn(
  cwd: string,
  task: Task,
  { echo, env = {}, onResult }: TurnControls,
): Promise<TurnResult> {
  const taskDir = resolveTaskDir(cwd, task.id);
  const config = loadConfig(cwd);
  const onProgress = buildProgressLogger(cwd, task.id, { echo });
  const mode = ACCESS_MODES[task.access ?? 'auto'] ?? ACCESS_MODES.auto;
  const tools = await turnTools(cwd, task, onProgress, {
    declareHosts: mode.approvalMode === 'auto',
  });
  try {
    const result = await runClaudeTurn(cwd, {
      env: {
        ...env,
        ...(task.agentId ? AGENT_MEMORY_OFF.claude : {}),
      },
      prompt: taskPrompt(task),
      systemPrompt: tools.systemPrompt,
      excludeDynamicSections: task.conversation,
      settingSources:
        task.agentId && task.source && !['cli', 'dashboard', 'schedule'].includes(task.source)
          ? 'project,local'
          : undefined,
      outputSchema: task.outputSchema,
      model: task.model,
      effort: task.effort,
      access: task.access,
      approvalTaskId: task.id,
      allowedNetworkHosts: turnHosts(task.access ?? 'auto', config.network),
      additionalDirectories: task.addDirs,
      scratch: scratchDir(task.id),
      local: task.promptParts?.local ?? true,
      mcpServers: tools.servers,
      nativeMcp: task.nativeMcp ?? false,
      promptCacheTtl:
        task.conversation && (env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)
          ? '1h'
          : undefined,
      taskRoot: taskDir,
      resumeSessionId: task.resumeThreadId ?? null,
      onHeartbeat: buildHeartbeat(cwd, task.id),
      onResult,
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
  notifyParent('result');
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
    const writes = current.access !== 'read-only';
    const env = { ...git.env, ...(writes ? scratchEnvironment(current) : {}) };
    try {
      const execute = current.engine === 'claude' ? executeClaudeTurn : executeCodexTurn;

      return await runConversationTurn(cwd, current, (next, controls) =>
        execute(cwd, next, { ...options, ...controls, env }),
      );
    } finally {
      await git.close();
    }
  };
}

/** Temp files and package caches land in the task's scratch: the temp roots and the home caches are not writable in the sandbox. */
export function scratchEnvironment(task: Pick<Task, 'id' | 'engine'>): Record<string, string> {
  const scratch = scratchDir(task.id);

  return {
    TMPDIR: scratch,
    BUN_TMPDIR: scratch,
    BUN_INSTALL_CACHE_DIR: path.join(scratch, '.bun-cache'),
    npm_config_cache: path.join(scratch, '.npm-cache'),
    PIP_CACHE_DIR: path.join(scratch, '.pip-cache'),
    UV_CACHE_DIR: path.join(scratch, '.uv-cache'),
    CARGO_HOME: path.join(scratch, '.cargo'),
    GOPATH: path.join(scratch, 'go'),
    GOCACHE: path.join(scratch, '.go-cache'),
    ...(task.engine === 'claude' ? { CLAUDE_CODE_TMPDIR: scratch } : {}),
  };
}

/** A runner task's follow-up turn takes the connections its server resolves for it now. */
async function followUpServers(task: Task): Promise<Pick<Task, 'mcp' | 'mcpBindings'>> {
  if (process.env.CODER_MCP_MODE !== 'cloud' || !task.name?.startsWith('agent:')) return {};
  const [{ liveConnections }, { turnServers }] = await Promise.all([
    import('../../runner/task'),
    import('./actions'),
  ]);
  const connected = await liveConnections(task)(task.connections ?? []);
  for (const name of Object.keys(process.env))
    if (name.startsWith('CODER_CONNECTION_')) delete process.env[name];
  Object.assign(process.env, connected.env);
  const { selected, bindings } = turnServers(task, connected.mcp);

  return { mcp: selected.mcp, mcpBindings: bindings };
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
        clearPendingSteers(cwd, taskId);
        writeTask(cwd, taskId, { steerClosed: true, steerEndpoint: null });
        notifyParent('settled');
      }
      return queued;
    });
    if (!followUps.length) return;
    for (const text of followUps) {
      try {
        const current = loadTask(cwd, taskId);
        const resumeTask = writeTask(cwd, taskId, {
          status: 'running',
          currentPrompt: text,
          resumedAt: new Date().toISOString(),
          error: undefined,
          resumeThreadId: current?.threadId ?? null,
          ...(current ? await followUpServers(current) : {}),
        });
        appendTaskLog(cwd, taskId, { message: 'Running steered follow-up.' });
        await executeTurnFor(resumeTask)(cwd, resumeTask, { echo: false });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        writeTask(cwd, taskId, {
          status: 'failed',
          error: message,
          completedAt: new Date().toISOString(),
        });
        appendTaskLog(cwd, taskId, { kind: 'error', message });
        return;
      }
    }
  }
}

/** The detached worker: mark the task running, run its turn and any steered follow-ups. */
export async function runWorker(cwd: string, task: Task): Promise<void> {
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
  let inbox: { close(): Promise<void> } | undefined;
  try {
    if (task.name?.startsWith('agent:')) {
      const { startInboxControl, applyTaskMessage } = await import('../../runner/task');
      inbox = startInboxControl(resolveTaskDir(cwd, task.id), task.name.slice(6), entry =>
        applyTaskMessage(cwd, loadTask(cwd, task.id) ?? task, entry),
      );
    }
    if (process.env[SIMULATE_APPROVAL_ENV] === '1' && !task.resumedAt)
      escalate(cwd, task.id, resolveTaskDir(cwd, task.id), {
        reason: `A dev hook (${SIMULATE_APPROVAL_ENV}) raised this escalation at the start of the task.`,
        actions: ['echo simulated'],
      });
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
        notifyParent('settled');
      }
    });
    await inbox?.close();
  }
}
