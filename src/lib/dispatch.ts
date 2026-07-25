/**
 * Exit-free, print-free task dispatch core shared by the CLI and the SDK.
 * Failures surface as the typed errors below; the CLI maps them to exit codes.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import {
  findJob,
  generateJobId,
  readJob,
  readJobLog,
  resolveJobDir,
  writeJob,
  type JobLogEntry,
} from './state.js';
import { readJsonFile } from './fsx.js';
import { waitForTaskAttention } from './wait.js';
import { getCodexAvailability } from './codex-core.js';
import { getClaudeAvailability } from './claude-core.js';
import { ensureCodexInstalled } from './plugins.js';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CLAUDE_SANDBOX_UNAVAILABLE_PATTERN,
  CODEX_EFFORTS,
  CODEX_MODELS,
  PERMISSION_MODES,
  assertModelEnabled,
  isAliasModel,
  isEndpointModel,
  loadConfig,
  parseAgentSpec,
} from './config.js';
import { CLI_PATH } from './runtime.js';
import type {
  Agent,
  CoderConfig,
  Effort,
  Engine,
  Job,
  JobStatus,
  ResolvedTaskOptions,
  TurnResult,
} from './types.js';

const STARTUP_ERROR_PATTERN =
  /usage|quota|rate.?limit|429|401|unauthorized|not authenticated|login|insufficient|exhausted|not available|ENOENT/i;

// Marks a worker's whole process tree (engine, agent shell) so task-creating
// commands can refuse nested dispatch.
export const WORKER_ENV = 'CODER_WORKER';

/** The run-native-subagent fallback payload the CLI prints on exit 3. */
export interface FallbackPayload {
  error: string;
  fallback: {
    action: 'run-native-subagent';
    reason: 'no-engine-available';
    permissions: string;
    note: string;
    system?: string;
    task: string;
  };
}

// ---------------------------------------------------------------------------
// Typed errors
// ---------------------------------------------------------------------------

/**
 * Any coder operation that fails in a way the caller can act on throws a
 * CoderError; `code` says why. The CLI maps codes to exit codes (chain-exhausted
 * -> 3, approval-pending -> 4, the rest -> 1).
 */
export type CoderErrorCode =
  | 'nested-dispatch'
  | 'invalid-option'
  | 'read-only-unavailable'
  | 'startup-failed'
  | 'chain-exhausted'
  | 'approval-pending'
  | 'task-failed'
  | 'flow-failed';

export class CoderError extends Error {
  code: CoderErrorCode;
  hint?: string | string[];
  taskId?: string;
  /** chain-exhausted: the run-native-subagent payload the CLI prints on exit 3. */
  payload?: FallbackPayload;
  /** approval-pending: the approval to answer. */
  approval?: { id: string; summary: string };
  /** task-failed (flow task()): the failed task's result. */
  result?: unknown;
  /** flow-failed: the run to resume. */
  runId?: string;
  constructor(
    code: CoderErrorCode,
    message: string,
    extra: {
      hint?: string | string[];
      taskId?: string;
      payload?: FallbackPayload;
      approval?: { id: string; summary: string };
      result?: unknown;
      runId?: string;
    } = {},
  ) {
    super(message);
    this.name = 'CoderError';
    this.code = code;
    Object.assign(this, extra);
  }
}


// Internal signal: this engine could not start; fall through the chain.
class FallbackSignal extends Error {
  agent: Agent;
  detail: string;
  constructor(agent: Agent, detail: string) {
    super(detail);
    this.agent = agent;
    this.detail = detail;
  }
}

// ---------------------------------------------------------------------------
// Option resolution (throwing variant, moved out of cmd/task.ts)
// ---------------------------------------------------------------------------

export function resolveTaskOptions(
  options: Record<string, any>,
  config: CoderConfig,
): ResolvedTaskOptions {
  // A bare model implies its agent: opus/sonnet/fable -> claude,
  // spark/luna/terra/sol -> codex, a configured custom-model name -> custom.
  // Explicit --agent always wins; unknown/raw slugs keep the chain default.
  let agent = options.agent;
  const explicitAgent = Boolean(agent);
  let modelInput = options.model as string | undefined;
  let effortInput = options.effort as Effort | undefined;
  const aliasEntry = (name: string | null | undefined) => {
    const entry = name ? config.models?.[name] : undefined;
    return entry && isAliasModel(entry) ? entry : undefined;
  };
  const endpointEntry = (name: string | null | undefined) => {
    const entry = name ? config.models?.[name] : undefined;
    return entry && isEndpointModel(entry) ? entry : undefined;
  };
  if (aliasEntry(modelInput)) {
    let parsed: ReturnType<typeof parseAgentSpec>;
    try {
      parsed = parseAgentSpec(modelInput, config);
    } catch (error) {
      throw new CoderError('invalid-option', error instanceof Error ? error.message : String(error));
    }
    if (parsed) {
      if (!explicitAgent) {
        agent = parsed.agent;
      }
      modelInput = parsed.model ?? undefined;
      effortInput = effortInput ?? parsed.effort ?? undefined;
    }
  }
  if (!agent && modelInput) {
    if (modelInput in CLAUDE_MODELS) {
      agent = 'claude';
    } else if (modelInput in CODEX_MODELS) {
      agent = 'codex';
    } else if (endpointEntry(modelInput)) {
      agent = 'custom';
    }
  }
  agent = agent ?? config.chain[0] ?? 'codex';
  if (agent !== 'codex' && agent !== 'claude' && agent !== 'custom') {
    const hint =
      agent in CODEX_MODELS || agent in CLAUDE_MODELS || agent in (config.models ?? {})
        ? ` "${agent}" is a model; use --model ${agent}.`
        : '';
    throw new CoderError('invalid-option', `Invalid --agent "${agent}". Use codex, claude, or custom.${hint}`);
  }
  const agentDefaults = config.agents[agent as Agent] ?? {};
  let model = modelInput ?? agentDefaults.model ?? null;
  let effort = effortInput ?? agentDefaults.effort ?? null;
  if (aliasEntry(model)) {
    let parsed: ReturnType<typeof parseAgentSpec>;
    try {
      parsed = parseAgentSpec(model, config);
    } catch (error) {
      throw new CoderError('invalid-option', error instanceof Error ? error.message : String(error));
    }
    if (parsed) {
      if (!explicitAgent) {
        agent = parsed.agent;
      }
      model = parsed.model;
      effort = effortInput ?? parsed.effort ?? effort;
    }
  }
  const permissions = options.permissions ?? agentDefaults.permissions ?? 'auto';

  // A disabled built-in alias must never reach an engine.
  try {
    assertModelEnabled(config, model);
  } catch (error) {
    throw new CoderError('invalid-option', error instanceof Error ? error.message : String(error));
  }

  // The custom agent groups the user's configured (OpenAI-compatible) models;
  // the model must be a config entry, so typos fail here with the configured
  // names instead of reaching an engine.
  if (agent === 'custom') {
    const names = Object.entries(config.models ?? {})
      .filter(([, entry]) => isEndpointModel(entry))
      .map(([name]) => name);
    if (!model && names.length === 1) {
      model = names[0]!;
    }
    if (!model || !endpointEntry(model)) {
      throw new CoderError(
      'invalid-option',
        model
          ? `No custom model named "${model}". Configured: ${names.join(', ') || 'none'}.`
          : 'No custom model to run: pass --model <name> or set agents.custom.model.',
        { hint: 'Add one: coder model add <name> --base-url <url> --model <id>' },
      );
    }
  }
  const engine: Engine = agent === 'claude' ? 'claude' : 'codex';

  if (!(permissions in PERMISSION_MODES)) {
    throw new CoderError(
      'invalid-option',
      `Invalid --permissions "${permissions}". Use one of: ${Object.keys(PERMISSION_MODES).join(', ')}`,
    );
  }
  if (engine === 'codex' && effort && !CODEX_EFFORTS.has(effort)) {
    throw new CoderError(
      'invalid-option',
      `Invalid codex --effort "${effort}". Use one of: ${[...CODEX_EFFORTS].join(', ')}`,
    );
  }
  if (engine === 'claude' && effort && !CLAUDE_EFFORTS.has(effort)) {
    throw new CoderError(
      'invalid-option',
      `Invalid claude --effort "${effort}". Use one of: ${[...CLAUDE_EFFORTS].join(', ')}`,
    );
  }

  return { engine, agent, model, effort, permissions };
}

function isSandboxFailure(permissions: string, detail: string): boolean {
  return permissions === 'read-only' && CLAUDE_SANDBOX_UNAVAILABLE_PATTERN.test(detail ?? '');
}

// ---------------------------------------------------------------------------
// dispatchTask
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  prompt: string;
  cwd: string;
  agent?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  name?: string | null;
  system?: string | null;
  resume?: string;
  wait?: boolean;
  simulateApproval?: boolean;
  /** Tags the created job as belonging to a flow run (for `coder list` grouping). */
  flowRunId?: string;
  /** Called with (engine, detail, next) when an engine falls through the chain. */
  onFallback?: (info: { agent: Agent; detail: string; next: Agent }) => void;
  /** Called with a note when a missing codex binary is installed on the spot. */
  onInstallNote?: (note: string) => void;
}

export interface DispatchResult {
  taskId: string;
  job: Job;
  /** The agent the task actually started on (may differ after a fallback). */
  agent: Agent;
  /** 'passed' once a live thread is observed, else 'pending'. */
  startupCheck: 'passed' | 'pending';
}

// One attempt on one engine: availability gate, job create, spawn, startup wait.
async function attemptOnce(
  config: CoderConfig,
  resolved: ResolvedTaskOptions,
  opts: DispatchOptions,
  jobExtras: { name?: string | null; resume?: string; simulateApproval?: boolean },
): Promise<DispatchResult> {
  const cwd = opts.cwd;

  // Startup gate: cheap checks before creating a job.
  let availability =
    resolved.engine === 'codex' ? getCodexAvailability(cwd) : getClaudeAvailability();
  const resolvedEntry = resolved.model ? config.models?.[resolved.model] : undefined;
  if (!availability.available && resolvedEntry && isEndpointModel(resolvedEntry)) {
    const install = ensureCodexInstalled(availability);
    opts.onInstallNote?.(install!.note);
    availability = getCodexAvailability(cwd);
  }
  if (!availability.available) {
    throw new FallbackSignal(resolved.agent, availability.detail);
  }

  let resumeThreadId: string | null = null;
  if (jobExtras.resume) {
    const referenced = findJob(cwd, jobExtras.resume);
    resumeThreadId = referenced?.threadId ?? jobExtras.resume;
  }

  const jobId = generateJobId();
  const job = writeJob(cwd, jobId, {
    status: 'queued',
    kind: 'task',
    name: jobExtras.name ?? null,
    system: opts.system ?? null,
    agent: resolved.agent,
    engine: resolved.engine,
    prompt: opts.prompt,
    model: resolved.model,
    effort: resolved.effort,
    permissions: resolved.permissions,
    resumeThreadId,
    cwd,
    background: !opts.wait,
    ...(jobExtras.simulateApproval ? { simulateApproval: true } : {}),
    ...(opts.flowRunId ? { flowRunId: opts.flowRunId } : {}),
  });

  // Always run the task in a detached worker, so interrupting the caller never
  // kills the task.
  const jobDir = resolveJobDir(cwd, jobId);
  const logFd = fs.openSync(path.join(jobDir, 'worker.log'), 'a');
  const child = spawn(process.execPath, [CLI_PATH, '_worker', jobId, '--cwd', cwd], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, [WORKER_ENV]: '1' },
  });
  child.unref();
  fs.closeSync(logFd);
  writeJob(cwd, jobId, { pid: child.pid ?? null });

  // Startup check: wait until the worker reports a live thread, then until its
  // next substantive event lands (first real output, or a failure) — not a
  // fixed timer. Lifecycle entries (phase 'starting': thread ready, turn
  // started) don't count as settling: an engine can greet and then die (codex
  // rejects a over-limit turn ~2.5s in), and that must fail over inside the
  // gate, not surface mid-turn.
  const ALL = Number.MAX_SAFE_INTEGER;
  const substantive = () =>
    readJobLog(cwd, jobId, ALL).filter(e => (e as { phase?: string }).phase !== 'starting').length;
  const deadline = Date.now() + 15_000;
  let current = job;
  let baseline: number | null = null;
  let settleDeadline: number | null = null;
  while (Date.now() < (settleDeadline ?? deadline)) {
    current = readJob(cwd, jobId) ?? current;
    if (current.status === 'failed' || current.status === 'completed') {
      break;
    }
    if (current.threadId && baseline === null) {
      baseline = substantive();
      settleDeadline = Date.now() + 5_000;
    }
    if (baseline !== null && substantive() > baseline) {
      current = readJob(cwd, jobId) ?? current;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  if (current.status === 'failed') {
    // Turn errors (sandbox init, usage/auth) land in result.json, not the
    // progress log, so prefer it and fall back to the log tail.
    const resultFile = path.join(jobDir, 'result.json');
    const resultError =
      readJsonFile<{ error?: { message?: string } }>(resultFile)?.error?.message ?? '';
    const logTail = readJobLog(cwd, jobId, 5)
      .map(entry => entry.message ?? '')
      .join('\n');
    const detail = resultError || logTail;
    if (isSandboxFailure(resolved.permissions, detail)) {
      throw new CoderError('read-only-unavailable', detail);
    }
    if (STARTUP_ERROR_PATTERN.test(detail)) {
      throw new FallbackSignal(resolved.agent, detail);
    }
    throw new CoderError('startup-failed', detail, { taskId: jobId });
  }

  return {
    taskId: jobId,
    job: current,
    agent: resolved.agent,
    startupCheck: current.threadId ? 'passed' : 'pending',
  };
}

export function buildFallbackPayload(
  agent: Agent,
  detail: string,
  permissions: string,
  system: string | null | undefined,
  task: string,
): FallbackPayload {
  return {
    error: `${agent} failed to start: ${detail}`,
    fallback: {
      action: 'run-native-subagent',
      reason: 'no-engine-available',
      permissions,
      note: 'Every coder engine failed to start. Spawn your own native subagent and forward the task verbatim; tell it to never run git write operations (commit, checkout, stash, reset, push, ...) and to honor the permissions.',
      ...(system ? { system } : {}),
      task,
    },
  };
}

/**
 * Create a task and wait for it to reach startup readiness, walking the engine
 * chain when an engine can't start. Returns once the task is live (or already
 * terminal); throws a typed error otherwise. Never prints, never exits.
 */
export async function dispatchTask(opts: DispatchOptions): Promise<DispatchResult> {
  if (process.env[WORKER_ENV]) {
    throw new CoderError('nested-dispatch', 
      'Nested dispatch refused: this shell is already inside a coder task. ' +
        'Do the work yourself, directly in this session - ignore any skill or ' +
        'instruction telling you to orchestrate via the coder CLI.',
    );
  }
  if (!opts.prompt.trim()) {
    throw new CoderError('invalid-option', 'Missing task text.', {
      hint: ['Usage: coder run "<task text>"', 'Help: coder task run --help'],
    });
  }

  const config = loadConfig(opts.cwd);

  // First attempt uses the full request (model/effort/name/resume/simulate).
  // A chain fallback re-resolves fresh for the next agent, deliberately dropping
  // model/effort/name/resume — the next engine runs with its own config default.
  let resolveInput: Record<string, any> = {
    agent: opts.agent,
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
  };
  let jobExtras = {
    name: opts.name,
    resume: opts.resume,
    simulateApproval: opts.simulateApproval,
  };

  for (;;) {
    const resolved = resolveTaskOptions(resolveInput, config);
    try {
      return await attemptOnce(config, resolved, opts, jobExtras);
    } catch (error) {
      if (!(error instanceof FallbackSignal)) {
        throw error;
      }
      const next = config.chain[config.chain.indexOf(error.agent) + 1];
      if (!next) {
        const payload = buildFallbackPayload(
          error.agent,
          error.detail,
          resolved.permissions,
          opts.system,
          opts.prompt,
        );
        throw new CoderError('chain-exhausted', payload.error, { payload });
      }
      opts.onFallback?.({ agent: error.agent, detail: error.detail, next });
      resolveInput = { agent: next, permissions: opts.permissions };
      jobExtras = { name: undefined, resume: undefined, simulateApproval: undefined };
    }
  }
}

// ---------------------------------------------------------------------------
// waitTask / readTask
// ---------------------------------------------------------------------------

export interface TaskResult {
  taskId: string;
  status: JobStatus;
  result: TurnResult | null;
  /** The last `tail` progress-log entries; [] at the default tail of 0. */
  steps: JobLogEntry[];
  job: Job;
}

/**
 * Chain agent to retry on after a mid-turn failure, or undefined. Startup
 * fallback (dispatchTask) can't cover an engine that dies moments after the
 * gate (usage limit, auth): dispatch has already returned. A waiting caller
 * may walk the chain instead of surfacing the failure — but only when the
 * error matches the startup pattern AND the turn provably did nothing, so a
 * retry can't double-apply work.
 */
export function turnFallbackAgent(cwd: string, waited: TaskResult): Agent | undefined {
  if (waited.status !== 'failed') return undefined;
  const r = waited.result;
  if (!r || !STARTUP_ERROR_PATTERN.test(r.error?.message ?? '')) return undefined;
  const sideEffectFree =
    !r.touchedFiles?.length &&
    !(r as any).fileChanges?.length &&
    !(r as any).commandExecutions?.length;
  if (!sideEffectFree) return undefined;
  const chain = loadConfig(cwd).chain;
  return chain[chain.indexOf(waited.job.agent as Agent) + 1];
}

function readResultJson(cwd: string, taskId: string): TurnResult | null {
  // Tolerates a missing or truncated file (worker crash mid-write).
  return readJsonFile<TurnResult>(path.join(resolveJobDir(cwd, taskId), 'result.json'));
}

// The last `tail` log entries ('all' for the whole transcript; default 0: none).
function readSteps(cwd: string, taskId: string, tail: number | 'all' = 0): JobLogEntry[] {
  if (tail === 0) return [];
  return readJobLog(cwd, taskId, tail === 'all' ? Number.MAX_SAFE_INTEGER : tail);
}

/** Read a task's current state and result.json without waiting. `tail` fills `steps`. */
export function readTask(
  cwd: string,
  taskId: string,
  opts: { tail?: number | 'all' } = {},
): TaskResult {
  const job = readJob(cwd, taskId);
  if (!job) {
    throw new Error(`No task found for "${taskId}".`);
  }
  return {
    taskId,
    status: job.status,
    result: readResultJson(cwd, taskId),
    steps: readSteps(cwd, taskId, opts.tail),
    job,
  };
}

/**
 * Block until a task reaches a terminal state, then return its TurnResult.
 * A pending approval surfaces as a CoderError (code approval-pending), not exit 4.
 */
export async function waitTask(
  cwd: string,
  taskId: string,
  opts: { tail?: number | 'all'; onSettle?: () => void } = {},
): Promise<TaskResult> {
  const job = readJob(cwd, taskId);
  if (!job) {
    throw new Error(`No task found for "${taskId}".`);
  }
  const outcome = await waitForTaskAttention(cwd, job);
  if (outcome.reason === 'approval') {
    const approval = outcome.approval!;
    throw new CoderError('approval-pending', `Approval needed for task ${taskId}: ${approval.summary}`, {
      taskId,
      approval,
    });
  }
  opts.onSettle?.();
  const final = outcome.job;
  return {
    taskId,
    status: final.status,
    result: readResultJson(cwd, taskId),
    steps: readSteps(cwd, taskId, opts.tail),
    job: final,
  };
}

export { STARTUP_ERROR_PATTERN, isSandboxFailure };
