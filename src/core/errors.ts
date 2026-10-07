/** The run-native-subagent fallback payload the CLI prints on exit 3. */
export interface FallbackPayload {
  error: string;
  fallback: {
    action: 'run-native-subagent';
    reason: 'no-engine-available';
    permissions: string;
    instructions: string;
    note: string;
    system?: string;
    task: string;
  };
}

/** Recoverable errors with CLI exit codes. */
export type CoderErrorCode =
  | 'nested-dispatch'
  | 'invalid-option'
  | 'read-only-unavailable'
  | 'startup-failed'
  | 'chain-exhausted'
  | 'approval-pending'
  | 'task-failed'
  | 'flow-failed'
  /** A Coder server refused or failed a request; `status` carries the HTTP status. */
  | 'server'
  /** Sign-in to a server did not complete. */
  | 'login-failed';

export class CoderError extends Error {
  code: CoderErrorCode;
  hint?: string | string[];
  taskId?: string;
  /** chain-exhausted: the run-native-subagent payload the CLI prints on exit 3. */
  payload?: FallbackPayload;
  /** approval-pending: the approval to answer. */
  approval?: {
    id: string;
    summary: string;
    cwd?: string | null;
    networkHost?: string | null;
  };
  /** task-failed (flow task()): the failed task's result. */
  result?: unknown;
  /** flow-failed: the run to resume. */
  runId?: string;
  /** server: the HTTP status the server answered with. */
  status?: number;
  constructor(
    code: CoderErrorCode,
    message: string,
    extra: {
      hint?: string | string[];
      taskId?: string;
      payload?: FallbackPayload;
      approval?: {
        id: string;
        summary: string;
        cwd?: string | null;
        networkHost?: string | null;
      };
      result?: unknown;
      runId?: string;
      status?: number;
    } = {},
  ) {
    super(message);
    this.name = 'CoderError';
    this.code = code;
    Object.assign(this, extra);
  }
}
