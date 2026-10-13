/** A task's output log in the `Store` (`tasklog`), filled from its runner with every secret the task holds redacted. */
import type { TaskLogLine, TaskStatus, Store } from '../store/types';
import type { ServerContext } from '../context';
import { taskLogSecrets } from './context';
import { taskRunner } from '../runners';
import { logEntry } from '../../core/task/log-view';
import { DrizzleStore } from '../store/pg/store';
import { DrizzleQueue } from '../store/pg/queue';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

const logKey = (taskId: string, seq: number) => `${taskId}:${String(seq).padStart(6, '0')}`;

export async function connectionWarnings(
  ctx: ServerContext,
  taskId: string,
  warnings: string[],
): Promise<void> {
  if (!warnings.length) return;
  await ctx.store.withAppLock(`connection-warnings:${taskId}`, async store => {
    const queue = store instanceof DrizzleStore ? new DrizzleQueue(store.db) : ctx.queue;
    const pending: string[] = [];
    for (const warning of new Set(warnings))
      if (!(await store.get('delivery', `connection-warning:${taskId}:${warning}`)))
        pending.push(warning);
    if (!pending.length) return;
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await store.get('task', taskId);
      if (!current) return;
      const seq = current.logSeq ?? 0;
      const cursor = current.logCursor ?? -1;
      const now = (ctx.now ?? Date.now)();
      const saved = await queue.appendLogs(
        ctx.organizationId,
        taskId,
        pending.map((line, index) => ({ seq: seq + index, at: now, level: 'sys', line })),
        { seq, cursor },
        {
          seq: seq + pending.length,
          cursor,
          bytes:
            (current.logBytes ?? 0) +
            pending.reduce((size, line) => size + Buffer.byteLength(line), 0),
        },
        now,
        {
          attempts: current.attempts,
          tokenHash: current.tokenHash ?? null,
          handle: current.handle,
          generation: current.generation ?? 0,
        },
      );
      if (!saved) continue;
      for (const warning of pending)
        await store.put('delivery', `connection-warning:${taskId}:${warning}`, { at: now });
      return;
    }
  });
}

/** Append output lines to a task's log through the store. */
export async function appendLog(
  store: Store,
  taskId: string,
  lines: Array<Pick<TaskLogLine, 'level' | 'line'>>,
  from: number,
  now: number,
  initialBytes = 0,
): Promise<{ seq: number; bytes: number }> {
  const batch = logBatch(lines, from, now, initialBytes);
  await store.putMany(
    'tasklog',
    batch.lines.map(({ seq, ...value }) => ({ id: logKey(taskId, seq), value })),
  );
  return { seq: batch.seq, bytes: batch.bytes };
}

function logBatch(
  lines: Array<Pick<TaskLogLine, 'level' | 'line'>>,
  from: number,
  now: number,
  initialBytes: number,
): { lines: TaskLogLine[]; seq: number; bytes: number } {
  let seq = from;
  let bytes = initialBytes;
  const rows: TaskLogLine[] = [];
  for (const entry of lines) {
    const size = Buffer.byteLength(entry.line);
    if (bytes + size > MAX_LOG_BYTES) break;
    rows.push({ seq, at: now, level: entry.level, line: entry.line });
    bytes += size;
    seq += 1;
  }
  return { lines: rows, seq, bytes };
}

export async function readLog(
  store: Store,
  taskId: string,
  after = -1,
  limit?: number,
): Promise<TaskLogLine[]> {
  const rows = await store.list('tasklog', {
    prefix: `${taskId}:`,
    ...(after >= 0 ? { after: logKey(taskId, after) } : {}),
    ...(limit ? { limit } : {}),
  });

  return rows.map(row => {
    const entry = logEntry(row.value.line);
    return {
      seq: Number(row.id.slice(row.id.lastIndexOf(':') + 1)),
      ...row.value,
      ...(entry ? { entry } : {}),
    };
  });
}

/** Copy the runner's new output into the task's log, then read the log after `after`. */
export async function copyRunnerLogs(
  ctx: ServerContext,
  status: TaskStatus,
  after = -1,
  limit?: number,
): Promise<TaskLogLine[]> {
  if (!status.handle) return readLog(ctx.store, status.task.id, after, limit);
  if (status.task.runner !== 'github-actions') return pullRunnerLogs(ctx, status, after, limit);
  if (
    status.logsComplete ||
    (status.logsPulledAt !== undefined &&
      (ctx.now ?? Date.now)() - status.logsPulledAt < RUNNER_LOG_PULL_MS)
  )
    return readLog(ctx.store, status.task.id, after, limit);

  const current = await ctx.store.withAppLock(
    `runner-logs:${ctx.organizationId}:${status.task.id}`,
    async store => {
      const queue = store instanceof DrizzleStore ? new DrizzleQueue(store.db) : ctx.queue;
      const current = await store.get('task', status.task.id);
      if (!current || current.logsComplete || !current.handle) return;
      const now = (ctx.now ?? Date.now)();
      if (current.logsPulledAt !== undefined && now - current.logsPulledAt < RUNNER_LOG_PULL_MS)
        return;
      const fence = {
        attempts: current.attempts,
        tokenHash: current.tokenHash ?? null,
        handle: current.handle,
        generation: current.generation ?? 0,
      };
      if (
        !(await queue.patchTask(
          ctx.organizationId,
          current.task.id,
          { logsPulledAt: now },
          now,
          fence,
        ))
      )
        return;
      return current;
    },
  );
  if (current)
    await pullRunnerLogs(ctx, current).catch(error =>
      console.error(`coder server: runner logs for ${status.task.id} failed`, error),
    );

  return readLog(ctx.store, status.task.id, after, limit);
}

export const RUNNER_LOG_PULL_MS = 15_000;

async function pullRunnerLogs(
  ctx: ServerContext,
  status: TaskStatus,
  after = -1,
  limit?: number,
): Promise<TaskLogLine[]> {
  const fence = {
    attempts: status.attempts,
    tokenHash: status.tokenHash ?? null,
    handle: status.handle,
    generation: status.generation ?? 0,
  };
  const runner = await taskRunner(ctx, status.task);
  if (!runner) {
    // A deleted runner has no more logs to give.
    if (['completed', 'failed', 'cancelled'].includes(status.status) && !status.logsComplete)
      await ctx.queue.patchTask(
        ctx.organizationId,
        status.task.id,
        { logsComplete: true },
        (ctx.now ?? Date.now)(),
        fence,
      );

    return readLog(ctx.store, status.task.id, after, limit);
  }

  const secrets = await taskLogSecrets(ctx, status).catch(error => {
    console.error(`coder server: log secrets for ${status.task.id} failed`, error);
    return undefined;
  });
  const current = await ctx.store.get('task', status.task.id);
  if (!secrets) return readLog(ctx.store, status.task.id, after, limit);

  const sameRun =
    current &&
    current.attempts === status.attempts &&
    current.tokenHash === status.tokenHash &&
    current.generation === status.generation &&
    current.handle === status.handle;
  const state = sameRun ? current : status;
  const cursor = state.logCursor ?? -1;
  const seq = state.logSeq ?? 0;
  const bytes = state.logBytes ?? 0;
  const completed =
    status.task.runner === 'github-actions' &&
    ['completed', 'failed', 'cancelled'].includes(state.status)
      ? (await runner.status(status.handle!)).state === 'exited'
      : false;
  const fetched = await runner.logs(status.handle!, cursor);
  const now = (ctx.now ?? Date.now)();
  const redacted = (line: string) =>
    secrets.reduce(
      (value, secret) => (secret ? value.replaceAll(secret, '[REDACTED]') : value),
      line,
    );
  const redactValue = (value: unknown): unknown => {
    if (typeof value === 'string') return redacted(value);
    if (Array.isArray(value)) return value.map(redactValue);
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [redacted(key), redactValue(entry)]),
      );
    return value;
  };

  const appended = logBatch(
    fetched.lines.map(({ level, line }) => {
      const entry = logEntry(line);
      return { level, line: entry ? JSON.stringify(redactValue(entry)) : redacted(line) };
    }),
    seq,
    now,
    bytes,
  );

  const saved = await ctx.queue.appendLogs(
    ctx.organizationId,
    status.task.id,
    appended.lines,
    { seq, cursor },
    {
      cursor: fetched.next,
      seq: appended.seq,
      bytes: appended.bytes,
    },
    now,
    fence,
  );

  if (saved && completed && fetched.complete !== false)
    await ctx.queue.patchTask(
      ctx.organizationId,
      status.task.id,
      { logsComplete: true },
      now,
      fence,
    );

  return readLog(ctx.store, status.task.id, after, limit);
}
