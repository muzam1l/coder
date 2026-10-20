/**
 * Shared domain types for the coder runtime. Kept in one place so the CLI, the
 * config layer, the state store, and the engine adapters all agree on the shape
 * of a task, a config, and a turn result.
 */

// Config domain types are inferred from the zod schemas in config.ts.
import type { Engine, Effort, Permission } from './config';
import type { TokenUsage } from './task/log-view';
import type { SystemPromptParts } from './task/context/system';
export type { TokenUsage } from './task/log-view';

export type {
  Engine,
  EngineConfig,
  AliasModelConfig,
  ApprovalsConfig,
  CoderConfig,
  CustomModelConfig,
  Effort,
  ModelEntry,
  Permission,
} from './config';

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
  /** Tool allowlist; omit or empty for every tool the server offers. */
  tools?: string[];
  /** Schemas load before the first prompt instead of behind tool search or the hub. */
  alwaysLoad?: boolean;
  /** Only tools the server marks read-only may be called. */
  readOnly?: boolean;
  /** The integration a platform tool server reaches, and the account of its installation. */
  integration?: string;
  account?: string;
  /** What the server reaches and the access it allows, as the prompt lists it. */
  description?: string;
  access?: 'read' | 'write';
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
  promptParts?: Omit<SystemPromptParts, 'servers'>;
  // A system prompt as given, for a task without promptParts.
  systemPrompt?: string;
  model?: string | null;
  effort?: Effort | null;
  permissions?: Permission;
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
  fallbacks?: Array<{ engine: Engine; detail: string; next: Engine }>;
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

/** Task options after resolving CLI flags against config defaults. */
export interface ResolvedTaskOptions {
  /** codex, claude, or custom; also the chain position. */
  engine: Engine;
  model: string | null;
  effort: Effort | null;
  permissions: Permission;
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
