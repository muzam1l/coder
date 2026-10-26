/** Shared domain types and config defaults; type-only imports, so the dashboard reads it at runtime. */

// Config domain types are inferred from the zod schemas in config.ts.
import type { Access, CoderConfig, Engine, Effort } from './config';
import type { TokenUsage } from './task/view';
import type { SystemPromptParts } from './task/context/system';
export type { TokenUsage } from './task/view';

export type {
  Engine,
  CoderConfig,
  CustomModelConfig,
  Effort,
  ModelEntry,
  Access,
} from './config';

/** Built-in config every file and flag merges over; import-free so the shipped dashboard can read it. */
export const DEFAULT_CONFIG: CoderConfig = {
  // Models are tried in order; the first is the default, each next one the fallback
  // when the one before fails to start (missing binary, auth, quota, rate limit).
  version: 1,
  chain: ['codex/sol', 'claude/opus'],
  reviewModel: 'codex/astra/medium',
  models: {},
  network: {
    allowedHosts: [],
  },
};

/** RFC 7396 merge patch: objects merge, null deletes, anything else replaces; `__proto__` stays a plain key. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const result: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? Object.fromEntries(Object.entries(target))
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else
      Object.defineProperty(result, key, {
        value: mergePatch(Object.hasOwn(result, key) ? result[key] : undefined, value),
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  return result as T;
}

export const NOT_REINVOKED = 'Background processes will not re-invoke you.';
export const SHELL_WAIT =
  'Wait on each task with `coder task result <task-id> --wait` in its own background shell, one per task, never several tasks in one call, so each approval and answer reaches you.';

/** An extra MCP server attached to a task, with the tools the engine may call. */
/** One MCP server in the `.mcp.json` entry shape: stdio (`command`) or remote (`url`). */
export interface McpServerSpec {
  name: string;
  connection?: string;
  repository?: boolean;
  resolved?: boolean;
  gitCredential?: boolean;
  command?: string;
  args?: string[];
  /** Values may hold `${VAR}` placeholders, resolved from the environment at spawn time. */
  env?: Record<string, string>;
  /** Remote server, streamable HTTP. */
  url?: string;
  type?: 'stdio' | 'http';
  headers?: Record<string, string>;
  /** Credential destination supplied by the connection resolver, removed before persistence. */
  credentialFields?: { env?: string; header?: string };
  /** Where `connection`'s token goes; the tool search asks for it on first use. */
  credentialOnUse?: { env?: string; header?: string };
  /** When `connection` was created; its token is given only to the same row at the same `url`. */
  connectionCreatedAt?: number;
  /** Tool allowlist; omit or empty for every tool the server offers. */
  tools?: string[];
  /** Schemas load before the first prompt instead of behind tool search or the hub. */
  alwaysLoad?: boolean;
  /** When the tool search connects it: at turn start, its instructions and tool names in the prompt, or on first use (default). */
  connect?: 'start' | 'first-use';
  /** Only tools the server marks read-only may be called. */
  readOnly?: boolean;
  /** The integration a platform tool server reaches, and the account of its installation. */
  integration?: string;
  account?: string;
  /** A personal connection's member, as `Connection.owner`; its first use asks them. */
  owner?: string;
  /** One line naming the server's identity and what it reaches, as the tool search lists it. */
  description?: string;
  /** What the server's tools do; shown before the server's own instructions. On an `alwaysLoad` server, the instructions it serves. */
  instructions?: string;
  access?: Access;
}

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** A persisted task record (task.json). Most fields accrete over the lifecycle. */
export interface Task {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: TaskStatus;
  name?: string | null;
  // custom runs on the codex runtime.
  engine?: Engine;
  prompt?: string;
  outputSchema?: object;
  // The prompt of the active (resumed/steered) turn. `prompt` always keeps the
  // task's original text; follow-ups run from here so they never displace it.
  currentPrompt?: string | null;
  // Standing instructions appended to the system prompt (--append-system), kept
  // separate from the task prompt so previews (list/result/stream) show only the task itself.
  appendSystem?: string | null;
  // What the engine's system prompt says, rendered on every turn with the task's servers.
  promptParts?: SystemPromptParts;
  // A system prompt as given, for a task without promptParts.
  systemPrompt?: string;
  model?: string | null;
  effort?: Effort | null;
  access?: Access;
  resumeThreadId?: string | null;
  cwd?: string;
  pid?: number | null;
  dispatchId?: string;
  threadId?: string | null;
  previousThreadIds?: string[];
  steerClosed?: boolean;
  // The process preparing a resumed worker, before its pid is published.
  resumeOwner?: number;
  // A conversation's task (an agent's default flow).
  conversation?: boolean;
  turnId?: string | null;
  // Ephemeral worker-owned endpoint used for live Codex controls or Claude
  // stream-json input. Cleared as soon as that turn stops accepting controls.
  steerEndpoint?: string | null;
  turnUsage?: Array<Pick<TurnResult, 'tokens' | 'model'> & { at: string }>;
  completedAt?: string;
  resumedAt?: string;
  error?: string;
  fallbacks?: Array<{ model: string; detail: string; next: string }>;
  archived?: boolean;
  archivedAt?: string;
  // Archived by the auto-archive sweep, which lists take up on their next read rather than as an event.
  autoArchived?: boolean;
  // Set when this task was dispatched by a flow run; groups it under the run in
  // `coder list`.
  flowRunId?: string;
  // The agent definition it ran as (`--agent`), and who started it on a local server: `dashboard` or an event's platform.
  agentId?: string;
  source?: string;
  // Handle an agent task posts as; the worker's platform actions trust only its comments.
  author?: string;
  // Repository the agent task's event came from; the worker's platform actions stay inside it.
  repo?: string;
  // The event's pull request, which a read-only task may review as the app.
  pullRequest?: number;
  // Extra MCP servers (and their allowed tools) the worker attaches to the turn.
  mcp?: McpServerSpec[];
  mcpBindings?: Pick<McpServerSpec, 'name' | 'connection' | 'tools'>[];
  connections?: string[];
  connectionSource?: 'local' | 'server';
  nativeMcp?: boolean;
  // Absolute extra directories the task may reach beyond cwd (--add-dir).
  addDirs?: string[];
}

/** The error a task stopped by `coder task stop` or the dashboard records. */
export const STOPPED_BY_USER = 'Stopped by user.';
export const TERMINAL_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];
export const ACTIVE_STATUSES: readonly TaskStatus[] = ['queued', 'running'];
/** Logged when a resumed turn cannot load its engine conversation and starts a new one. */
export const HISTORY_LOST = 'History lost, starting fresh';
export const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** Task options after resolving CLI flags against config defaults. */
export interface ResolvedTaskOptions {
  /** codex, claude, or custom. */
  engine: Engine;
  model: string | null;
  effort: Effort | null;
  access: Access;
}

/**
 * Semantic type of a progress-log entry. Engines tag every update with one so
 * the text views can group, indent, and shade them; untagged entries render as
 * plain status lines.
 */
export type LogKind =
  | 'status' // lifecycle: thread ready, turn started/completed
  | 'assistant' // assistant prose
  | 'reasoning' // thinking summary
  | 'tool' // a tool call, command, or file change
  | 'tool-result' // its output
  | 'usage' // running token usage
  | 'steer'
  | 'error'
  | 'info';

/** A single progress update emitted during a turn (string or structured). */
export type ProgressUpdate =
  | string
  | {
      message?: string;
      kind?: LogKind | string;
      threadId?: string | null;
      turnId?: string | null;
      [key: string]: unknown;
    };

/** The outcome of running one engine turn. status 0 == success. */
export interface TurnResult {
  status: number;
  threadId: string | null;
  turnId?: string | null;
  finalMessage?: string;
  tokens?: TokenUsage | null;
  contextTokens?: number;
  /** The model that ran the turn (tokens are only comparable per model). */
  model?: string | null;
  error?: { message?: string } | null;
  [key: string]: unknown;
}

/** Whether an engine binary is installed and usable. */
export interface Availability {
  available: boolean;
  detail: string;
}

/** Whether an engine is authenticated. */
export interface AuthStatus {
  loggedIn: boolean;
  detail: string;
}

/** A task's escalation and its answer, if any. */
export interface Approval {
  id: string;
  /** One short sentence: what the actions are for. */
  reason: string;
  /** The exact commands; one answer covers them all. */
  actions: string[];
  createdAt?: string;
  /** `by` names who answered; `deliveredAt` is set once the task has the decision; `closed` when the task was stopped first. */
  response?: {
    decision: 'accept' | 'decline' | 'closed';
    reason?: string;
    answeredAt?: string;
    by?: string;
    deliveredAt?: string;
  } | null;
  [key: string]: unknown;
}

/** ANSI styler returned by makeStyle; each fn wraps text in a color/attr. */
export type Painter = (text: string) => string;
export interface Style {
  blue: Painter;
  bold: Painter;
  cyan: Painter;
  dim: Painter;
  /** A brighter second shade of dim. */
  light: Painter;
  green: Painter;
  red: Painter;
  yellow: Painter;
}
