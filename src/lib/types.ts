/**
 * Shared domain types for the coder runtime. Kept in one place so the CLI, the
 * config layer, the state store, and the engine adapters all agree on the shape
 * of a job, a config, and a turn result.
 */

export type Agent = 'codex' | 'claude';
export type Permission = 'read-only' | 'workspace-write' | 'auto';
export type Effort = 'low' | 'medium' | 'high';
export type Host = 'codex' | 'claude' | 'cursor';
export type JobKind = 'task';
export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

/** Per-agent defaults from config (all optional; merged over DEFAULT_CONFIG). */
export interface AgentConfig {
  model?: string;
  effort?: Effort;
  permissions?: Permission;
}

export interface ApprovalsConfig {
  escalationTimeoutMs: number;
  allowedNetworkHosts: string[];
}

/** The merged, effective configuration returned by loadConfig. */
export interface CoderConfig {
  chain: Agent[];
  agents: { codex?: AgentConfig; claude?: AgentConfig };
  approvals: ApprovalsConfig;
}

/** A persisted job record (job.json). Most fields accrete over the lifecycle. */
export interface Job {
  id: string;
  createdAt: string;
  updatedAt?: string;
  status: JobStatus;
  kind?: JobKind;
  name?: string | null;
  agent?: Agent;
  host?: Host;
  prompt?: string;
  model?: string | null;
  effort?: Effort | null;
  permissions?: Permission;
  resumeThreadId?: string | null;
  cwd?: string;
  background?: boolean;
  pid?: number | null;
  threadId?: string | null;
  turnId?: string | null;
  completedAt?: string;
  error?: string;
  archived?: boolean;
  archivedAt?: string;
  // Dev hook (--simulate-approval): the worker raises one real pending approval
  // before running, to exercise the escalate -> --wait exit 4 -> approve loop.
  simulateApproval?: boolean;
}

export const TERMINAL_STATUSES: readonly JobStatus[] = ['completed', 'failed', 'cancelled'];
export const ACTIVE_STATUSES: readonly JobStatus[] = ['queued', 'running'];

/** Task options after resolving CLI flags against config defaults. */
export interface ResolvedTaskOptions {
  agent: Agent;
  model: string | null;
  effort: Effort | null;
  permissions: Permission;
}

/** A single progress update emitted during a turn (string or structured). */
export type ProgressUpdate =
  | string
  | {
      message?: string;
      kind?: string;
      threadId?: string | null;
      turnId?: string | null;
      [key: string]: unknown;
    };

/** Normalized token usage for one turn, summed across the engine's threads. */
export interface TokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  total: number;
}

/** The outcome of running one engine turn. status 0 == success. */
export interface TurnResult {
  status: number;
  threadId: string | null;
  turnId?: string | null;
  finalMessage?: string;
  touchedFiles?: string[];
  tokens?: TokenUsage | null;
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

/** A persisted approval escalation and its answer, if any. */
export interface Approval {
  id: string;
  summary: string;
  createdAt?: string;
  response?: { decision: string } | null;
  [key: string]: unknown;
}

/** ANSI styler returned by makeStyle; each fn wraps text in a color/attr. */
export type Painter = (text: string) => string;
export interface Style {
  bold: Painter;
  cyan: Painter;
  dim: Painter;
  green: Painter;
  red: Painter;
}

/** A [flag-or-command, description] pair rendered in help tables. */
export type HelpRow = [string, string];

/** Help metadata for one command. */
export interface CommandHelpSpec {
  list: HelpRow;
  usage: string;
  summary?: string;
  flags?: HelpRow[];
  examples?: HelpRow[];
  seeAlso?: string;
}

/** A subcommand handler. Receives the argv slice after the command name. */
export type CommandHandler = (argv: string[]) => Promise<void> | void;
