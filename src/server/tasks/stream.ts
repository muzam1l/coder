import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { type Params } from '../routes/match';
import { loadTask, resolveTaskDir } from '../../core/state';
import { type TaskLogLine, type TaskStatus } from '../store/types';
import { type ServerContext } from '../context';
import { start } from './flows';
import { json, pageLimit } from '../routes/http';
import { taskRunner } from '../runners';
import { localLog, localTask, localTasks, sweepLocalQueue } from './local';
import { copyRunnerLogs, readLog } from './logs';
import { DONE, localRows } from './admin';
import { StoreQueue, TOMBSTONE_MS } from './queue';

export async function taskStream(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    const local = localTask(cwd, taskId, false);
    if (!local) return json({ error: `No task "${taskId}"` }, 404);
    {
      const last = Number(req.headers.get('last-event-id') ?? cursor);

      return streamTask(
        req,
        ctx,
        `cli:${cwd}:${taskId}`,
        Number.isFinite(last) ? last : cursor,
        async after => {
          const current = localTask(cwd, taskId);
          if (!current) return undefined;

          return {
            status: current,
            lines: localLog(cwd, taskId, after, STREAM_LINES),
            pendingResult: resultPending(cwd, current, !current.result),
          };
        },
      );
    }
  }

  const last = Number(req.headers.get('last-event-id') ?? cursor);

  const bounded = ctx.statementTimeout ?? ((_ms, work) => work());

  return streamTask(req, ctx, taskId, Number.isFinite(last) ? last : cursor, after =>
    bounded(LOG_READ_MS, async () => {
      const current = await ctx.store.get('task', taskId);
      if (!current) return undefined;

      const archived = current.task.runner === 'github-actions' && current.handle;
      const pendingLogs =
        archived && DONE.has(current.status)
          ? (
              await (
                await taskRunner(ctx, current.task)
              )
                ?.status(current.handle!)
                .catch(() => undefined)
            )?.state === 'running'
          : false;
      const lines =
        (['running', 'waiting'].includes(current.status) || archived) && current.handle
          ? await copyRunnerLogs(ctx, current, after, STREAM_LINES).catch(() =>
              readLog(ctx.store, taskId, after, STREAM_LINES),
            )
          : await readLog(ctx.store, taskId, after, STREAM_LINES);

      return { status: current, lines, pendingLogs };
    }),
  );
}

/** A finished CLI task whose result file predates its last turn, so its worker is still writing it. */
function resultPending(cwd: string, status: TaskStatus, missing = false) {
  if (!DONE.has(status.status) || status.error || status.status === 'cancelled') return false;
  const task = loadTask(cwd, status.task.id);
  const finished = Math.max(
    status.finishedAt ?? 0,
    Date.parse(task?.resumedAt ?? task?.createdAt ?? '') || 0,
  );

  return (
    missing ||
    (fs.statSync(path.join(resolveTaskDir(cwd, status.task.id), 'result.json'), {
      throwIfNoEntry: false,
    })?.mtimeMs ?? 0) < finished
  );
}

export const STREAM_MS = 50_000;

export const STREAM_POLL_MS = 1000;

export const STREAM_LINES = 500;

/** Under Vercel's 300 s function limit; the browser reconnects with its last event id. */
export const EVENTS_MS = 290_000;

export const EVENTS_HEARTBEAT_MS = 20_000;

/** Task ids one events stream may ask about. */
export const EVENTS_TASKS = 100;

// A write stamps `updatedAt` before its slower work commits, so a read looks back this far.
const EVENTS_LAG_MS = 30_000;

// A local server scans the CLI's task folders this often, as the list used to poll them.
const LOCAL_SCAN_MS = 4000;

// The CLI's archive changes rarely and costs more to read, so it is scanned this often.
const ARCHIVE_SCAN_MS = 15_000;

/** `GET /admin/events?tasks=a,b`: the asked tasks' state and every list change in the caller's workspace. */
export function taskEvents(req: Request, ctx: ServerContext, params: Params, url: URL): Response {
  const ids = [...new Set((url.searchParams.get('tasks') ?? '').split(',').filter(Boolean))].slice(
    0,
    EVENTS_TASKS,
  );
  const now = Date.now();
  const watcher = ctx.taskWatcher ?? new TaskWatcher();
  const tag = watcher.tag(ctx);
  const [time, scope] = (req.headers.get('last-event-id') ?? '').split('-');
  const last = Number(time);
  // A resume looks back one stream's life at most, in the workspace and server generation that sent its id; else the page reloads its data.
  const known = last > 0 && `-${scope}` === tag;
  const from = known ? Math.min(Math.max(last, now - EVENTS_MS), now) : now;
  const reset = last > 0 && (!known || last < from) ? 'event: reset\ndata: {}\n\n' : '';
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${STREAM_POLL_MS}\nid: ${from}${tag}\n\n${reset}`));
      stop = watcher.watch(
        ctx,
        ids,
        from,
        text => controller.enqueue(encoder.encode(text)),
        () => controller.close(),
      );
      // A client that left gets no more reads, and its body ends.
      const leave = () => {
        stop();
        try {
          controller.close();
        } catch {}
      };
      if (req.signal.aborted) leave();
      else req.signal.addEventListener('abort', leave);
    },
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}

/** What a task event carries: a list row's state, plus the result, error and answers of an asked task. */
function eventState(status: TaskStatus, asked: boolean) {
  const { task, approval, archivedAt, createdAt, startedAt, finishedAt } = status;
  return {
    id: task.id,
    agent: task.agent,
    status: status.status,
    approval: approval ?? null,
    // A list hears nothing of an auto-archive; it takes it up on its next read.
    archivedAt: status.autoArchived && !asked ? undefined : archivedAt,
    createdAt,
    startedAt,
    finishedAt,
    ...(asked
      ? {
          result: status.result ?? null,
          error: status.error ?? null,
          answer: status.answer ?? null,
        }
      : {}),
  };
}

type Watch = {
  ctx: ServerContext;
  ids: Set<string>;
  /** Each task's last sent event, so a change goes out once. */
  sent: Map<string, string>;
  /** Tasks this stream has been told were archived or deleted. */
  gone: Set<string>;
  /** Rows updated after this are news to the stream: its last event id, then its last read. */
  from: number;
  fresh: boolean;
  /** This server's generation in each event id, when its delete history is in memory. */
  tag: string;
  beat: number;
  /** When the stream last had an event id. */
  marked: number;
  until: number;
  send: (text: string) => void;
  close: () => void;
};

/** One read a second for every open events stream of this server, fanned out to each. */
export class TaskWatcher {
  private watches = new Set<Watch>();
  private timer?: ReturnType<typeof setInterval>;
  private reading = false;
  private closed = false;
  private last = Date.now();
  private scans = new Map<
    string,
    { at: number; rows: TaskStatus[]; archived: TaskStatus[]; archivedAt: number }
  >();
  /** CLI tasks that left a local server's folders, by folder and when, for streams that resume. */
  private left = new Map<string, Map<string, number>>();
  /** CLI tasks streams were told are archived, by folder; scans miss archives, so each rescan checks they still exist. */
  private archived = new Map<string, Set<string>>();
  /** Store reads so far, for tests and metrics. */
  reads = 0;
  private readonly generation = randomUUID().slice(0, 8);

  constructor(
    private readonly options: {
      pollMs?: number;
      heartbeatMs?: number;
      lifeMs?: number;
    } = {},
  ) {}

  watch(
    ctx: ServerContext,
    ids: string[],
    from: number,
    send: (text: string) => void,
    close: () => void,
  ): () => void {
    if (this.closed) {
      queueMicrotask(close);
      return () => {};
    }
    const now = Date.now();
    if (!this.watches.size) this.last = now;
    const watch: Watch = {
      ctx,
      ids: new Set(ids),
      sent: new Map(),
      gone: new Set(),
      from,
      fresh: true,
      tag: this.tag(ctx),
      beat: now,
      marked: now,
      until: now + (this.options.lifeMs ?? EVENTS_MS),
      send,
      close,
    };
    this.watches.add(watch);
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), this.options.pollMs ?? STREAM_POLL_MS);
      this.timer.unref?.();
    }
    this.tick();

    return () => this.drop(watch);
  }

  /** What every event id carries: its workspace, and with a store queue, whose deletes a restart loses, this server's generation. */
  tag(ctx: ServerContext) {
    const workspace = createHash('sha256').update(ctx.organizationId).digest('hex').slice(0, 8);
    return `-${workspace}${ctx.queue instanceof StoreQueue ? `.${this.generation}` : ''}`;
  }

  /** Ends every stream and refuses new ones, so a stopping server need not wait out their life. */
  close() {
    this.closed = true;
    for (const watch of [...this.watches]) {
      this.drop(watch);
      try {
        watch.close();
      } catch {}
    }
  }

  private drop(watch: Watch) {
    if (!this.watches.delete(watch)) return;
    if (!this.watches.size) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** Every poll: each stream's time limit and heartbeat, then a read unless one is still out. */
  private tick() {
    const at = Date.now();
    for (const watch of [...this.watches]) {
      if (at >= watch.until) {
        this.drop(watch);
        try {
          watch.close();
        } catch {}
      } else if (at - watch.beat >= (this.options.heartbeatMs ?? EVENTS_HEARTBEAT_MS)) {
        watch.beat = at;
        this.send(watch, ': ping\n\n');
      }
    }
    if (this.reading || !this.watches.size) return;
    this.reading = true;
    void this.read(at).finally(() => (this.reading = false));
  }

  private send(watch: Watch, text: string) {
    try {
      watch.send(text);
    } catch {
      this.drop(watch);
    }
  }

  private async read(at: number) {
    const watches = [...this.watches];
    const scopes = new Map<string, { ctx: ServerContext; ids: Set<string> }>();
    for (const watch of watches) {
      const scope = scopes.get(watch.ctx.organizationId) ?? { ctx: watch.ctx, ids: new Set() };
      for (const id of watch.ids) scope.ids.add(id);
      scopes.set(watch.ctx.organizationId, scope);
    }
    const since = Math.min(
      this.last,
      ...watches.flatMap(watch => (watch.fresh ? [watch.from] : [])),
    );
    this.reads++;
    // A slow read holds the next one back, so reads never pile up; heartbeats and time limits go on meanwhile.
    const rows = await this.changes(scopes, since - EVENTS_LAG_MS, at).catch(() => undefined);
    if (!rows) return;
    this.last = at;

    for (const watch of watches) {
      if (!this.watches.has(watch)) continue;
      let out: string[] = [];
      try {
        out = this.news(watch, rows, at);
      } catch {}
      // A quiet stream still moves its resume point.
      if (!out.length && at - watch.marked >= (this.options.heartbeatMs ?? EVENTS_HEARTBEAT_MS))
        out.push(`id: ${at}${watch.tag}\n\n`);
      if (!out.length) continue;
      watch.marked = at;
      this.send(watch, out.join(''));
    }
  }

  /** Each workspace's rows and deletes from one queue read, with a local server's CLI tasks merged in. */
  private async changes(
    scopes: Map<string, { ctx: ServerContext; ids: Set<string> }>,
    since: number,
    at: number,
  ) {
    const changed = await [...scopes.values()][0]!.ctx.queue.changes(
      [...scopes].map(([organizationId, scope]) => ({ organizationId, ids: [...scope.ids] })),
      since,
    );
    const rows = new Map<string, Map<string, TaskStatus>>();
    for (const { organizationId, status } of changed.rows) {
      const scope = rows.get(organizationId) ?? new Map<string, TaskStatus>();
      rows.set(organizationId, scope.set(status.task.id, status));
    }
    const deleted = new Map<string, Map<string, number>>();
    for (const { organizationId, id, at: when } of changed.deleted) {
      const scope = deleted.get(organizationId) ?? new Map<string, number>();
      deleted.set(organizationId, scope.set(id, when));
    }
    for (const [organizationId, { ctx }] of scopes) {
      if (!ctx.local) continue;
      const queued = [...(rows.get(organizationId)?.values() ?? [])];
      let scan = this.scans.get(ctx.local.cwd);
      // A queue change since the last scan rescans, so an older CLI row never wins over it.
      if (!scan || at - scan.at >= LOCAL_SCAN_MS || queued.some(row => row.updatedAt > scan!.at)) {
        // Archived tasks too, so an archive list hears a running one finish.
        const fresh = !scan || at - scan.archivedAt >= ARCHIVE_SCAN_MS;
        await sweepLocalQueue(ctx, ctx.local.cwd);
        const shelf = fresh ? localTasks(ctx.local.cwd, true) : scan!.archived;
        const active = localTasks(ctx.local.cwd, false);
        const listed = new Set(active.map(row => row.task.id));
        const next = [...active, ...shelf.filter(row => !listed.has(row.task.id))];
        const kept = new Set(next.map(row => row.task.id));
        const left = this.left.get(ctx.local.cwd) ?? new Map<string, number>();
        // Gone some time after the last scan saw them.
        for (const row of scan?.rows ?? [])
          if (!kept.has(row.task.id)) left.set(row.task.id, scan!.at);
        for (const [id, when] of left)
          if (when < at - TOMBSTONE_MS || kept.has(id)) left.delete(id);
        const archived = this.archived.get(ctx.local.cwd) ?? new Set<string>();
        for (const id of archived)
          if (kept.has(id)) archived.delete(id);
          else if (!loadTask(ctx.local.cwd, id)) {
            left.set(id, scan?.at ?? at);
            archived.delete(id);
          }
        this.left.set(ctx.local.cwd, left);
        this.scans.set(
          ctx.local.cwd,
          (scan = { at, rows: next, archived: shelf, archivedAt: fresh ? at : scan!.archivedAt }),
        );
      }
      rows.set(
        organizationId,
        new Map(localRows(ctx.local.cwd, scan.rows, queued).map(row => [row.task.id, row])),
      );
    }

    return { rows, deleted };
  }

  /** The events one stream has not had yet. */
  private news(
    watch: Watch,
    { rows, deleted: removed }: Awaited<ReturnType<TaskWatcher['changes']>>,
    at: number,
  ): string[] {
    const { ctx } = watch;
    const found = rows.get(ctx.organizationId) ?? new Map<string, TaskStatus>();
    const out: string[] = [];
    const emit = (id: string, data: object) => {
      const text = JSON.stringify(data);
      if (watch.sent.get(id) === text) return;
      watch.sent.set(id, text);
      out.push(`id: ${at}${watch.tag}\nevent: task\ndata: ${text}\n\n`);
    };
    const deleted = (id: string) => ({ id, deleted: true });
    const gone = (id: string) => {
      // An asked task keeps its result, archived or not.
      const local = ctx.local && localTask(ctx.local.cwd, id, watch.ids.has(id));
      emit(id, local ? eventState(local, watch.ids.has(id)) : deleted(id));
      watch.gone.add(id);
      if (local && ctx.local) {
        const archived = this.archived.get(ctx.local.cwd) ?? new Set<string>();
        this.archived.set(ctx.local.cwd, archived.add(id));
      }
    };

    for (const [id, status] of found) {
      const asked = watch.ids.has(id);
      watch.gone.delete(id);
      // A finished asked task's result lives in its CLI folder.
      const row =
        asked && ctx.local && status.local && DONE.has(status.status)
          ? (localTask(ctx.local.cwd, id) ?? status)
          : status;
      const data = eventState(row, asked);
      // A CLI task's finish waits a little for its result file, as its own stream does.
      if (
        ctx.local &&
        status.local &&
        watch.sent.get(id) !== JSON.stringify(data) &&
        at - (status.finishedAt ?? 0) < EVENTS_LAG_MS &&
        resultPending(ctx.local.cwd, status)
      ) {
        // Known, so an archive or delete before its result still goes out.
        if (!watch.sent.has(id)) watch.sent.set(id, '');
        continue;
      }
      // A local read holds every task, so after the first one any difference is news.
      if (asked || (ctx.local && !watch.fresh) || status.updatedAt > watch.from - EVENTS_LAG_MS)
        emit(id, data);
      else if (watch.fresh) watch.sent.set(id, JSON.stringify(data));
    }
    for (const id of watch.ids) if (!found.has(id)) gone(id);
    for (const [id, when] of removed.get(ctx.organizationId) ?? [])
      if (when > watch.from - EVENTS_LAG_MS) emit(id, deleted(id));
    // A local read holds every task, so one missing was archived or deleted, maybe while this stream was away.
    if (ctx.local) {
      for (const id of watch.sent.keys())
        if (!found.has(id) && !watch.ids.has(id) && !watch.gone.has(id)) gone(id);
      for (const [id, when] of this.left.get(ctx.local.cwd) ?? [])
        if (
          when > watch.from - EVENTS_LAG_MS &&
          !found.has(id) &&
          watch.sent.get(id) !== JSON.stringify(deleted(id))
        )
          gone(id);
    }
    watch.fresh = false;
    watch.from = at;

    return out;
  }
}

type LogRead = (cursor: number) => Promise<
  | {
      status: TaskStatus;
      lines: TaskLogLine[];
      pendingLogs?: boolean;
      pendingResult?: boolean;
    }
  | undefined
>;

type LogWatch = {
  /** The last line this stream has. */
  cursor: number;
  feed: LogFeed;
  timers: Array<ReturnType<typeof setTimeout>>;
  send: (text: string) => void;
  close: () => void;
};

type LogFeed = {
  key: string;
  read: LogRead;
  watches: Set<LogWatch>;
  /** The last line the feed has read up to. */
  head: number;
  /** When the read in flight started. */
  reading?: number;
  timer?: ReturnType<typeof setTimeout>;
};

/** A log read out this long is stalled: its database statements are cancelled, and a new stream retires its feed. */
export const LOG_READ_MS = 10_000;

/** One log read a second for each task with open log streams, shared by them from each one's cursor. */
export class LogWatcher {
  private feeds = new Map<string, LogFeed>();
  private closed = false;
  /** Log reads so far, for tests and metrics. */
  reads = 0;

  constructor(
    private readonly options: {
      pollMs?: number;
      lifeMs?: number;
      heartbeatMs?: number;
      stallMs?: number;
    } = {},
  ) {}

  watch(
    key: string,
    after: number,
    read: LogRead,
    send: (text: string) => void,
    close: () => void,
  ): () => void {
    if (this.closed) {
      queueMicrotask(close);
      return () => {};
    }
    let feed = this.feeds.get(key);
    const stalled =
      feed?.reading !== undefined &&
      Date.now() - feed.reading >= (this.options.stallMs ?? LOG_READ_MS);
    // A stalled feed is retired: its streams move to a fresh one, and its read's answer is dropped when it settles.
    if (!feed || stalled) {
      const fresh: LogFeed = { key, read, watches: new Set(), head: Infinity };
      if (feed) {
        clearTimeout(feed.timer);
        for (const watch of feed.watches) fresh.watches.add(Object.assign(watch, { feed: fresh }));
        feed.watches.clear();
      }
      this.feeds.set(key, (feed = fresh));
    }
    const watch: LogWatch = { cursor: after, feed, timers: [], send, close };
    // Each stream's time limit and heartbeat run on their own, whatever its feed's read is doing.
    watch.timers = [
      setTimeout(() => this.end(watch), this.options.lifeMs ?? STREAM_MS),
      setInterval(
        () => this.send(watch, ': ping\n\n'),
        this.options.heartbeatMs ?? EVENTS_HEARTBEAT_MS,
      ),
    ];
    for (const timer of watch.timers) timer.unref?.();
    feed.watches.add(watch);
    // A stream behind what the feed has read gets its lines now, not at the next poll.
    if (feed.reading === undefined && after < feed.head) {
      clearTimeout(feed.timer);
      void this.read(feed);
    }

    return () => this.drop(watch);
  }

  /** Ends every stream and refuses new ones. */
  close() {
    this.closed = true;
    for (const feed of [...this.feeds.values()])
      for (const watch of [...feed.watches]) this.end(watch);
  }

  private drop(watch: LogWatch) {
    const { feed } = watch;
    for (const timer of watch.timers) clearTimeout(timer);
    if (!feed.watches.delete(watch) || feed.watches.size) return;
    clearTimeout(feed.timer);
    if (this.feeds.get(feed.key) === feed) this.feeds.delete(feed.key);
  }

  private end(watch: LogWatch, text = '') {
    try {
      if (text) watch.send(text);
      watch.close();
    } catch {}
    this.drop(watch);
  }

  private send(watch: LogWatch, text: string) {
    try {
      watch.send(text);
    } catch {
      this.drop(watch);
    }
  }

  private async read(feed: LogFeed) {
    feed.timer = undefined;
    if (this.feeds.get(feed.key) !== feed || !feed.watches.size) return;
    // A stream that joins during a read, maybe after a continue, waits for a read of its own.
    const readers = [...feed.watches];
    const from = Math.min(...readers.map(watch => watch.cursor));
    feed.reading = Date.now();
    this.reads++;
    // The guard holds until the read settles, so a feed never has two reads out.
    const found = await feed.read(from).catch(() => null);
    feed.reading = undefined;
    if (this.feeds.get(feed.key) !== feed) return;
    const current = readers.filter(watch => feed.watches.has(watch));
    let next = current.length < feed.watches.size ? 0 : (this.options.pollMs ?? STREAM_POLL_MS);
    // A deleted task closes its streams.
    if (found === undefined) for (const watch of current) this.end(watch);
    else if (found) {
      const { status, lines, pendingLogs, pendingResult } = found;
      const full = lines.length === STREAM_LINES;
      const done = DONE.has(status.status) && !full && !pendingLogs && !pendingResult;
      const events = lines.map(
        line =>
          [line.seq, `id: ${line.seq}\nevent: log\ndata: ${JSON.stringify(line)}\n\n`] as const,
      );
      feed.head = Math.max(from, lines.at(-1)?.seq ?? from);
      if (full) next = 0;
      for (const watch of current) {
        const text = events.flatMap(([seq, text]) => (seq > watch.cursor ? [text] : [])).join('');
        watch.cursor = Math.max(watch.cursor, lines.at(-1)?.seq ?? -1);
        if (done) this.end(watch, `${text}event: end\ndata: {}\n\n`);
        else if (text) this.send(watch, text);
      }
    }
    if (this.feeds.get(feed.key) !== feed) return;
    feed.timer = setTimeout(() => void this.read(feed), next);
    feed.timer.unref?.();
  }
}

/** `log` events past `after`, then `end` once the task is done and its logs and result are in. */
export function streamTask(
  req: Request,
  ctx: ServerContext,
  key: string,
  after: number,
  read: LogRead,
): Response {
  const watcher = ctx.logWatcher ?? new LogWatcher();
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`retry: ${STREAM_POLL_MS}\n\n`));
      stop = watcher.watch(
        `${ctx.organizationId}:${key}`,
        after,
        read,
        text => controller.enqueue(encoder.encode(text)),
        () => controller.close(),
      );
      const leave = () => {
        stop();
        try {
          controller.close();
        } catch {}
      };
      if (req.signal.aborted) leave();
      else req.signal.addEventListener('abort', leave);
    },
    cancel() {
      stop();
    },
  });

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
