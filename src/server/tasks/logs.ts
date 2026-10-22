/** A task's output log in the `Store` (`tasklog`), filled from its runner with every secret the task holds redacted. */
import { gunzip, gzip } from 'node:zlib';
import { promisify } from 'node:util';

import type { TaskHistory, TaskLogLine, TaskStatus, Store } from '../store/types';
import type { ServerContext } from '../context';
import { taskLogSecrets } from './context';
import { logEntry } from '../../core/task/view';
import { HISTORY_CONVERSATION } from '../../core/engines/history';
import { type Params } from '../routes/match';
import { json } from '../routes/http';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { type CallbackContext } from './callbacks';

const MAX_LOG_BYTES = 2 * 1024 * 1024;

const logKey = (taskId: string, seq: number) => `${taskId}:${String(seq).padStart(6, '0')}`;

/** A warning is written once per task; its marker outlives any task by a day. */
const WARNING_TTL_MS = 24 * 60 * 60 * 1000;

export async function taskWarnings(
  ctx: ServerContext,
  taskId: string,
  warnings: string[],
): Promise<void> {
  if (!warnings.length) return;
  await ctx.store.withAppLock(`task-warnings:${taskId}`, async store => {
    const queue = store.queue?.() ?? ctx.queue;
    const pending: string[] = [];
    for (const warning of new Set(warnings))
      if (!(await store.get('delivery', `task-warning:${taskId}:${warning}`)))
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
        await store.put(
          'delivery',
          `task-warning:${taskId}:${warning}`,
          { at: now },
          { ttlMs: WARNING_TTL_MS },
        );
      return;
    }
  });
}

/** Append output lines to a task's log through the store. */
export async function appendLog(
  store: Store,
  taskId: string,
  lines: Array<Pick<TaskLogLine, 'level' | 'line'> & { at?: number }>,
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
  lines: Array<Pick<TaskLogLine, 'level' | 'line'> & { at?: number }>,
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
    rows.push({ seq, at: entry.at ?? now, level: entry.level, line: entry.line });
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

export async function taskRedactor(
  ctx: ServerContext,
  status: TaskStatus,
  refresh = false,
): Promise<(text: string) => string> {
  const settings = (ctx.settings ??= {});
  const cache = (settings.taskLogSecrets ??= new Map<string, Promise<(text: string) => string>>());
  const key = JSON.stringify([
    ctx.organizationId,
    status.task.id,
    status.attempts,
    status.generation,
    status.tokenHash,
  ]);
  if (refresh) cache.delete(key);
  let pending = cache.get(key);
  if (!pending) {
    pending = taskLogSecrets(ctx, status)
      .then(values => {
        const secrets = values.sort((a, b) => b.length - a.length);
        return (text: string) =>
          secrets.reduce(
            (text, secret) => (secret ? text.replaceAll(secret, '[REDACTED]') : text),
            text,
          );
      })
      .catch(error => {
        cache.delete(key);
        throw error;
      });
    cache.set(key, pending);
    const timer = setTimeout(
      () => {
        if (cache.get(key) === pending) cache.delete(key);
      },
      (ctx.config.taskTimeoutMs ?? 30 * 60_000) + 60_000,
    );
    timer.unref?.();
  }
  return pending;
}

export async function storeLogs(
  ctx: ServerContext & { callbackTask?: TaskStatus },
  status: TaskStatus,
  entries: TaskLogLine[],
): Promise<'ok' | 'gap' | 'stale'> {
  const redact = await taskRedactor(ctx, status);
  const value = (entry: unknown): unknown => {
    if (typeof entry === 'string') return redact(entry);
    if (Array.isArray(entry)) return entry.map(value);
    if (entry && typeof entry === 'object')
      return Object.fromEntries(
        Object.entries(entry).map(([key, entry]) => [redact(key), value(entry)]),
      );
    return entry;
  };
  const line = (text: string) => {
    try {
      return JSON.stringify(value(JSON.parse(text)));
    } catch {
      return redact(text);
    }
  };
  for (let attempt = 0; attempt < 5; attempt++) {
    const current =
      attempt === 0 && ctx.callbackTask === status
        ? status
        : await ctx.store.get('task', status.task.id);
    if (
      !current ||
      current.attempts !== status.attempts ||
      current.tokenHash !== status.tokenHash ||
      current.generation !== status.generation
    )
      return 'stale';
    const cursor = current.logCursor ?? -1;
    const fresh = entries.filter(entry => entry.seq > cursor);
    if (!fresh.length) return 'ok';
    if (current.logsComplete || fresh[0]!.seq !== cursor + 1) return 'gap';
    const now = (ctx.now ?? Date.now)();
    const batch = logBatch(
      fresh.map(entry => ({ ...entry, line: line(entry.line) })),
      current.logSeq ?? 0,
      now,
      current.logBytes ?? 0,
    );
    if (
      await ctx.queue.appendLogs(
        ctx.organizationId,
        status.task.id,
        batch.lines,
        { seq: current.logSeq ?? 0, cursor },
        { seq: batch.seq, cursor: fresh.at(-1)!.seq, bytes: batch.bytes },
        now,
        {
          attempts: status.attempts,
          tokenHash: status.tokenHash,
          generation: status.generation ?? 0,
        },
      )
    )
      return 'ok';
  }

  return 'stale';
}

// A task's engine conversations: its runner uploads each after a turn and downloads them before the next.

const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const unzip = promisify(gunzip);
const zip = promisify(gzip);

/** The task's conversations, oldest first; the last one is the one to resume. */
export async function listHistory(
  req: Request,
  ctx: CallbackContext,
  params: Params,
): Promise<Response> {
  return json(await ctx.store.listHistory(params.id!));
}

/** One conversation's file, gzipped and base64-encoded, with the chain saved beside it. */
export async function readHistory(
  req: Request,
  ctx: CallbackContext,
  params: Params,
): Promise<Response> {
  const row = await ctx.store.get('history', `${params.id}:${params.conversation}`);
  if (!row) return json({ error: 'No saved history' }, 404);

  try {
    return json({
      engine: row.engine,
      conversation: row.conversation,
      data: decryptSecret<string>(ctx.config, row.data),
      ...(row.state ? { state: decryptSecret(ctx.config, row.state) } : {}),
    });
  } catch (error) {
    console.error(
      `coder server: history ${params.id}/${params.conversation} could not be decrypted`,
      error,
    );
    return json({ error: 'The saved history cannot be read' }, 422);
  }
}

export async function saveHistory(
  req: Request,
  ctx: CallbackContext,
  params: Params,
): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as
    (Partial<Omit<TaskHistory, 'state'>> & { state?: unknown }) | undefined;
  if (
    (body?.engine !== 'claude' && body?.engine !== 'codex') ||
    typeof body.conversation !== 'string' ||
    !HISTORY_CONVERSATION.test(body.conversation) ||
    typeof body.data !== 'string' ||
    (body.state !== undefined &&
      (!body.state || typeof body.state !== 'object' || Array.isArray(body.state)))
  )
    return json({ error: 'Invalid history' }, 400);
  let text: string;
  try {
    text = (
      await unzip(Buffer.from(body.data, 'base64'), {
        maxOutputLength: MAX_HISTORY_BYTES,
      })
    ).toString('utf8');
  } catch {
    return json({ error: 'Invalid history' }, 400);
  }

  const redact = await taskRedactor(ctx, ctx.callbackTask!, true);
  await ctx.store.put('history', `${params.id}:${body.conversation}`, {
    engine: body.engine,
    conversation: body.conversation,
    data: encryptSecret(ctx.config, (await zip(redact(text))).toString('base64')),
    ...(body.state
      ? { state: encryptSecret(ctx.config, JSON.parse(redact(JSON.stringify(body.state)))) }
      : {}),
    savedAt: (ctx.now ?? Date.now)(),
  });

  return json({ ok: true });
}
