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
  tailSteps,
  writeTask,
  type TaskLogEntry,
  type TurnResultEntry,
  reconcileTask,
  processStarts,
} from './state';
import { createJsonlTail, readJsonFile } from '../utils/fsx';
import { getCodexAvailability } from './engines/codex';
import { isUnsupportedModelError } from './engines/codex/errors';
import { claudeVersionEnvironment, getClaudeAvailability } from './engines/claude';
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
  type TurnResult,
  ACTIVE_STATUSES,
  HISTORY_LOST,
  TERMINAL_STATUSES,
} from './types';
import { listPendingApprovals } from './approvals';
import { mcpApproved, mcpWarnings } from './mcp';
import {
  FALLBACK_INSTRUCTIONS,
  FALLBACK_NOTE,
  taskSystemPrompt,
  type AgentPromptParts,
} from './prompts';

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
  const expandAlias = (name: string) => {
    try {
      return parseEngineSpec(name, config);
    } catch (error) {
      throw new CoderError(
        'invalid-option',
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  if (aliasEntry(modelInput)) {
    const parsed = expandAlias(modelInput!);
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
    const parsed = expandAlias(model!);
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
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  name?: string | null;
  system?: string | null;
  /** The agent's part of the engine's system prompt. */
  agentPrompt?: AgentPromptParts;
  wait?: boolean;
  simulateApproval?: boolean;
  /** Tags the created task as belonging to a flow run (for `coder list` grouping). */
  flowRunId?: string;
  agentId?: string;
  /** A conversation's task, whose history rolls over past the context budget. */
  conversation?: boolean;
  source?: string;
  /** Handle an agent task posts as. */
  author?: string;
  /** Repository an agent task's event came from. */
  repo?: string;
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
  /** Called with (engine, detail, next) when an engine falls through the chain. */
  onFallback?: (info: { engine: Engine; detail: string; next: Engine }) => void;
  /** Called with a note when a missing codex binary is installed on the spot. */
  onNote?: (note: string) => void;
  /** A durable local delivery retries the same task. */
  taskId?: string;
  /** An engine conversation and its chain to continue, used only when the task runs on that engine. */
  resume?: Pick<Task, 'previousThreadIds' | 'pendingRollover'> & {
    engine: string;
    threadId: string;
  };
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

export interface DispatchResult {
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
  connectionEnv: Record<string, string> = {},
  checked = false,
): ChildProcess {
  const taskDir = resolveTaskDir(cwd, taskId);
  const logFd = fs.openSync(path.join(taskDir, 'worker.log'), 'a');
  const env = { ...process.env, ...connectionEnv };
  processTiming('worker.spawn', { taskId });
  const child = spawn(process.execPath, [CLI_PATH, 'task', 'worker', taskId, '--cwd', cwd], {
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
  child.on('error', () => {});
  child.unref();
  child.channel?.unref?.();
  fs.closeSync(logFd);
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
    simulateApproval?: boolean;
  },
  waitForStartup: boolean,
): Promise<DispatchResult> {
  const cwd = opts.cwd;

  // Startup gate: cheap checks before creating a task.
  let availability =
    opts.availability?.[resolved.engine === 'custom' ? 'codex' : resolved.engine] ??
    (resolved.engine !== 'claude'
      ? getCodexAvailability(cwd)
      : getClaudeAvailability('claude', { ...process.env, ...opts.connectionEnv }, cwd));
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
  const task = writeTask(cwd, taskId, {
    status: 'queued',
    ...(opts.taskId ? { dispatchId: randomUUID() } : {}),
    name: taskExtras.name ?? null,
    system: opts.system ?? null,
    systemPrompt: taskSystemPrompt({
      ...opts.agentPrompt,
      instructions: opts.system ?? undefined,
      conversation: opts.conversation,
      agent: Boolean(opts.agentId),
      local: process.env.CODER_MCP_MODE !== 'cloud',
    }),
    engine: resolved.engine,
    prompt: opts.prompt,
    ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
    model: resolved.model,
    effort: resolved.effort,
    permissions: resolved.permissions,
    resumeThreadId: resume?.threadId ?? null,
    ...(resume
      ? {
          threadId: resume.threadId,
          ...(resume.previousThreadIds ? { previousThreadIds: resume.previousThreadIds } : {}),
          ...(resume.pendingRollover ? { pendingRollover: resume.pendingRollover } : {}),
        }
      : {}),
    cwd,
    ...(taskExtras.simulateApproval ? { simulateApproval: true } : {}),
    ...(opts.flowRunId ? { flowRunId: opts.flowRunId } : {}),
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    ...(opts.conversation ? { conversation: true } : {}),
    ...(opts.source ? { source: opts.source } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    ...(opts.repo ? { repo: opts.repo } : {}),
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
  const worker = spawnWorker(cwd, taskId, opts.connectionEnv, true);
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
    if (isSandboxFailure(resolved.permissions, detail)) {
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
      instructions: FALLBACK_INSTRUCTIONS,
      note: FALLBACK_NOTE,
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
  internal: { fromMailbox?: boolean; waitForStartup?: boolean; config?: CoderConfig } = {},
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

  // First attempt uses the full request (model/effort/name/simulate).
  // A chain fallback re-resolves fresh for the next engine, deliberately dropping
  // model, effort, and name. The next engine uses its own config default.
  let resolveInput: Record<string, any> = {
    engine: opts.engine,
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
  };
  let taskExtras = {
    name: opts.name,
    simulateApproval: opts.simulateApproval,
  };

  for (;;) {
    const resolved = resolveTaskOptions(resolveInput, config);
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
      const next = nextFallbackEngine(error.engine, config);
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

function nextFallbackEngine(engine: Engine, config: CoderConfig): Engine | undefined {
  return config.chain.slice(config.chain.indexOf(engine) + 1).find(next =>
    next !== 'custom' || Object.values(config.models ?? {}).some(isEndpointModel),
  );
}

function turnHasSideEffects(result: TurnResult | null, toolUsed = false): boolean {
  return Boolean(
    toolUsed ||
    result?.touchedFiles?.length ||
    (result?.fileChanges as unknown[] | undefined)?.length ||
    (result?.commandExecutions as unknown[] | undefined)?.length,
  );
}

/** The next engine for a failed turn that did no work; null means its chain is exhausted. */
export function turnFallbackEngine(
  cwd: string,
  waited: TaskResult,
  config?: CoderConfig,
): Engine | null | undefined {
  if (waited.status !== 'failed') return undefined;
  const r = waited.result;
  if (!r || !isStartupError(r.error?.message ?? '')) return undefined;
  const since = Date.parse(
    waited.turns.at(-2)?.at ?? waited.task.resumedAt ?? waited.task.createdAt,
  );
  const toolUsed = readTaskLog(cwd, waited.taskId, Number.MAX_SAFE_INTEGER).some(
    entry =>
      (entry.kind === 'tool' || entry.kind === 'reply') &&
      (!entry.at || Date.parse(entry.at) >= since),
  );
  if (turnHasSideEffects(r, toolUsed)) return undefined;
  if (waited.turns.at(-1)?.lastReply) return undefined;
  return nextFallbackEngine(waited.task.engine as Engine, config ?? loadConfig(cwd)) ?? null;
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

interface WaitOptions {
  turn?: number;
  worker?: ChildProcess;
  rollover?: boolean;
  signal?: AbortSignal;
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
  pollMs = 1000,
  { turn, worker, rollover = false, signal: abort }: WaitOptions = {},
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
      if (rollover ? !current.rollingOver : TERMINAL_STATUSES.includes(current.status)) {
        return { task: current, reason: 'terminal' };
      }
      const pending = listPendingApprovals(resolveTaskDir(cwd, current.id)).find(a => !a.response);
      if (pending) {
        const params = pending.params as
          { networkApprovalContext?: { host?: string | null } | null } | undefined;
        return {
          task: current,
          reason: 'approval',
          approval: {
            id: pending.id,
            summary: String(pending.summary ?? ''),
            cwd: typeof pending.cwd === 'string' ? pending.cwd : null,
            networkHost: params?.networkApprovalContext?.host ?? null,
          },
        };
      }
      await signal.wait(pollMs, abort);
    }
  } finally {
    signal.close();
  }
}
