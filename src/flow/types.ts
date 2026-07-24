/** Internal flow-runtime types. See docs/flows.md for the contract. */
import type { TokenUsage } from '../lib/types.js';

/** Anything with zod's parse shape; the flow runtime never imports zod itself. */
export interface FlowSchema<T> {
  parse(value: unknown): T;
}

export interface FlowTaskResult<T = unknown> {
  taskId: string;
  status: string;
  output: string;
  data?: T;
  tokens: TokenUsage | null;
  model: string | null;
}

export interface GateResult {
  ok: boolean;
  code: number;
  output: string;
}

/** Options shared with `coder run`, plus `returns`. */
export interface FlowTaskOptions<T = unknown> {
  agent?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  name?: string;
  system?: string;
  resume?: string;
  cwd?: string;
  returns?: FlowSchema<T>;
}

export type FlowRunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'stopped';

/**
 * One line of a run's events.jsonl: a hook payload tagged with its kind. The
 * attached orchestrator appends these; `flow stream` / `flow.stream()` replay
 * and follow them.
 */
export type FlowEvent =
  | { kind: 'task-start'; taskId: string; name?: string; prompt: string; agent?: string; depth?: number }
  | { kind: 'task-end'; taskId: string; status: string; tokens: TokenUsage | null }
  | { kind: 'gate-start'; gateId: string; cmd: string; depth?: number }
  | { kind: 'gate'; gateId?: string; cmd: string; ok: boolean; code: number; depth?: number }
  | { kind: 'log'; message: string; depth?: number }
  | { kind: 'flow-start'; name: string; depth: number }
  | { kind: 'replay'; count: number };

export interface JournalEntry {
  seq: number;
  kind: 'task' | 'gate' | 'flow';
  fingerprint: string;
  result: unknown;
  taskId?: string;
  tokens?: TokenUsage | null;
  startedAt: string;
  endedAt: string;
}

/** flow.json: the persisted run record. */
export interface FlowRecord {
  runId: string;
  name: string;
  script: string;
  args: unknown;
  status: FlowRunStatus;
  startedAt: string;
  endedAt?: string;
  /** Orchestrator process while status is running; cleared on every terminal write. */
  pid?: number;
  pidStartedAt?: string;
  concurrency: number;
  maxTasks: number;
  taskCount: number;
  ledger: Record<string, TokenUsage>;
  result?: unknown;
  error?: string;
  /** Hidden from the default list; set by auto-archive or `flow archive`. */
  archived?: boolean;
  archivedAt?: string;
}

/** One `flow result` step row: a journaled task with its current status. */
export interface FlowStep {
  taskId: string | null;
  name: string | null;
  status: string;
  tokens: TokenUsage | null;
}

export interface DiscoveredFlow {
  name: string;
  path: string;
  scope: 'workspace' | 'global';
}
