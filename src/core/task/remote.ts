/** A server task in the shapes this machine's tasks answer with, so every task command reads the same over `--server`. */
import type { TaskLogLine, TaskStatus } from '../../server/store/types';
import { ageMs, STALL_MS, type TaskLogEntry, type TurnResultEntry } from '../state';
import {
  ACTIVE_STATUSES,
  type Engine,
  type Task,
  type TokenUsage,
  type TurnResult,
} from '../types';
import { logEntry } from './view';
import { APPROVERS } from '../approvals';
import { effectiveSettings } from '../../agent/definition';
import { splitEngineSpec } from '../config';
import type { TaskInspection } from '.';

export const iso = (ms: number | undefined) =>
  ms === undefined ? undefined : new Date(ms).toISOString();

/** The agent's reply from a finished default-flow task, if its output ended in the JSON result line. */
function replyOf(output: string | undefined): string | undefined {
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
  const settings = effectiveSettings(task);

  return {
    id: task.id,
    createdAt: iso(status.createdAt)!,
    updatedAt: iso(status.updatedAt),
    status: status.status === 'waiting' ? 'running' : status.status,
    name: task.name ?? null,
    // An engine its settings name, else the one its first model attempt runs on.
    engine: (settings.engine ??
      (task.models?.[0] ? splitEngineSpec(task.models[0].model).engine : undefined)) as
      | Engine
      | undefined,
    prompt: task.prompt ?? task.event?.text,
    model:
      task.usage?.resolvedModel ??
      remoteResult(status)?.model ??
      settings.model ??
      status.model ??
      null,
    effort: settings.effort ?? null,
    ...(task.access ? { access: task.access } : {}),
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

  return list.map(approval => {
    const scope = (approval.change as { scope?: keyof typeof APPROVERS } | undefined)?.scope;

    return {
      id: approval.id,
      reason: approval.reason,
      actions: approval.actions,
      createdAt: approval.createdAt,
      answered: approval.response?.decision ?? null,
      deniedReason:
        approval.response?.decision === 'decline' ? (approval.response.reason ?? null) : null,
      ...(scope ? { scope, approvers: APPROVERS[scope] } : {}),
    };
  });
}

function remoteTurns(status: TaskStatus): TurnResultEntry[] {
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

/** A server task as `result` inspects a local one. */
export function remoteInspection(status: TaskStatus, steps: TaskLogEntry[]): TaskInspection {
  const task = remoteTask(status);
  const pending = remoteApprovals(status)
    .filter(approval => !approval.answered)
    .map(({ id, reason, actions }) => ({ id, reason, actions }));
  const running = ACTIVE_STATUSES.includes(task.status);
  const lastActivity = iso(status.lastActivityAt ?? status.updatedAt);
  const idle = ageMs(lastActivity);

  return {
    taskId: task.id,
    status: running && pending.length ? 'waiting-approval' : task.status,
    task,
    result: remoteResult(status),
    steps,
    turns: remoteTurns(status),
    pendingApprovals: pending,
    ...(running
      ? {
          idleMs: idle,
          lastActivityAt: lastActivity ?? null,
          stalled: pending.length === 0 && idle > STALL_MS,
          liveTokens: null,
        }
      : {}),
  };
}
