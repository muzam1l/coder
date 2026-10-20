/** A server task in the shapes this machine's tasks answer with, so every task command reads the same over `--server`. */
import type { TaskLogLine, TaskStatus } from '../../server/store/types';
import type { TaskLogEntry, TurnResultEntry } from '../state';
import type { Engine, Task, TokenUsage, TurnResult } from '../types';
import { logEntry } from './log-view';

export const iso = (ms: number | undefined) =>
  ms === undefined ? undefined : new Date(ms).toISOString();

/** The agent's reply from a finished default-flow task, if its output ended in the JSON result line. */
export function replyOf(output: string | undefined): string | undefined {
  const lines = (output ?? '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const reply = (JSON.parse(line) as { reply?: unknown }).reply;
      return typeof reply === 'string' ? reply : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A turn's output: the engine result a runner reported whole, or its transcript ending in the reply. */
function turnOf(
  output: string | undefined,
  ok: boolean,
  error: string | undefined,
  tokens: unknown,
): TurnResult {
  if (output?.trimStart().startsWith('{')) {
    try {
      const parsed = JSON.parse(output);
      if (parsed && typeof parsed.status === 'number' && 'threadId' in parsed)
        return {
          ...parsed,
          error: parsed.error ?? (error ? { message: error } : null),
          tokens: parsed.tokens ?? (tokens as TokenUsage | undefined) ?? null,
        };
    } catch {}
  }
  const answer = replyOf(output) ?? output;

  return {
    status: ok ? 0 : 1,
    threadId: null,
    ...(answer ? { finalMessage: answer } : {}),
    error: error ? { message: error } : null,
    tokens: (tokens as TokenUsage | undefined) ?? null,
  };
}

export function remoteResult(status: TaskStatus): TurnResult | null {
  return status.result
    ? turnOf(status.result.output, status.result.ok, status.error, status.tokens)
    : null;
}

export function remoteTask(status: TaskStatus): Task {
  const { task } = status;

  return {
    id: task.id,
    createdAt: iso(status.createdAt)!,
    updatedAt: iso(status.updatedAt),
    status: status.status === 'waiting' ? 'running' : status.status,
    name: task.name ?? null,
    engine: (task.usage?.engine ?? task.definition?.engine) as Engine | undefined,
    prompt: task.prompt ?? task.event?.text,
    model: remoteResult(status)?.model ?? task.usage?.model ?? task.definition?.model ?? null,
    effort: task.usage?.effort ?? null,
    ...(task.permissions ? { permissions: task.permissions } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    ...(task.appendSystem ? { appendSystem: task.appendSystem } : {}),
    ...(task.addDirs?.length ? { addDirs: task.addDirs } : {}),
    ...(status.finishedAt !== undefined ? { completedAt: iso(status.finishedAt) } : {}),
    ...(status.error ? { error: status.error } : {}),
    archived: status.archivedAt !== undefined,
    ...(status.archivedAt !== undefined ? { archivedAt: iso(status.archivedAt) } : {}),
    agentId: task.agent,
    source: task.source,
  };
}

/** A server task's approvals: the list it keeps, else the pending one it announced. */
export function remoteApprovals(status: TaskStatus) {
  const pending = status.approval;
  const list = status.approvals ?? (pending?.id ? [pending] : []);

  return list.map(approval => ({
    id: approval.id,
    reason: approval.reason,
    actions: approval.actions,
    createdAt: approval.createdAt,
    answered: approval.response?.decision ?? null,
    deniedReason:
      approval.response?.decision === 'decline' ? (approval.response.reason ?? null) : null,
  }));
}

export function remoteTurns(status: TaskStatus): TurnResultEntry[] {
  return (status.turns ?? [])
    .filter(turn => turn.finishedAt !== undefined)
    .map(turn => {
      const result =
        typeof turn.result === 'string' ? { ok: true, output: turn.result } : turn.result;

      return {
        at: iso(turn.finishedAt),
        prompt: turn.prompt,
        ...turnOf(result?.output, result?.ok ?? !turn.error, turn.error, undefined),
      };
    });
}

/** A server task's answer, as `coder task result --json` gives it. */
export function remoteAnswer(status: TaskStatus) {
  const task = remoteTask(status);
  const result = remoteResult(status);

  return {
    taskId: task.id,
    name: task.name ?? null,
    status: status.status as string,
    engine: task.engine ?? null,
    model: task.model ?? null,
    finalMessage: result?.finalMessage ?? null,
    error: result?.error?.message ?? task.error ?? null,
    tokens: result?.tokens ?? null,
    pendingApprovals: remoteApprovals(status)
      .filter(approval => !approval.answered)
      .map(({ id, reason, actions }) => ({ id, reason, actions })),
  };
}

export type RemoteAnswer = ReturnType<typeof remoteAnswer>;

/** A server log line as a progress-log entry. */
export function remoteStep(line: TaskLogLine): TaskLogEntry {
  return {
    ...(line.entry ??
      logEntry(line.line) ?? { kind: line.level === 'err' ? 'error' : 'info', message: line.line }),
    at: line.entry?.at ?? new Date(line.at).toISOString(),
  };
}
