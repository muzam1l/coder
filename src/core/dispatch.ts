/**
 * Exit-free, print-free task dispatch core shared by the CLI and the SDK.
 * Failures surface as the typed errors below; the CLI maps them to exit codes.
 */
import fs from 'node:fs';
import { CoderError, type FallbackPayload } from './errors';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { spawn, type ChildProcess } from 'node:child_process';

import { processTiming } from '../utils/process';

import * as z from 'zod/mini';

import {
  generateTaskId,
  loadTask,
  appendTaskLog,
  readTaskLog,
  readTurnResults,
  watchTask,
  resolveTaskDir,
  scratchDir,
  tailSteps,
  writeTask,
  type TaskLogEntry,
  type TurnResultEntry,
  reconcileTask,
  turnPending,
  hasPendingSteers,
  processStarts,
  formatEngineSpec,
} from './state';
import { createJsonlTail, readJsonFile } from '../utils/fsx';
import { getCodexAvailability } from './engines/codex';
import { isUnsupportedModelError } from './engines/codex/app-server';
import { claudeVersionEnvironment, getClaudeAvailability } from './engines/claude';
import { ensureCodexInstalled, modelVersionWarning } from './hosts';
import {
  ACCESS_MODES,
  CLAUDE_SANDBOX_UNAVAILABLE_PATTERN,
  assertModelEnabled,
  isBuiltinAlias,
  isEndpointModel,
  loadConfig,
  parseEngineSpec,
  sameModel,
  splitEngineSpec,
  resolveCodexModel,
  type McpConfigEntry,
  mcpEntrySchema,
} from './config';
import { CLI_PATH } from './runtime';
import {
  type Engine,
  type Availability,
  type CoderConfig,
  type Effort,
  type Task,
  type TaskStatus,
  type McpServerSpec,
  type ResolvedTaskOptions,
  type Approval,
  type TurnResult,
  ACTIVE_STATUSES,
  HISTORY_LOST,
  TERMINAL_STATUSES,
} from './types';
import { pendingApprovals, restoreApprovals } from './approvals';
import { mcpApproved, mcpWarnings } from './mcp';
import type { AgentPromptParts } from './task/context/system';
import type { RunnerKind } from '../client/types';

const STARTUP_ERROR_PATTERN =
  /usage|quota|rate.?limit|429|401|unauthorized|not authenticated|login|insufficient|exhausted|not available|\bat capacity\b|ENOENT/i;

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

/** Whether a spec resolves, not turned off. */
function runnable(spec: string, config: CoderConfig): boolean {
  try {
    return Boolean(parseEngineSpec(spec, config));
  } catch {
    return false;
  }
}

export function resolveTaskOptions(
  options: Record<string, any>,
  config: CoderConfig,
): ResolvedTaskOptions {
  const invalid = (error: unknown) =>
    new CoderError('invalid-option', error instanceof Error ? error.message : String(error));
  const requested: string | undefined = options.engine;
  if (requested !== undefined && requested !== 'codex' && requested !== 'claude' && requested !== 'custom') {
    const hint =
      isBuiltinAlias(requested) || requested in (config.models ?? {})
        ? ` "${requested}" is a model; use --model ${requested}.`
        : '';
    throw new CoderError(
      'invalid-option',
      `Invalid engine "${requested}". Use --model <model> or --model <engine/model>.${hint}`,
    );
  }
  // Parts, as agent settings and fallbacks give them, make one spec; none runs the chain's first.
  const spec: string = options.model
    ? requested && !String(options.model).includes('/')
      ? `${requested}/${options.model}`
      : options.model
    : (requested ?? config.chain.find(entry => runnable(entry, config)) ?? config.chain[0]!);
  let parsed: NonNullable<ReturnType<typeof parseEngineSpec>>;
  let typed: ReturnType<typeof splitEngineSpec>;
  try {
    typed = splitEngineSpec(spec);
    parsed = parseEngineSpec(spec, config)!;
  } catch (error) {
    throw invalid(error);
  }
  const engine = parsed.engine;
  let model = parsed.model;
  const effort = (typed.effort ?? options.effort ?? parsed.effort) as Effort | null;
  const endpointEntry = (name: string | null | undefined) => {
    const entry = name ? config.models?.[name] : undefined;
    return isEndpointModel(entry) ? entry : undefined;
  };
  const access = options.access ?? 'auto';

  // A disabled built-in alias must never reach an engine.
  try {
    assertModelEnabled(config, model);
  } catch (error) {
    throw invalid(error);
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
          : 'No custom model to run: pass --model <name> or list custom/<name> in chain.',
        {
          hint: 'Use --model <name> or --model custom/<name>. Add one: coder model add <name> --base-url <url> --model <id>',
        },
      );
    }
  }
  if (!(access in ACCESS_MODES)) {
    throw new CoderError(
      'invalid-option',
      `Invalid --access "${access}". Use one of: ${Object.keys(ACCESS_MODES).join(', ')}`,
    );
  }

  return { engine, model, effort, access };
}

// ---------------------------------------------------------------------------
// Extra MCP servers
// ---------------------------------------------------------------------------

const { connection: _connection, description: _description, ...mcpFields } = mcpEntrySchema.shape;
const mcpServerSchema = z
  .strictObject({ name: z.string().check(z.minLength(1)), ...mcpFields })
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

/** Native MCP is included only by an explicit `all` selection; `connections` are the task's granted, resolved connections by id. */
export function selectMcpServers(
  value?: string | McpServerSpec[],
  configured: Record<string, McpConfigEntry> = {},
  declared: Record<string, McpConfigEntry> = {},
  connections: Record<string, McpServerSpec> = {},
): {
  mcp: McpServerSpec[];
  mcpBindings?: Task['mcpBindings'];
  nativeMcp: boolean;
  warnings?: string[];
} {
  if (typeof value === 'string' && !value.trim()) value = undefined;

  const selected: McpServerSpec[] =
    typeof value === 'string'
      ? parseMcpServers(value, { ...configured, ...declared })
      : (value ??
        Object.entries(declared).map(([name, entry]) => ({
          name,
          ...entry,
        })));
  const warnings: string[] = [];
  const mcpBindings = selected
    .filter(server => server.connection)
    .map(({ name, connection, tools }) => ({ name, connection, ...(tools ? { tools } : {}) }));
  const bound = new Set<string>();
  const mcp: McpServerSpec[] = [];
  for (const server of selected) {
    if (!server.connection || server.resolved) {
      if (server.connection) bound.add(server.connection);
      if (server.repository) warnings.push(...mcpWarnings(server.name, server));
      mcp.push(server);
      continue;
    }
    const connection = Object.hasOwn(connections, server.connection)
      ? connections[server.connection]
      : undefined;
    if (!connection) {
      warnings.push(
        `MCP server "${server.name}" skipped because connection "${server.connection}" was not granted to this task.`,
      );
      continue;
    }
    if (bound.has(server.connection)) continue;
    bound.add(server.connection);
    const tools = server.tools?.length
      ? server.tools.filter(tool => !connection.tools?.length || connection.tools.includes(tool))
      : connection.tools;
    if (server.tools?.length && !tools?.length) {
      warnings.push(
        `MCP server "${server.name}" skipped because its tools are not granted by connection "${server.connection}".`,
      );
      continue;
    }
    mcp.push({
      ...connection,
      name: server.name,
      connection: server.connection,
      resolved: true,
      ...(tools ? { tools } : {}),
    });
  }
  for (const [id, server] of Object.entries(connections)) {
    if (bound.has(id)) continue;
    const collision = mcp.findIndex(entry => entry.name === server.name);
    if (collision >= 0) mcp.splice(collision, 1);
    mcp.push({ ...server, resolved: true });
  }

  return {
    mcp,
    ...(mcpBindings.length ? { mcpBindings } : {}),
    nativeMcp: typeof value === 'string' && value.trim() === 'all',
    ...(warnings.length ? { warnings } : {}),
  };
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

/** Expand MCP variables; supplying cwd also binds stdio executable and file paths at authorization. */
export function resolveMcpServers(
  servers: McpServerSpec[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
  cwd?: string,
  options: {
    cloud?: boolean;
    connectionEnv?: Record<string, string | null>;
    onWarning?: (message: string) => void;
  } = {},
): McpServerSpec[] {
  const cloud = options.cloud ?? env.CODER_MCP_MODE === 'cloud';
  const connectionEnv =
    options.connectionEnv ??
    (JSON.parse(env.CODER_MCP_CONNECTION_ENV ?? '{}') as Record<string, string | null>);
  const warn = options.onWarning ?? (message => process.stderr.write(`coder: ${message}\n`));
  return (servers ?? []).flatMap(server => {
    const repository = server.repository && !server.resolved;
    if (repository) {
      for (const warning of mcpWarnings(server.name, server)) warn(warning);
      if (!cloud && !mcpApproved(server)) {
        warn(
          `MCP server "${server.name}" skipped pending local approval. Run coder connection approve ${server.name} in its repository.`,
        );
        return [];
      }
    }
    const missing = new Set<string>();
    const ambiguous = new Set<string>();
    const expand = (value: string) =>
      server.resolved
        ? value.replace(/^\$\{(CODER_CONNECTION_[A-F0-9]{24})\}$/, (_, name) => env[name] ?? '')
        : value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
            if (repository && cloud) {
              if (connectionEnv[name] === null) {
                ambiguous.add(name);
                return '';
              }
              if (Object.hasOwn(connectionEnv, name)) return connectionEnv[name];
              missing.add(name);
              return '';
            }
            return env[name] ?? fallback ?? '';
          });
    const map = (record: Record<string, string>) =>
      Object.fromEntries(Object.entries(record).map(([k, v]) => [k, expand(v)]));
    const remote = repository && Boolean(server.url);
    const resolved = {
      ...server,
      ...(server.command ? { command: expand(server.command) } : {}),
      ...(server.args ? { args: server.args.map(expand) } : {}),
      ...(server.url ? { url: remote ? server.url : expand(server.url) } : {}),
      ...(server.env ? { env: map(server.env) } : {}),
      ...(server.headers ? { headers: remote ? server.headers : map(server.headers) } : {}),
    };
    if (ambiguous.size) {
      warn(
        `MCP server "${server.name}" skipped because connection variables ${[...ambiguous].join(', ')} are ambiguous.`,
      );
      return [];
    }
    if (missing.size)
      warn(
        `MCP server "${server.name}" has unresolved connection variables ${[...missing].join(', ')}; expanded to empty.`,
      );
    if (!cwd || !resolved.command) return [resolved];

    const candidates = resolved.command.includes(path.sep)
      ? [path.resolve(cwd, resolved.command)]
      : (resolved.env?.PATH ?? env.PATH ?? '/usr/bin:/bin')
          .split(path.delimiter)
          .map(dir => path.resolve(cwd, dir, resolved.command!));
    const executable = candidates.find(file => {
      try {
        fs.accessSync(file, fs.constants.X_OK);
        return fs.statSync(file).isFile();
      } catch {
        return false;
      }
    });
    if (!executable)
      throw new CoderError(
        'invalid-option',
        `MCP server "${server.name}" command cannot be resolved.`,
      );

    resolved.command = fs.realpathSync(executable);
    // Keep flags and package names intact; pin file arguments before a worker can change directories.
    resolved.args = resolved.args?.map(arg => {
      if (arg.startsWith('-') || path.isAbsolute(arg)) return arg;
      const file = path.resolve(cwd, arg);
      const exists = fs.existsSync(file) && fs.statSync(file).isFile();
      if (!exists && !arg.startsWith('./') && !arg.startsWith('../')) return arg;

      return exists ? fs.realpathSync(file) : file;
    });

    return [resolved];
  });
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

/** Why a task's `--add-dir` paths go unused: its runner is not on the caller's machine. */
export function ignoredAddDirs(runner: RunnerKind): string | undefined {
  return runner === 'local' || runner === 'http'
    ? undefined
    : `--add-dir ignored: this task runs on a ${runner} machine`;
}

function isSandboxFailure(access: string, detail: string): boolean {
  return access === 'read-only' && CLAUDE_SANDBOX_UNAVAILABLE_PATTERN.test(detail ?? '');
}

// ---------------------------------------------------------------------------
// dispatchTask
// ---------------------------------------------------------------------------

export interface DispatchOptions {
  prompt: string;
  outputSchema?: object;
  /** The final message is JSON, by `outputSchema` or by the prompt. */
  structured?: boolean;
  /** A resumed server task's escalations, answers included, restored into its record here. */
  approvals?: Approval[];
  cwd: string;
  engine?: string;
  model?: string;
  effort?: string;
  access?: string;
  name?: string | null;
  appendSystem?: string | null;
  /** The agent's part of the engine's system prompt. */
  agentPrompt?: AgentPromptParts;
  wait?: boolean;
  /** Tags the created task as belonging to a flow run (for `coder list` grouping). */
  flowRunId?: string;
  agentId?: string;
  /** A conversation's task (an agent's default flow). */
  conversation?: boolean;
  source?: string;
  /** Handle an agent task posts as. */
  author?: string;
  /** Repository an agent task's event came from. */
  repo?: string;
  pullRequest?: number;
  /** Extra MCP servers the task's engine may call, with their tool allowlists. */
  mcp?: string | McpServerSpec[];
  mcpWarnings?: string[];
  nativeMcp?: boolean;
  connectionEnv?: Record<string, string>;
  availability?: Partial<Record<Engine, Availability>>;
  onWorker?: (taskId: string, worker: ChildProcess) => void;
  connections?: string[];
  mcpBindings?: Task['mcpBindings'];
  connectionSource?: Task['connectionSource'];
  /** Extra directories the task may reach, resolved against cwd. */
  addDirs?: string[];
  /** The credential a cloud attempt runs on; an undefined value unsets the variable. */
  credentialEnv?: NodeJS.ProcessEnv;
  /** Called with the failed model, why, and the model tried next. */
  onFallback?: (info: { model: string; detail: string; next: string }) => void;
  /** Called with a note when a missing codex binary is installed on the spot. */
  onNote?: (note: string) => void;
  /** A durable local delivery retries the same task. */
  taskId?: string;
  /** An engine conversation and its chain to continue, used only when the task runs on that engine. */
  resume?: Pick<Task, 'previousThreadIds'> & {
    engine: string;
    threadId: string;
  };
}

interface DispatchResult {
  taskId: string;
  task: Task;
  /** The engine the task actually started on (may differ after a fallback). */
  engine: Engine;
  /** 'passed' once a live thread is observed, else 'pending'. */
  startupCheck: 'passed' | 'pending';
}

/** Spawn a task's detached worker (also used by steer to resume a stopped task in place). */
export function spawnWorker(
  cwd: string,
  taskId: string,
  connectionEnv: NodeJS.ProcessEnv = {},
  checked = false,
): ChildProcess {
  const taskDir = resolveTaskDir(cwd, taskId);
  const logFd = fs.openSync(path.join(taskDir, 'worker.log'), 'a');
  const env = { ...process.env, ...connectionEnv };
  const task = loadTask(cwd, taskId);
  processTiming('worker.spawn', { taskId });
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [CLI_PATH, 'task', 'worker', taskId, '--cwd', cwd], {
      cwd,
      detached: true,
      stdio: ['ignore', logFd, logFd, 'ipc'],
      env: {
        ...env,
        ...claudeVersionEnvironment(env, cwd),
        [WORKER_ENV]: '1',
        CODER_ENGINE_CHECKED: checked ? '1' : undefined,
      },
    });
  } finally {
    fs.closeSync(logFd);
  }
  const failed = (detail: string) => {
    const current = loadTask(cwd, taskId);
    if (
      !current ||
      current.dispatchId !== task?.dispatchId ||
      current.resumedAt !== task?.resumedAt ||
      current.pid !== (child.pid ?? null)
    )
      return;
    if (
      !ACTIVE_STATUSES.includes(current.status) &&
      !(current.status === 'completed' && hasPendingSteers(cwd, taskId))
    )
      return;
    const message = `Task worker exited without finishing: ${detail}`;
    writeTask(cwd, taskId, {
      status: 'failed',
      error: message,
      completedAt: new Date().toISOString(),
      steerClosed: true,
      resumeOwner: undefined,
    });
    appendTaskLog(cwd, taskId, { kind: 'error', message });
  };
  child.on('error', error => failed(error.message));
  child.on('exit', (code, signal) => failed(signal ? `signal ${signal}` : `exit ${code}`));
  child.unref();
  child.channel?.unref?.();
  writeTask(cwd, taskId, { pid: child.pid ?? null });

  return child;
}

// One attempt on one engine: availability gate, task create, spawn, startup wait.
async function attemptOnce(
  config: CoderConfig,
  resolved: ResolvedTaskOptions,
  opts: DispatchOptions & { mcp?: McpServerSpec[] },
  taskExtras: {
    name?: string | null;
  },
  waitForStartup: boolean,
): Promise<DispatchResult> {
  const cwd = opts.cwd;

  // Startup gate: cheap checks before creating a task.
  let availability =
    opts.availability?.[resolved.engine === 'custom' ? 'codex' : resolved.engine] ??
    (resolved.engine !== 'claude'
      ? getCodexAvailability(cwd)
      : getClaudeAvailability(
          'claude',
          { ...process.env, ...opts.connectionEnv, ...opts.credentialEnv },
          cwd,
        ));
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

  const addDirs = opts.addDirs ?? [];

  const taskId = opts.taskId ?? generateTaskId();
  const resume = opts.resume?.engine === resolved.engine ? opts.resume : undefined;
  const scratch = scratchDir(taskId);
  fs.mkdirSync(scratch, { recursive: true });
  restoreApprovals(resolveTaskDir(cwd, taskId), opts.approvals ?? []);
  const task = writeTask(cwd, taskId, {
    status: 'queued',
    ...(opts.taskId ? { dispatchId: randomUUID() } : {}),
    name: taskExtras.name ?? null,
    appendSystem: opts.appendSystem ?? null,
    promptParts: {
      cwd,
      ...opts.agentPrompt,
      appendSystem: opts.appendSystem ?? undefined,
      conversation: opts.conversation,
      local: process.env.CODER_MCP_MODE !== 'cloud',
      scratch,
      writes: resolved.access !== 'read-only',
      ...(opts.structured || opts.outputSchema ? { structured: true } : {}),
    },
    engine: resolved.engine,
    prompt: opts.prompt,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    model: resolved.model,
    effort: resolved.effort,
    access: resolved.access,
    resumeThreadId: resume?.threadId ?? null,
    ...(resume
      ? {
          threadId: resume.threadId,
          ...(resume.previousThreadIds ? { previousThreadIds: resume.previousThreadIds } : {}),
        }
      : {}),
    cwd,
    ...(opts.flowRunId ? { flowRunId: opts.flowRunId } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.conversation ? { conversation: true } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
    ...(opts.pullRequest !== undefined ? { pullRequest: opts.pullRequest } : {}),
    ...(opts.mcp?.length ? { mcp: opts.mcp } : {}),
    ...(opts.mcpBindings ? { mcpBindings: opts.mcpBindings } : {}),
    ...(opts.connections ? { connections: opts.connections } : {}),
    ...(opts.connectionSource ? { connectionSource: opts.connectionSource } : {}),
    nativeMcp: opts.nativeMcp ?? false,
    ...(addDirs.length ? { addDirs } : {}),
  });

  // Always run the task in a detached worker, so interrupting the caller never
  // kills the task.
  for (const message of new Set(opts.mcpWarnings ?? []))
    appendTaskLog(cwd, taskId, { kind: 'warning', message });
  if (opts.resume && !resume)
    appendTaskLog(cwd, taskId, { kind: 'warning', message: HISTORY_LOST });
  const logFile = path.join(resolveTaskDir(cwd, taskId), 'log.jsonl');
  const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const worker = spawnWorker(cwd, taskId, { ...opts.connectionEnv, ...opts.credentialEnv }, true);
  opts.onWorker?.(taskId, worker);

  if (!waitForStartup)
    return {
      taskId,
      task: loadTask(cwd, taskId) ?? task,
      engine: resolved.engine,
      startupCheck: 'pending',
    };

  const signal = watchTask(cwd, taskId, worker);
  const startupLines = createJsonlTail(logFile, logStart);
  let worked = false;
  let toolUsed = false;
  const working = () => {
    const entries = startupLines().map(line => {
      try {
        return JSON.parse(line) as TaskLogEntry;
      } catch {
        return { kind: 'unknown' };
      }
    });
    toolUsed ||= entries.some(entry => entry.kind === 'tool' || entry.kind === 'reply');

    return entries.some(
      entry => entry.phase !== 'starting' && !['status', 'usage'].includes(entry.kind ?? ''),
    );
  };
  const deadline = Date.now() + 15_000;
  let readyAt: number | undefined;
  let current = task;
  try {
    while (Date.now() < (readyAt === undefined ? deadline : readyAt + 5000)) {
      current = loadTask(cwd, taskId) ?? current;
      if (
        TERMINAL_STATUSES.includes(current.status) ||
        readTurnResults(cwd, taskId).at(-1)?.status === 0
      )
        break;
      if (pendingApprovals(resolveTaskDir(cwd, taskId)).length) break;
      worked = working() || worked;
      if (current.threadId) {
        readyAt ??= Date.now();
        if (worked) break;
      }
      await signal.wait(
        Math.min(30000, (readyAt === undefined ? deadline : readyAt + 5000) - Date.now()),
      );
    }
  } finally {
    signal.close();
  }

  if (current.status === 'failed') {
    working();
    // Turn errors (sandbox init, usage/auth) land in result.json, not the
    // progress log, so prefer it and fall back to the log tail.
    const resultFile = path.join(resolveTaskDir(cwd, taskId), 'result.json');
    const result = readJsonFile<TurnResult>(resultFile);
    const resultError = result?.error?.message ?? '';
    const logTail = readTaskLog(cwd, taskId, 5)
      .map(entry => entry.message ?? '')
      .join('\n');
    const detail = resultError || logTail;
    if (isSandboxFailure(resolved.access, detail)) {
      throw new CoderError('read-only-unavailable', detail);
    }
    if (isStartupError(detail) && !turnHasSideEffects(result, toolUsed)) {
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
  access: string,
  appendSystem: string | null | undefined,
  task: string,
): FallbackPayload {
  return {
    error: `${engine} failed to start: ${detail}`,
    fallback: {
      action: 'run-native-subagent',
      reason: 'no-engine-available',
      access,
      instructions:
        'Mention the engine failure to the user, including any limit reset time. If your harness has a native subagent facility, spawn one subagent with fallback.task verbatim, prefixed with: "NEVER run git write operations (commit, checkout, stash, reset, push, etc.); leave changes uncommitted." If fallback.access is "read-only", append: "Investigate and report without modifying anything." Relay its output when it completes. If your harness has no native subagent facility, report the failure and stop; do not implement the task yourself.',
      note: 'Every coder engine failed to start. Spawn your own native subagent and forward the task verbatim; tell it to never run git write operations (commit, checkout, stash, reset, push, ...) and to honor the access.',
      ...(appendSystem ? { appendSystem } : {}),
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
  internal: { waitForStartup?: boolean; config?: CoderConfig; models?: ResolvedTaskOptions[] } = {},
): Promise<DispatchResult> {
  if (process.env[WORKER_ENV]) {
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

  opts = { ...opts, addDirs: resolveAddDirs(opts.cwd, opts.addDirs) };
  const config = internal.config ?? loadConfig(opts.cwd);
  const mcp = selectMcpServers(opts.mcp, config.mcp);
  const dispatchOpts = {
    ...opts,
    mcp: mcp.mcp,
    mcpBindings: opts.mcpBindings ?? mcp.mcpBindings,
    mcpWarnings: [...(opts.mcpWarnings ?? []), ...(mcp.warnings ?? [])],
    nativeMcp: opts.nativeMcp ?? mcp.nativeMcp,
  };

  // The first attempt runs the request as asked, name included; each fallback model runs as listed.
  const list =
    internal.models ??
    modelList(
      config,
      resolveTaskOptions(
        { engine: opts.engine, model: opts.model, effort: opts.effort, access: opts.access },
        config,
      ),
    );
  let resolved = list[0]!;
  let taskExtras = {
    name: opts.name,
  };

  for (;;) {
    try {
      return await attemptOnce(
        config,
        resolved,
        dispatchOpts,
        taskExtras,
        internal.waitForStartup !== false,
      );
    } catch (error) {
      if (!(error instanceof FallbackSignal)) {
        throw error;
      }
      const next = nextModel(list, resolved);
      if (!next) {
        const payload = buildFallbackPayload(
          error.engine,
          error.detail,
          resolved.access,
          opts.appendSystem,
          opts.prompt,
        );
        throw new CoderError('chain-exhausted', payload.error, { payload });
      }
      opts.onFallback?.({
        model: formatEngineSpec(resolved),
        detail: error.detail,
        next: formatEngineSpec(next),
      });
      resolved = next;
      taskExtras = {
        name: undefined,
      };
    }
  }
}

/** The models a task tries in order: its first, then the chain without it and without disabled or unrunnable models. */
export function modelList(config: CoderConfig, first: ResolvedTaskOptions): ResolvedTaskOptions[] {
  const list = [first];
  for (const spec of config.chain) {
    try {
      const next = resolveTaskOptions({ model: spec, access: first.access }, config);
      if (!list.some(listed => sameModel(listed, next))) list.push(next);
    } catch {}
  }

  return list;
}

/** The model after `current` in a task's list; undefined at its end. */
export function nextModel(
  list: ResolvedTaskOptions[],
  current: { engine: Engine; model: string | null },
): ResolvedTaskOptions | undefined {
  return list[Math.max(0, list.findIndex(listed => sameModel(listed, current))) + 1];
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

function turnHasSideEffects(result: TurnResult | null, toolUsed = false): boolean {
  return Boolean(
    toolUsed ||
    (result?.fileChanges as unknown[] | undefined)?.length ||
    (result?.commandExecutions as unknown[] | undefined)?.length,
  );
}

/** Whether a failed turn did no work, so it may run again on the next credential or model. */
export function turnMayFallBack(cwd: string, waited: TaskResult): boolean {
  if (waited.status !== 'failed') return false;
  const r = waited.result;
  if (!r || !isStartupError(r.error?.message ?? '')) return false;
  const since = Date.parse(
    waited.turns.at(-2)?.at ?? waited.task.resumedAt ?? waited.task.createdAt,
  );
  const toolUsed = readTaskLog(cwd, waited.taskId, Number.MAX_SAFE_INTEGER).some(
    entry =>
      (entry.kind === 'tool' || entry.kind === 'reply') &&
      (!entry.at || Date.parse(entry.at) >= since),
  );

  return !turnHasSideEffects(r, toolUsed) && !waited.turns.at(-1)?.lastReply;
}

/** The model after a failed turn that did no work, from the task's list; null at its end, undefined when the turn may not fall back. */
export function turnFallbackModel(
  cwd: string,
  waited: TaskResult,
  list: ResolvedTaskOptions[],
): ResolvedTaskOptions | null | undefined {
  if (!turnMayFallBack(cwd, waited)) return undefined;
  return (
    nextModel(list, { engine: waited.task.engine as Engine, model: waited.task.model ?? null }) ??
    null
  );
}

export function readResultJson(cwd: string, taskId: string, task?: Task): TurnResult | null {
  // A task-level failure has no engine result; the file still belongs to the previous turn.
  if (task && (ACTIVE_STATUSES.includes(task.status) || (task.status === 'failed' && task.error)))
    return null;
  // Tolerates a missing or truncated file (worker crash mid-write).
  return readJsonFile<TurnResult>(path.join(resolveTaskDir(cwd, taskId), 'result.json'));
}

// The last `tail` log entries ('all' for the whole transcript; default 0: none).
function readSteps(cwd: string, taskId: string, tail: number | 'all' = 0): TaskLogEntry[] {
  if (tail === 0) return [];
  const all = readTaskLog(cwd, taskId, Number.MAX_SAFE_INTEGER);
  return tail === 'all' ? all : tailSteps(all, tail);
}

/** Read a task's state and result.json without waiting. `tail` fills `steps`; `task` is the snapshot to judge by (a wait's), so a next turn starting meanwhile does not hide the finished one's result. */
export function readTask(
  cwd: string,
  taskId: string,
  opts: { tail?: number | 'all'; task?: Task } = {},
): TaskResult {
  const task = opts.task ?? loadTask(cwd, taskId);
  if (!task) {
    throw new Error(`No task found for "${taskId}".`);
  }
  return {
    taskId,
    status: task.status,
    // A running task's result.json is a previous turn's (a resumed task).
    result: readResultJson(cwd, taskId, task),
    steps: readSteps(cwd, taskId, opts.tail),
    turns: readTurnResults(cwd, taskId),
    task,
  };
}

interface WaitOptions {
  turn?: number;
  worker?: ChildProcess;
  signal?: AbortSignal;
  /** Approvals the caller already surfaced; a task with only these pending reads terminal. */
  seen?: string[];
}

/**
 * Block until a task reaches a terminal state, then return its TurnResult.
 * A pending approval surfaces as a CoderError (code approval-pending), not exit 4.
 */
export async function waitTask(
  cwd: string,
  taskId: string,
  opts: WaitOptions & { tail?: number | 'all'; onSettle?: () => void } = {},
): Promise<TaskResult> {
  const task = loadTask(cwd, taskId);
  if (!task) {
    throw new Error(`No task found for "${taskId}".`);
  }
  const outcome = await waitForTaskAttention(cwd, task, 1000, opts);
  if (outcome.reason === 'approval') {
    const approval = outcome.approval!;
    throw new CoderError(
      'approval-pending',
      `Approval needed for task ${taskId}: ${approval.reason}`,
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
    result: readResultJson(cwd, taskId, final),
    steps: readSteps(cwd, taskId, opts.tail),
    turns: readTurnResults(cwd, taskId),
    task: final,
  };
}

export { isStartupError, isSandboxFailure };

/** A pending approval as a wait surfaces it. */
interface PendingApproval {
  id: string;
  reason: string;
  actions: string[];
}

interface WaitOutcome {
  task: Task;
  reason: 'terminal' | 'approval';
  approval?: PendingApproval;
}

/**
 * Blocking wait shared by `run --wait` and `result --wait`. Returns when the task finishes OR
 * a pending approval appears, so a --wait surfaces the approval (answered out of band with
 * `coder task approve`) while the task keeps working.
 */
export async function waitForTaskAttention(
  cwd: string,
  task: Task,
  pollMs = 1000,
  { turn, worker, signal: abort, seen = [] }: WaitOptions = {},
): Promise<WaitOutcome> {
  let current = task;
  const signal = watchTask(cwd, task.id, worker);
  try {
    const startMs = processStarts();
    for (;;) {
      abort?.throwIfAborted();
      current = loadTask(cwd, current.id) ?? current;
      const result = turn === undefined ? undefined : readTurnResults(cwd, current.id)[turn];
      if (result) current = { ...current, status: result.status === 0 ? 'completed' : 'failed' };
      else current = reconcileTask(cwd, current, startMs);
      // Before a terminal return: a task can escalate and end its turn between two polls.
      const pending = pendingApprovals(resolveTaskDir(cwd, current.id)).find(
        approval => !seen.includes(approval.id),
      );
      if (pending) {
        return {
          task: current,
          reason: 'approval',
          approval: { id: pending.id, reason: pending.reason, actions: pending.actions },
        };
      }
      if (
        TERMINAL_STATUSES.includes(current.status) &&
        (turn !== undefined || !turnPending(cwd, current))
      )
        return { task: current, reason: 'terminal' };
      await signal.wait(pollMs, abort);
    }
  } finally {
    signal.close();
  }
}
