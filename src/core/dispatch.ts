/**
 * Exit-free, print-free task dispatch core shared by the CLI and the SDK.
 * Failures surface as the typed errors below; the CLI maps them to exit codes.
 */
import fs from 'node:fs';
import { CoderError, type FallbackPayload } from './errors';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import * as z from 'zod/mini';

import {
  findTask,
  generateTaskId,
  loadTask,
  readTaskLog,
  readTurnResults,
  resolveTaskDir,
  tailSteps,
  writeTask,
  type TaskLogEntry,
  type TurnResultEntry,
  reconcileTask,
} from './state';
import { readJsonFile } from '../utils/fsx';
import { getCodexAvailability } from './engines/codex';
import { isUnsupportedModelError } from './engines/codex/errors';
import { getClaudeAvailability } from './engines/claude';
import { ensureCodexInstalled, modelVersionWarning } from './hosts';
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
  parseEngineSpec,
  resolveCodexModel,
  type McpConfigEntry,
} from './config';
import { CLI_PATH } from './runtime';
import {
  type Engine,
  type CoderConfig,
  type Effort,
  type Task,
  type TaskStatus,
  type McpServerSpec,
  type ResolvedTaskOptions,
  type TurnResult,
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
} from './types';
import { listPendingApprovals } from './approvals';

const STARTUP_ERROR_PATTERN =
  /usage|quota|rate.?limit|429|401|unauthorized|not authenticated|login|insufficient|exhausted|not available|ENOENT/i;

// An engine that could not start. A model the account lacks is the caller's
// choice to fix, not a reason to switch engines.
function isStartupError(message: string): boolean {
  return STARTUP_ERROR_PATTERN.test(message) && !isUnsupportedModelError(message);
}

// Marks a worker's whole process tree (engine, agent shell) so task-creating
// commands can refuse nested dispatch.
export const WORKER_ENV = 'CODER_WORKER';

export { CoderError, type CoderErrorCode, type FallbackPayload } from './errors';

// Internal signal: this engine could not start; fall through the chain.
class FallbackSignal extends Error {
  engine: Engine;
  detail: string;
  constructor(engine: Engine, detail: string) {
    super(detail);
    this.engine = engine;
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
  // A bare model implies its engine: sonnet/opus/fable -> claude,
  // luna/sol/astra -> codex, a configured custom-model name -> custom.
  // Explicit --engine always wins; unknown/raw slugs keep the chain default.
  let engine = options.engine;
  const explicitEngine = Boolean(engine);
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
    let parsed: ReturnType<typeof parseEngineSpec>;
    try {
      parsed = parseEngineSpec(modelInput, config);
    } catch (error) {
      throw new CoderError(
        'invalid-option',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (parsed) {
      if (!explicitEngine) {
        engine = parsed.engine;
      }
      modelInput = parsed.model ?? undefined;
      effortInput = effortInput ?? parsed.effort ?? undefined;
    }
  }
  if (!engine && modelInput) {
    if (modelInput in CLAUDE_MODELS) {
      engine = 'claude';
    } else if (modelInput in CODEX_MODELS) {
      engine = 'codex';
    } else if (endpointEntry(modelInput)) {
      engine = 'custom';
    } else if (/^(?:claude-|opus|sonnet|haiku|fable)/i.test(modelInput)) {
      engine = 'claude';
    }
  }
  engine = engine ?? config.chain[0] ?? 'codex';
  if (engine !== 'codex' && engine !== 'claude' && engine !== 'custom') {
    const hint =
      engine in CODEX_MODELS || engine in CLAUDE_MODELS || engine in (config.models ?? {})
        ? ` "${engine}" is a model; use --model ${engine}.`
        : '';
    throw new CoderError(
      'invalid-option',
      `Invalid --engine "${engine}". Use codex, claude, or custom.${hint}`,
    );
  }
  const engineDefaults = config.engines[engine as Engine] ?? {};
  let model = modelInput ?? engineDefaults.model ?? null;
  let effort = effortInput ?? engineDefaults.effort ?? null;
  if (aliasEntry(model)) {
    let parsed: ReturnType<typeof parseEngineSpec>;
    try {
      parsed = parseEngineSpec(model, config);
    } catch (error) {
      throw new CoderError(
        'invalid-option',
        error instanceof Error ? error.message : String(error),
      );
    }
    if (parsed) {
      if (!explicitEngine) {
        engine = parsed.engine;
      }
      model = parsed.model;
      effort = effortInput ?? parsed.effort ?? effort;
    }
  }
  const permissions = options.permissions ?? engineDefaults.permissions ?? 'auto';

  // A disabled built-in alias must never reach an engine.
  try {
    assertModelEnabled(config, model);
  } catch (error) {
    throw new CoderError('invalid-option', error instanceof Error ? error.message : String(error));
  }

  // The custom engine groups the user's configured (OpenAI-compatible) models;
  // the model must be a config entry, so typos fail here with the configured
  // names instead of reaching an engine.
  if (engine === 'custom') {
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
          : 'No custom model to run: pass --model <name> or set engines.custom.model.',
        {
          hint: 'Add one: coder model add <name> --base-url <url> --model <id>',
        },
      );
    }
  }
  const claude = engine === 'claude';

  if (!(permissions in PERMISSION_MODES)) {
    throw new CoderError(
      'invalid-option',
      `Invalid --permissions "${permissions}". Use one of: ${Object.keys(PERMISSION_MODES).join(', ')}`,
    );
  }
  if (!claude && effort && !CODEX_EFFORTS.has(effort)) {
    throw new CoderError(
      'invalid-option',
      `Invalid codex --effort "${effort}". Use one of: ${[...CODEX_EFFORTS].join(', ')}`,
    );
  }
  if (claude && effort && !CLAUDE_EFFORTS.has(effort)) {
    throw new CoderError(
      'invalid-option',
      `Invalid claude --effort "${effort}". Use one of: ${[...CLAUDE_EFFORTS].join(', ')}`,
    );
  }

  return { engine, model, effort, permissions };
}

// ---------------------------------------------------------------------------
// Extra MCP servers
// ---------------------------------------------------------------------------

const mcpServerSchema = z
  .strictObject({
    name: z.string().check(z.minLength(1)),
    command: z.optional(z.string().check(z.minLength(1))),
    args: z.optional(z.array(z.string())),
    env: z.optional(z.record(z.string(), z.string())),
    url: z.optional(z.string().check(z.minLength(1))),
    type: z.optional(z.enum(['stdio', 'http', 'sse'])),
    headers: z.optional(z.record(z.string(), z.string())),
    tools: z.optional(z.array(z.string())),
  })
  .check(z.refine(entry => Boolean(entry.command) !== Boolean(entry.url), 'one of command or url'));
const mcpServersSchema = z.array(mcpServerSchema);

/**
 * Parse `--mcp`: `all` or comma-separated names from the config's `mcp` map, or a JSON array of
 * inline server specs.
 */
export function parseMcpServers(
  value: string,
  configured: Record<string, McpConfigEntry> = {},
): McpServerSpec[] {
  const text = value.trim();
  if (!/^[\[{]/.test(text)) {
    const names =
      text === 'all'
        ? Object.keys(configured)
        : text
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
    if (text === 'all' && !names.length)
      throw new CoderError(
        'invalid-option',
        'No MCP servers configured under `mcp` in .coder/config.json.',
      );
    return names.map(name => {
      const entry = configured[name];
      if (!entry)
        throw new CoderError('invalid-option', `Unknown MCP server "${name}".`, {
          hint: `configured: ${Object.keys(configured).join(', ') || 'none'}; or pass a JSON array`,
        });
      return { name, ...entry };
    });
  }
  return parseMcpJson(text);
}

function parseMcpJson(json: string): McpServerSpec[] {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new CoderError(
      'invalid-option',
      `Invalid --mcp JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = mcpServersSchema.safeParse(value);
  if (!parsed.success) {
    throw new CoderError(
      'invalid-option',
      `Invalid --mcp value: ${z.prettifyError(parsed.error)}`,
      {
        hint: '--mcp \'[{"name":"docs","command":"npx","args":["-y","docs-mcp"],"tools":["search"]}]\'',
      },
    );
  }
  return parsed.data;
}

/** Expand `${VAR}` and `${VAR:-default}` (the `.mcp.json` convention) in command, args, url, env, and headers. */
export function resolveMcpServers(
  servers: McpServerSpec[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): McpServerSpec[] {
  const expand = (value: string) =>
    value.replace(
      /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (_, name, fallback) => env[name] ?? fallback ?? '',
    );
  const map = (record: Record<string, string>) =>
    Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v)]));
  return (servers ?? []).map(server => ({
    ...server,
    ...(server.command ? { command: expand(server.command) } : {}),
    ...(server.args ? { args: server.args.map(expand) } : {}),
    ...(server.url ? { url: expand(server.url) } : {}),
    ...(server.env ? { env: map(server.env) } : {}),
    ...(server.headers ? { headers: map(server.headers) } : {}),
  }));
}

/** Resolve `--add-dir` paths against the task workspace; each must be an existing directory. */
export function resolveAddDirs(cwd: string, dirs: string[] = []): string[] {
  const resolved = [...new Set(dirs.map(dir => path.resolve(cwd, dir)))];
  for (const dir of resolved) {
    if (!fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
      throw new CoderError('invalid-option', `--add-dir ${dir} is not a directory.`);
    }
  }
  return resolved;
}

function isSandboxFailure(permissions: string, detail: string): boolean {
  return permissions === 'read-only' && CLAUDE_SANDBOX_UNAVAILABLE_PATTERN.test(detail ?? '');
}

// ---------------------------------------------------------------------------
// dispatchTask
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  prompt: string;
  outputSchema?: object;
  cwd: string;
  /** Whether the caller explicitly selected cwd instead of accepting resume inheritance. */
  cwdExplicit?: boolean;
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  name?: string | null;
  system?: string | null;
  resume?: string;
  wait?: boolean;
  simulateApproval?: boolean;
  /** Tags the created task as belonging to a flow run (for `coder list` grouping). */
  flowRunId?: string;
  agentId?: string;
  source?: string;
  /** Handle an agent task posts as. */
  author?: string;
  /** Repository an agent task's event came from. */
  repo?: string;
  /** Extra MCP servers the task's engine may call, with their tool allowlists. */
  mcp?: McpServerSpec[];
  /** Extra directories the task may reach, resolved against cwd. */
  addDirs?: string[];
  /** Called with (engine, detail, next) when an engine falls through the chain. */
  onFallback?: (info: { engine: Engine; detail: string; next: Engine }) => void;
  /** Called with a note when a missing codex binary is installed on the spot. */
  onNote?: (note: string) => void;
  /** A durable local delivery retries the same task. */
  taskId?: string;
}

const PERMISSION_ORDER = ['read-only', 'workspace-write', 'auto'];

/** Permissions for a task an agent's flow starts: the agent's unless the task asks for less. */
export function capPermissions(
  name: string | null | undefined,
  asked: string | null | undefined,
  ceiling: { agent: string; permissions: string },
): string {
  if (!asked) return ceiling.permissions;
  if (PERMISSION_ORDER.indexOf(asked) > PERMISSION_ORDER.indexOf(ceiling.permissions))
    throw new CoderError(
      'invalid-option',
      `task "${name ?? 'task'}" asks for ${asked} but agent "${ceiling.agent}" is ${ceiling.permissions}: lower the task's permissions or raise the agent's`,
    );
  return asked;
}

export function withResumeDefaults(opts: DispatchOptions): DispatchOptions {
  if (!opts.resume) return opts;
  const referenced = findTask(opts.cwd, opts.resume);
  if (!referenced) return opts;
  return {
    ...opts,
    cwd: opts.cwdExplicit === false ? (referenced.cwd ?? opts.cwd) : opts.cwd,
    engine: opts.engine ?? referenced.engine,
    model: opts.model ?? referenced.model ?? undefined,
    effort: opts.effort ?? referenced.effort ?? undefined,
    permissions: opts.permissions ?? referenced.permissions ?? undefined,
    outputSchema: opts.outputSchema ?? referenced.outputSchema,
  };
}

export interface DispatchResult {
  taskId: string;
  task: Task;
  /** The engine the task actually started on (may differ after a fallback). */
  engine: Engine;
  /** 'passed' once a live thread is observed, else 'pending'. */
  startupCheck: 'passed' | 'pending';
}

/** Spawn a task's detached worker (also used by steer to resume a stopped task in place). */
export function spawnWorker(cwd: string, taskId: string): void {
  const taskDir = resolveTaskDir(cwd, taskId);
  const logFd = fs.openSync(path.join(taskDir, 'worker.log'), 'a');
  const child = spawn(process.execPath, [CLI_PATH, 'task', 'worker', taskId, '--cwd', cwd], {
    cwd,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, [WORKER_ENV]: '1' },
  });
  child.unref();
  fs.closeSync(logFd);
  writeTask(cwd, taskId, { pid: child.pid ?? null });
}

// One attempt on one engine: availability gate, task create, spawn, startup wait.
async function attemptOnce(
  config: CoderConfig,
  resolved: ResolvedTaskOptions,
  opts: DispatchOptions,
  taskExtras: {
    name?: string | null;
    resume?: string;
    simulateApproval?: boolean;
  },
  waitForStartup: boolean,
): Promise<DispatchResult> {
  const cwd = opts.cwd;

  // Startup gate: cheap checks before creating a task.
  let availability =
    resolved.engine !== 'claude' ? getCodexAvailability(cwd) : getClaudeAvailability();
  const resolvedEntry = resolved.model ? config.models?.[resolved.model] : undefined;
  if (!availability.available && resolvedEntry && isEndpointModel(resolvedEntry)) {
    const install = ensureCodexInstalled(availability);
    opts.onNote?.(install!.note);
    availability = getCodexAvailability(cwd);
  }
  if (!availability.available) {
    throw new FallbackSignal(resolved.engine, availability.detail);
  }
  const outdated = resolvedEntry
    ? null
    : resolved.engine === 'claude'
      ? modelVersionWarning('claude', resolved.model, availability)
      : modelVersionWarning('codex', resolveCodexModel(resolved.model), availability);
  if (outdated) opts.onNote?.(outdated);

  let resumeThreadId: string | null = null;
  let addDirs = opts.addDirs ?? [];
  if (taskExtras.resume) {
    const referenced = findTask(cwd, taskExtras.resume);
    resumeThreadId = referenced?.threadId ?? taskExtras.resume;
    addDirs = [...new Set([...(referenced?.addDirs ?? []), ...addDirs])];
  }

  const taskId = opts.taskId ?? generateTaskId();
  const task = writeTask(cwd, taskId, {
    status: 'queued',
    ...(opts.taskId ? { dispatchId: randomUUID() } : {}),
    kind: 'task',
    name: taskExtras.name ?? null,
    system: opts.system ?? null,
    engine: resolved.engine,
    prompt: opts.prompt,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    model: resolved.model,
    effort: resolved.effort,
    permissions: resolved.permissions,
    resumeThreadId,
    cwd,
    background: !opts.wait,
    ...(taskExtras.simulateApproval ? { simulateApproval: true } : {}),
    ...(opts.flowRunId ? { flowRunId: opts.flowRunId } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.mcp?.length ? { mcp: opts.mcp } : {}),
    ...(addDirs.length ? { addDirs } : {}),
  });

  // Always run the task in a detached worker, so interrupting the caller never
  // kills the task.
  spawnWorker(cwd, taskId);

  if (!waitForStartup)
    return {
      taskId,
      task: loadTask(cwd, taskId) ?? task,
      engine: resolved.engine,
      startupCheck: 'pending',
    };

  // Wait for real output or failure; lifecycle greetings alone do not settle startup.
  const ALL = Number.MAX_SAFE_INTEGER;
  // Lifecycle greetings and token snapshots aren't work: an engine can say
  // hello, report its context size, and still die before doing anything.
  const LIFECYCLE = new Set(['status', 'usage']);
  const substantive = () =>
    readTaskLog(cwd, taskId, ALL).filter(entry => {
      const { phase, kind } = entry as { phase?: string; kind?: string };
      return phase !== 'starting' && !LIFECYCLE.has(String(kind ?? ''));
    }).length;
  const deadline = Date.now() + 15_000;
  let current = task;
  let baseline: number | null = null;
  let settleDeadline: number | null = null;
  while (Date.now() < (settleDeadline ?? deadline)) {
    current = loadTask(cwd, taskId) ?? current;
    if (current.status === 'failed' || current.status === 'completed') {
      break;
    }
    if (current.threadId && baseline === null) {
      baseline = substantive();
      settleDeadline = Date.now() + 5_000;
    }
    if (baseline !== null && substantive() > baseline) {
      current = loadTask(cwd, taskId) ?? current;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 150));
  }

  if (current.status === 'failed') {
    // Turn errors (sandbox init, usage/auth) land in result.json, not the
    // progress log, so prefer it and fall back to the log tail.
    const resultFile = path.join(resolveTaskDir(cwd, taskId), 'result.json');
    const resultError =
      readJsonFile<{ error?: { message?: string } }>(resultFile)?.error?.message ?? '';
    const logTail = readTaskLog(cwd, taskId, 5)
      .map(entry => entry.message ?? '')
      .join('\n');
    const detail = resultError || logTail;
    if (isSandboxFailure(resolved.permissions, detail)) {
      throw new CoderError('read-only-unavailable', detail);
    }
    if (isStartupError(detail)) {
      throw new FallbackSignal(resolved.engine, detail);
    }
    throw new CoderError('startup-failed', detail, { taskId: taskId });
  }

  return {
    taskId: taskId,
    task: current,
    engine: resolved.engine,
    startupCheck: current.threadId ? 'passed' : 'pending',
  };
}

export function buildFallbackPayload(
  engine: Engine,
  detail: string,
  permissions: string,
  system: string | null | undefined,
  task: string,
): FallbackPayload {
  return {
    error: `${engine} failed to start: ${detail}`,
    fallback: {
      action: 'run-native-subagent',
      reason: 'no-engine-available',
      permissions,
      instructions:
        'Mention the engine failure to the user, including any limit reset time. If your harness has a native subagent facility, spawn one subagent with fallback.task verbatim, prefixed with: "NEVER run git write operations (commit, checkout, stash, reset, push, etc.); leave changes uncommitted." If fallback.permissions is "read-only", append: "Investigate and report without modifying anything." If it is "workspace-write", append: "Never touch anything outside the workspace." Relay its output when it completes. If your harness has no native subagent facility, report the failure and stop; do not implement the task yourself.',
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
export async function dispatchTask(
  opts: DispatchOptions,
  // Worker-internal: a task an agent's flow asked for through its mailbox, already capped.
  internal: { fromMailbox?: boolean; waitForStartup?: boolean } = {},
): Promise<DispatchResult> {
  if (process.env[WORKER_ENV] && !internal.fromMailbox) {
    throw new CoderError(
      'nested-dispatch',
      'Nested dispatch is disabled inside a worker; do the work directly.',
    );
  }
  if (
    opts.outputSchema !== undefined &&
    (!opts.outputSchema ||
      typeof opts.outputSchema !== 'object' ||
      Array.isArray(opts.outputSchema))
  )
    throw new CoderError('invalid-option', 'outputSchema must be an object.');
  if (!opts.prompt.trim()) {
    throw new CoderError('invalid-option', 'Missing task text.', {
      hint: ['Usage: coder run "<task text>"', 'Help: coder task run --help'],
    });
  }

  opts = withResumeDefaults(opts);
  opts = { ...opts, addDirs: resolveAddDirs(opts.cwd, opts.addDirs) };
  const config = loadConfig(opts.cwd);

  // First attempt uses the full request (model/effort/name/resume/simulate).
  // A chain fallback re-resolves fresh for the next engine, deliberately dropping
  // model, effort, name, and resume. The next engine uses its own config default.
  let resolveInput: Record<string, any> = {
    engine: opts.engine,
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
  };
  let taskExtras = {
    name: opts.name,
    resume: opts.resume,
    simulateApproval: opts.simulateApproval,
  };

  for (;;) {
    const resolved = resolveTaskOptions(resolveInput, config);
    try {
      return await attemptOnce(
        config,
        resolved,
        opts,
        taskExtras,
        internal.waitForStartup !== false,
      );
    } catch (error) {
      if (!(error instanceof FallbackSignal)) {
        throw error;
      }
      const next = config.chain[config.chain.indexOf(error.engine) + 1];
      if (!next) {
        const payload = buildFallbackPayload(
          error.engine,
          error.detail,
          resolved.permissions,
          opts.system,
          opts.prompt,
        );
        throw new CoderError('chain-exhausted', payload.error, { payload });
      }
      opts.onFallback?.({ engine: error.engine, detail: error.detail, next });
      resolveInput = { engine: next, permissions: opts.permissions };
      taskExtras = {
        name: undefined,
        resume: undefined,
        simulateApproval: undefined,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// waitTask / readTask
// ---------------------------------------------------------------------------

export interface TaskResult {
  taskId: string;
  status: TaskStatus;
  result: TurnResult | null;
  /** The last `tail` progress-log entries; [] at the default tail of 0. */
  steps: TaskLogEntry[];
  /** One entry per finished turn (a steered task accretes turns). */
  turns: TurnResultEntry[];
  task: Task;
}

/**
 * Chain engine to retry on after a mid-turn failure, or undefined. Startup
 * fallback (dispatchTask) can't cover an engine that dies moments after the
 * gate (usage limit, auth): dispatch has already returned. A waiting caller
 * may walk the chain instead of surfacing the failure, but only when the
 * error matches the startup pattern AND the turn provably did nothing, so a
 * retry can't double-apply work.
 */
export function turnFallbackEngine(cwd: string, waited: TaskResult): Engine | undefined {
  if (waited.status !== 'failed') return undefined;
  const r = waited.result;
  if (!r || !isStartupError(r.error?.message ?? '')) return undefined;
  const sideEffectFree =
    !r.touchedFiles?.length &&
    !(r as any).fileChanges?.length &&
    !(r as any).commandExecutions?.length;
  if (!sideEffectFree) return undefined;
  const chain = loadConfig(cwd).chain;
  return chain[chain.indexOf(waited.task.engine as Engine) + 1];
}

export function readResultJson(cwd: string, taskId: string): TurnResult | null {
  // Tolerates a missing or truncated file (worker crash mid-write).
  return readJsonFile<TurnResult>(path.join(resolveTaskDir(cwd, taskId), 'result.json'));
}

// The last `tail` log entries ('all' for the whole transcript; default 0: none).
function readSteps(cwd: string, taskId: string, tail: number | 'all' = 0): TaskLogEntry[] {
  if (tail === 0) return [];
  const all = readTaskLog(cwd, taskId, Number.MAX_SAFE_INTEGER);
  return tail === 'all' ? all : tailSteps(all, tail);
}

/** Read a task's current state and result.json without waiting. `tail` fills `steps`. */
export function readTask(
  cwd: string,
  taskId: string,
  opts: { tail?: number | 'all' } = {},
): TaskResult {
  const task = loadTask(cwd, taskId);
  if (!task) {
    throw new Error(`No task found for "${taskId}".`);
  }
  return {
    taskId,
    status: task.status,
    // A running task's result.json is a previous turn's (a resumed task).
    result: ACTIVE_STATUSES.includes(task.status) ? null : readResultJson(cwd, taskId),
    steps: readSteps(cwd, taskId, opts.tail),
    turns: readTurnResults(cwd, taskId),
    task,
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
  const task = loadTask(cwd, taskId);
  if (!task) {
    throw new Error(`No task found for "${taskId}".`);
  }
  const outcome = await waitForTaskAttention(cwd, task);
  if (outcome.reason === 'approval') {
    const approval = outcome.approval!;
    throw new CoderError(
      'approval-pending',
      `Approval needed for task ${taskId}: ${approval.summary}`,
      {
        taskId,
        approval,
      },
    );
  }
  opts.onSettle?.();
  const final = outcome.task;
  return {
    taskId,
    status: final.status,
    result: readResultJson(cwd, taskId),
    steps: readSteps(cwd, taskId, opts.tail),
    turns: readTurnResults(cwd, taskId),
    task: final,
  };
}

export { isStartupError, isSandboxFailure };

export interface WaitOutcome {
  task: Task;
  reason: 'terminal' | 'approval';
  approval?: { id: string; summary: string; cwd?: string | null; networkHost?: string | null };
}

/**
 * Blocking wait shared by `run --wait` and `result --wait`. Returns when the
 * task finishes OR a pending approval appears, so a --wait surfaces the approval
 * (which is answered out of band with `coder task approve`) instead of blocking
 * silently through it until the worker's 120s auto-decline.
 */
export async function waitForTaskAttention(
  cwd: string,
  task: Task,
  pollMs = 400,
): Promise<WaitOutcome> {
  let current = task;
  for (;;) {
    if (TERMINAL_STATUSES.includes(current.status)) {
      return { task: current, reason: 'terminal' };
    }
    const pending = listPendingApprovals(resolveTaskDir(cwd, current.id)).filter(a => !a.response);
    if (pending[0]) {
      const params = pending[0].params as
        { networkApprovalContext?: { host?: string | null } | null } | undefined;
      return {
        task: current,
        reason: 'approval',
        approval: {
          id: pending[0].id,
          summary: String(pending[0].summary ?? ''),
          cwd: typeof pending[0].cwd === 'string' ? pending[0].cwd : null,
          networkHost: params?.networkApprovalContext?.host ?? null,
        },
      };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
    current = reconcileTask(cwd, loadTask(cwd, current.id) ?? current);
  }
}
