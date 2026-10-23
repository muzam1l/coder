/** The task API the CLI and the SDK share: each call works on this machine's tasks, or on a Coder server with `server`. */
import type { ServerOptions } from '../remote';
import type { Access } from '../config';
import type { readTask } from '../dispatch';
import type { readTurnResults, TaskLogEntry } from '../state';
import type { Task, TokenUsage } from '../types';
import type { SteerOutcome } from './actions';
import {
  approvals,
  approve,
  archive,
  ask,
  list,
  remove,
  result,
  run,
  steer,
  stop,
  stream,
  watch,
} from './actions';

/** Where a task call runs: this machine's tasks under `cwd`, or the server named by `server`. */
export type TaskOptions = { cwd?: string } & ServerOptions;

export interface TaskRunOptions {
  /** Run as a local agent; the other options override its definition. */
  agent?: string;
  outputSchema?: object;
  model?: string;
  access?: Access;
  name?: string;
  appendSystem?: string;
  /** Extra directories the task may reach, resolved against cwd. */
  addDirs?: string[];
  /** MCP servers to attach, by name from config. */
  mcp?: string;
  /** Connection ids the task may use, within the agent's. */
  connections?: string[];
  /** Block until the task finishes, falling back to the next model when a turn fails to start. */
  wait?: boolean;
  /** Server tasks: the repository and runner to use. */
  repo?: string;
  runner?: string;
  onFallback?: (fallback: { model: string; detail: string; next: string }) => void;
  onNote?: (note: string) => void;
  /** Each time a wait starts on a task id. */
  onWaiting?: (taskId: string) => void;
}

export interface RunResult {
  taskId: string;
  status: string;
  startupCheck?: 'passed' | 'pending';
  commands?: Record<'result' | 'steer' | 'stop' | 'list', string>;
  finalMessage?: string | null;
  error?: string;
  tokens?: TokenUsage | null;
  model?: string | null;
}

export interface TaskInspection {
  taskId: string;
  status: string;
  task: Task;
  result: ReturnType<typeof readTask>['result'];
  steps: TaskLogEntry[];
  turns: ReturnType<typeof readTurnResults>;
  pendingApprovals: Array<{ id: string; reason: string; actions: string[] }>;
  /** While running: time since the last sign of life, and whether it looks stalled. */
  idleMs?: number;
  lastActivityAt?: string | null;
  stalled?: boolean;
  /** While running: the last progress entry and the latest token snapshot. */
  lastLog?: TaskLogEntry;
  liveTokens?: TokenUsage | null;
}

export interface TaskRow {
  taskId: string;
  status: Task['status'] | 'waiting-approval';
  pendingApprovals: number;
  engine: string | null;
  model: string | null;
  effort: string | null;
  name: string | null;
  cwd: string | null;
  prompt: string;
  updatedAt: string | undefined;
  archived: boolean;
  flowRunId: string | null;
  idleMs: number | null;
}

/** One page of tasks; `next` continues it, and `archived` counts archived tasks when a default view is empty. */
export interface TaskPage {
  items: TaskRow[] & { archived: number };
  next?: string;
}

export interface TaskWatch {
  task: Task;
  /** Progress entries as they land, ending when the task is terminal. */
  events: AsyncGenerator<TaskLogEntry>;
  /** The task once the stream ends. */
  final(): Promise<{ taskId: string; status: string; result: any; task: Task }>;
}

export interface SteerResult {
  taskId: string;
  steered: SteerOutcome;
  /** With `wait`, once a live or resumed turn finishes. */
  status?: string | null;
  finalMessage?: string | null;
}

/** Ask about a task through a read-only sidecar; its thread is never touched. */
export interface AskResult {
  taskId: string;
  answer: string | null;
  error?: string;
  ok: boolean;
}

export interface ApprovalRow {
  taskId: string;
  id: string;
  reason: string;
  actions: string[];
  createdAt?: string;
  answered?: 'accept' | 'decline' | 'closed' | null;
  deniedReason?: string | null;
  /** A change request's scope and who approves it. */
  scope?: string;
  approvers?: string;
}

/** Run and control coder tasks. */
export const tasks = {
  run,
  result,
  list,
  watch,
  stream,
  steer,
  ask,
  approvals,
  approve,
  stop,
  archive,
  delete: remove,
};
