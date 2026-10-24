import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { type Params } from '../routes/match';
import { loadTask, resolveTaskDir } from '../../core/state';
import { type RunnerRecord, type TaskStatus } from '../store/types';
import { type ServerContext } from '../context';
import { json } from '../routes/http';
import { localLog, localTask, localTasks, sweepLocalQueue } from './local';
import { DONE, localRows } from './admin';
import {
  StoreQueue,
  TOMBSTONE_MS,
  taskTimes,
  type AudienceCount,
  type LogTail,
  type Tombstone,
} from './queue';
import { runnerItems } from '../settings/runners';
import { canView, taskAudience, viewer, type Viewer } from './access';

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
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = ctx.routeTask ?? (await ctx.store.get('task', taskId));
  if (!status && ctx.taskPrincipal) return json({ error: `No task "${taskId}"` }, 404);
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

  return streamTask(
    req,
    ctx,
    taskId,
    Number.isFinite(last) ? last : cursor,
    { ctx, id: taskId },
    streamView(ctx),
  );
}

/** A log stream asks the stored member lists again at most this often. */
const STREAM_SEEN_MS = 30_000;

/** Whether a log stream's viewer still sees its task: from the row it read, asking the member lists of a private space at most every `STREAM_SEEN_MS`, and at once when the task's audience changed. */
function streamView(ctx: ServerContext) {
  const now = ctx.now ?? Date.now;
  // The stream's guard has just asked.
  let checked: { at: number; audience?: string; seen: boolean } = { at: now(), seen: true };

  return async (status: LogTail['status']) => {
    const { task } = status;
    const view = await viewer(ctx);
    if (canView(view && { ...view, spaces: [] }, task)) return true;
    if (!task.audience?.startsWith('space:')) return false;
    if (checked.audience !== task.audience || now() - checked.at >= STREAM_SEEN_MS)
      checked = {
        at: now(),
        audience: task.audience,
        seen: canView(await viewer(ctx, [task.audience]), task),
      };

    return checked.seen;
  };
}

/** A finished CLI task whose result file predates its last turn, so its worker is still writing it. */
function resultPending(cwd: string, status: TaskStatus, missing = false) {
  if (!DONE.has(status.status) || status.error || status.status === 'cancelled') return false;
  const task = loadTask(cwd, status.task.id);
  // A result written in this turn may land before or after its completed stamp.
  const started = Date.parse(task?.resumedAt ?? task?.createdAt ?? '') || 0;

  return (
    missing ||
    (fs.statSync(path.join(resolveTaskDir(cwd, status.task.id), 'result.json'), {
      throwIfNoEntry: false,
    })?.mtimeMs ?? 0) < started
  );
}

const STREAM_LINES = 500;

/** How far back a poll's last event id resumes; older ids reload the page. */
const EVENTS_MS = 290_000;

/** Task ids one events stream may ask about. */
const EVENTS_TASKS = 100;

// A write stamps `updatedAt` before its slower work commits, so a read looks back this far.
const EVENTS_LAG_MS = 30_000;

// A local server scans the CLI's task folders this often, as the list used to poll them.
const LOCAL_SCAN_MS = 4000;

// A workspace's runners are read this often for their online dots; a runner write on this server reads them at the next poll.
const RUNNER_SCAN_MS = 15_000;

// The CLI's archive changes rarely and costs more to read, so it is scanned this often.
const ARCHIVE_SCAN_MS = 15_000;

/** `GET /admin/events?tasks=a,b`: the asked tasks' state and every list change in the caller's workspace since its last event id, from the next read; then the body ends. */
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
  // A resume looks back `EVENTS_MS` at most, in the workspace and server generation that sent its id; else the page reloads its data.
  const known = last > 0 && `-${scope}` === tag;
  const from = known ? Math.min(Math.max(last, now - EVENTS_MS), now) : now;
  const reset = last > 0 && (!known || last < from) ? 'event: reset\ndata: {}\n\n' : '';
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`id: ${from}${tag}\n\n${reset}`));
      stop = watcher.watch(
        ctx,
        ids,
        from,
        text => controller.enqueue(encoder.encode(text)),
        () => controller.close(),
      );
      // A client that left is left out of the read, and its body ends.
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
    approvals: status.approvals ?? task.context?.approvals ?? null,
    // A list hears nothing of an auto-archive; it takes it up on its next read.
    archivedAt: status.autoArchived && !asked ? undefined : archivedAt,
    createdAt,
    startedAt,
    finishedAt,
    ...taskTimes(status),
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
  /** Rows updated after this are news to the request: its last event id. */
  from: number;
  /** This server's generation in each event id, when its delete history is in memory. */
  tag: string;
  send: (text: string) => void;
  close: () => void;
};

/** One workspace's requests in a read and the tasks they ask about. */
type Scope = { ctx: ServerContext; ids: Set<string> };

/** A workspace's active counts by audience; a task's stream counts its children alone. */
const countsKey = (organizationId: string, parent?: string) => `${organizationId}:${parent ?? ''}`;

/** One read for every events request waiting on this server, answered to each; a request that arrives during a read waits for the next. */
export class TaskWatcher {
  private watches = new Set<Watch>();
  private counts = new Map<string, { groups: AudienceCount[]; fingerprint: string; at: number }>();
  /** Each member's view of the private spaces, by workspace, member and task principal. */
  private views = new Map<
    string,
    { at: number; audiences: Set<string>; view: Promise<Viewer | undefined> }
  >();
  private runners = new Map<
    string,
    { at: number; records: Array<{ id: string; value: RunnerRecord }> }
  >();
  private reading = false;
  private closed = false;
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
      localScanMs?: number;
      archiveScanMs?: number;
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
    const watch: Watch = { ctx, ids: new Set(ids), from, tag: this.tag(ctx), send, close };
    this.watches.add(watch);
    this.poll();

    return () => this.watches.delete(watch);
  }

  /** What every event id carries: its workspace, and with a store queue, whose deletes a restart loses, this server's generation. */
  tag(ctx: ServerContext) {
    const workspace = createHash('sha256').update(ctx.organizationId).digest('hex').slice(0, 8);
    return `-${workspace}${ctx.queue instanceof StoreQueue ? `.${this.generation}` : ''}`;
  }

  /** A runner was added, changed or removed: its workspace's streams hear it at the next poll. */
  runnersChanged(organizationId: string) {
    this.runners.delete(organizationId);
  }

  /** Ends every request and refuses new ones. */
  close() {
    this.closed = true;
    for (const watch of [...this.watches]) this.end(watch);
  }

  private end(watch: Watch) {
    this.watches.delete(watch);
    try {
      watch.close();
    } catch {}
  }

  /** Reads for every waiting request unless a read is out; each request it took ends after it, failed or not. */
  private poll() {
    if (this.reading || !this.watches.size) return;
    this.reading = true;
    const watches = [...this.watches];
    void this.read(watches, Date.now())
      .catch(error => console.error('coder server: task events failed', error))
      .finally(() => {
        for (const watch of watches) this.end(watch);
        this.reading = false;
        this.poll();
      });
  }

  private async read(watches: Watch[], at: number) {
    // Caches outlive requests; an entry older than its use is read again.
    for (const [key, { at: when }] of this.counts)
      if (at - when >= EVENTS_LAG_MS) this.counts.delete(key);
    for (const [key, { at: when }] of this.views)
      if (at - when >= STREAM_SEEN_MS) this.views.delete(key);
    for (const [key, { at: when }] of this.runners)
      if (at - when >= RUNNER_SCAN_MS) this.runners.delete(key);
    const scopes = new Map<string, Scope>();
    for (const watch of watches) {
      const scope = scopes.get(watch.ctx.organizationId) ?? { ctx: watch.ctx, ids: new Set() };
      for (const id of watch.ids) scope.ids.add(id);
      scopes.set(watch.ctx.organizationId, scope);
    }
    this.reads++;
    const rows = await this.changes(
      scopes,
      Math.min(...watches.map(watch => watch.from)) - EVENTS_LAG_MS,
      at,
    ).catch(error => {
      console.error('coder server: task events failed', error);
      return undefined;
    });
    if (!rows) return;
    // One count read per workspace, grouped by audience, so every stream's own count is a sum; a task's stream counts its children alone.
    const groups = new Map<string, AudienceCount[]>();
    try {
      for (const [organizationId, { ctx }] of scopes) {
        const fingerprint = JSON.stringify([
          [...(rows.rows.get(organizationId) ?? [])]
            .map(([id, row]) => [id, row.status, row.archivedAt])
            .sort(),
          [...(rows.deleted.get(organizationId)?.keys() ?? [])].sort(),
        ]);
        const own = watches.filter(watch => watch.ctx.organizationId === organizationId);
        for (const parent of new Set(own.map(watch => watch.ctx.taskPrincipal?.task))) {
          const key = countsKey(organizationId, parent);
          const cached = this.counts.get(key);
          const changed = cached?.fingerprint !== fingerprint;
          const counted = ctx.local
            ? [...(rows.rows.get(organizationId)?.values() ?? [])]
                .filter(
                  row =>
                    !row.archivedAt &&
                    ['queued', 'running', 'waiting'].includes(row.status) &&
                    (!parent || row.task.parent === parent),
                )
                .map(row => ({
                  ...taskAudience(row.task),
                  requestedBy: row.task.requestedBy,
                  active: 1,
                }))
            : !changed
              ? cached!.groups
              : parent
                ? [
                    {
                      audience: '',
                      active: (
                        await ctx.queue.counts(organizationId, {
                          archived: false,
                          statuses: ['queued', 'running', 'waiting'],
                          parent,
                        })
                      ).active,
                    },
                  ]
                : await ctx.queue.activeCounts(organizationId);
          groups.set(key, counted);
          this.counts.set(key, { groups: counted, fingerprint, at: changed ? at : cached!.at });
        }
      }
    } catch (error) {
      console.error('coder server: task counts failed', error);
      return;
    }
    // Each member's view of the private spaces among the changes and counts: one read per member, shared by their streams, again when a private task changed, a new space shows or `STREAM_SEEN_MS` passed.
    const viewers = new Map(
      await Promise.all(
        watches.map(async watch => {
          const { organizationId, session, taskPrincipal } = watch.ctx;
          const key = `${organizationId}:${session?.user.id ?? ''}:${taskPrincipal?.task ?? ''}`;
          const changed = [...(rows.rows.get(organizationId)?.values() ?? [])];
          const audiences = new Set(
            [
              ...changed.map(row => row.task.audience),
              ...[...(rows.deleted.get(organizationId)?.values() ?? [])].map(gone => gone.audience),
              ...(groups.get(countsKey(organizationId, taskPrincipal?.task)) ?? []).map(
                group => group.audience,
              ),
            ].filter((audience): audience is string => Boolean(audience?.startsWith('space:'))),
          );
          const cached = this.views.get(key);
          if (
            !cached ||
            [...audiences].some(audience => !cached.audiences.has(audience)) ||
            changed.some(row => row.updatedAt > cached.at && audiences.has(row.task.audience!))
          ) {
            const view = viewer(watch.ctx, [...audiences]);
            const entry = { at, audiences, view };
            this.views.set(key, entry);
            view.catch(() => this.views.get(key) === entry && this.views.delete(key));
          }

          return [watch, await this.views.get(key)!.view] as const;
        }),
      ),
    );
    await Promise.all(
      [...scopes]
        .filter(([organizationId]) => !this.runners.has(organizationId))
        .map(async ([organizationId, { ctx }]) => {
          this.runners.set(organizationId, { at, records: [] });
          const scan = this.runners.get(organizationId)!;
          try {
            const records = await ctx.store.list('runner');
            if (this.runners.get(organizationId) === scan) scan.records = records;
          } catch (error) {
            if (this.runners.get(organizationId) === scan) this.runners.delete(organizationId);
            console.error('coder server: runner events failed', error);
          }
        }),
    );

    for (const watch of watches) {
      if (!this.watches.has(watch)) continue;
      let out: string[] = [];
      try {
        const view = viewers.get(watch);
        out = this.news(watch, rows, at, view);
        const counted = groups.get(
          countsKey(watch.ctx.organizationId, watch.ctx.taskPrincipal?.task),
        );
        const active = counted
          ?.filter(group => canView(view, group))
          .reduce((sum, group) => sum + group.active, 0);
        if (active !== undefined)
          out.push(`id: ${at}${watch.tag}\nevent: counts\ndata: ${JSON.stringify({ active })}\n\n`);
        const scan = this.runners.get(watch.ctx.organizationId);
        if (scan)
          out.push(
            `id: ${at}${watch.tag}\nevent: runners\ndata: ${JSON.stringify({ items: runnerItems(watch.ctx, scan.records, at) })}\n\n`,
          );
      } catch {}
      // A quiet answer still moves the resume point.
      if (!out.length) out.push(`id: ${at}${watch.tag}\n\n`);
      try {
        watch.send(out.join(''));
      } catch {}
    }
  }

  /** Each workspace's rows and deletes from one queue read, with a local server's CLI tasks merged in. */
  private async changes(scopes: Map<string, Scope>, since: number, at: number) {
    const changed = await [...scopes.values()][0]!.ctx.queue.changes(
      [...scopes].map(([organizationId, scope]) => ({
        organizationId,
        ids: [...scope.ids],
        fresh: [...scope.ids],
      })),
      since,
    );
    const rows = new Map<string, Map<string, TaskStatus>>();
    for (const { organizationId, status } of changed.rows) {
      const scope = rows.get(organizationId) ?? new Map<string, TaskStatus>();
      rows.set(organizationId, scope.set(status.task.id, status));
    }
    const deleted = new Map<string, Map<string, Tombstone>>();
    for (const { organizationId, id, ...tombstone } of changed.deleted) {
      const scope = deleted.get(organizationId) ?? new Map<string, Tombstone>();
      deleted.set(organizationId, scope.set(id, tombstone));
    }
    for (const [organizationId, { ctx }] of scopes) {
      if (!ctx.local) continue;
      const queued = [...(rows.get(organizationId)?.values() ?? [])];
      let scan = this.scans.get(ctx.local.cwd);
      // A queue change since the last scan rescans, so an older CLI row never wins over it.
      if (
        !scan ||
        at - scan.at >= (this.options.localScanMs ?? LOCAL_SCAN_MS) ||
        queued.some(row => row.updatedAt > scan!.at)
      ) {
        // Archived tasks too, so an archive list hears a running one finish.
        const fresh =
          !scan || at - scan.archivedAt >= (this.options.archiveScanMs ?? ARCHIVE_SCAN_MS);
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

  /** The events of one request: its asked tasks, and the list changes since its last event id. */
  private news(
    watch: Watch,
    { rows, deleted: removed }: Awaited<ReturnType<TaskWatcher['changes']>>,
    at: number,
    viewer: Viewer | undefined,
  ): string[] {
    const { ctx } = watch;
    const parent = ctx.taskPrincipal?.task;
    const found = rows.get(ctx.organizationId) ?? new Map<string, TaskStatus>();
    // A task's request keeps only the asked ids the read finds as its children.
    if (parent)
      for (const id of watch.ids) if (found.get(id)?.task.parent !== parent) watch.ids.delete(id);
    const out: string[] = [];
    // Each task's event in this answer, so it goes out once.
    const sent = new Map<string, string>();
    const emit = (id: string, data: object) => {
      const text = JSON.stringify(data);
      if (sent.get(id) === text) return;
      sent.set(id, text);
      out.push(`id: ${at}${watch.tag}\nevent: task\ndata: ${text}\n\n`);
    };
    const deleted = (id: string) => ({ id, deleted: true });
    const gone = (id: string) => {
      // An asked task keeps its result, archived or not.
      const local = ctx.local && !parent && localTask(ctx.local.cwd, id, watch.ids.has(id));
      emit(id, local ? eventState(local, watch.ids.has(id)) : deleted(id));
      if (local && ctx.local) {
        const archived = this.archived.get(ctx.local.cwd) ?? new Set<string>();
        this.archived.set(ctx.local.cwd, archived.add(id));
      }
    };

    for (const [id, status] of found) {
      if (parent && status.task.parent !== parent) continue;
      if (!canView(viewer, status.task)) continue;
      const asked = watch.ids.has(id);
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
        at - (status.finishedAt ?? 0) < EVENTS_LAG_MS &&
        resultPending(ctx.local.cwd, status)
      ) {
        // Known, so an archive or delete before its result still goes out.
        sent.set(id, '');
        continue;
      }
      if (asked || status.updatedAt > watch.from - EVENTS_LAG_MS) emit(id, data);
    }
    for (const id of watch.ids) if (!found.has(id)) gone(id);
    // A task's request hears only the deletes of its children.
    for (const [id, { at: when, ...tombstone }] of removed.get(ctx.organizationId) ?? [])
      if (
        when > watch.from - EVENTS_LAG_MS &&
        canView(viewer, tombstone) &&
        (!parent || tombstone.parent === parent)
      )
        emit(id, deleted(id));
    // A local read holds every task, so one that left its folders since the last event id was archived or deleted.
    if (ctx.local)
      for (const [id, when] of this.left.get(ctx.local.cwd) ?? [])
        if (
          when > watch.from - EVENTS_LAG_MS &&
          !found.has(id) &&
          sent.get(id) !== JSON.stringify(deleted(id))
        )
          gone(id);

    return out;
  }
}

type LogRead = (cursor: number) => Promise<
  | (LogTail & {
      pendingLogs?: boolean;
      pendingResult?: boolean;
    })
  | undefined
>;

/** Where a feed's lines come from: a stored task, or a read of its own. */
type LogSource = LogRead | { ctx: ServerContext; id: string };

type LogWatch = {
  /** The last line this request has. */
  cursor: number;
  feed: LogFeed;
  send: (text: string) => void;
  close: () => void;
  /** Whether this request's viewer still sees the task, from the row each read brings. */
  sees?: (status: LogTail['status']) => Promise<boolean>;
};

type LogFeed = {
  key: string;
  source: LogSource;
  watches: Set<LogWatch>;
  /** When the read in flight started. */
  reading?: number;
};

/** A log read out this long is stalled: its database statements are cancelled, and a new request retires its feed. */
const LOG_READ_MS = 10_000;

/** One read at a time for each task's log requests on this server, from the earliest of their cursors; a request ends after a read that brings less than a full page. */
export class LogWatcher {
  private feeds = new Map<string, LogFeed>();
  private closed = false;
  /** Feed reads so far, for tests and metrics. */
  reads = 0;

  constructor(private readonly options: { stallMs?: number } = {}) {}

  watch(
    key: string,
    after: number,
    source: LogSource,
    send: (text: string) => void,
    close: () => void,
    sees?: LogWatch['sees'],
  ): () => void {
    if (this.closed) {
      queueMicrotask(close);
      return () => {};
    }
    let feed = this.feeds.get(key);
    const stalled =
      feed?.reading !== undefined &&
      Date.now() - feed.reading >= (this.options.stallMs ?? LOG_READ_MS);
    // A stalled feed is retired: its requests move to a fresh one, and its read's answer is dropped when it settles.
    if (!feed || stalled) {
      const fresh: LogFeed = { key, source, watches: new Set() };
      if (feed) {
        for (const watch of feed.watches) fresh.watches.add(Object.assign(watch, { feed: fresh }));
        feed.watches.clear();
      }
      this.feeds.set(key, (feed = fresh));
    }
    const watch: LogWatch = { cursor: after, feed, send, close, sees };
    feed.watches.add(watch);
    // A read out takes up this request when it settles.
    if (feed.reading === undefined) void this.read(feed);

    return () => this.drop(watch);
  }

  /** Ends every request and refuses new ones. */
  close() {
    this.closed = true;
    for (const feed of [...this.feeds.values()])
      for (const watch of [...feed.watches]) this.end(watch);
  }

  private drop(watch: LogWatch) {
    const { feed } = watch;
    if (!feed.watches.delete(watch) || feed.watches.size) return;
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

  /** Reads a feed's lines past the earliest cursor of its requests and answers them; the guard holds until the read settles, so a feed never has two reads out. */
  private async read(feed: LogFeed) {
    // A request that joins during the read waits for a read of its own.
    const readers = [...feed.watches];
    const from = Math.min(...readers.map(watch => watch.cursor));
    feed.reading = Date.now();
    this.reads++;
    const failed = (error: unknown) => {
      console.error('coder server: task log read failed', error);
      return null;
    };
    const { source } = feed;
    let found: Awaited<ReturnType<LogRead>> | null;
    if (typeof source === 'function') found = await source(from).catch(failed);
    else {
      const { ctx, id } = source;
      const tails = () =>
        ctx.queue.logTails([{ organizationId: ctx.organizationId, id, after: from }], STREAM_LINES);
      found = await (ctx.statementTimeout ? ctx.statementTimeout(LOG_READ_MS, tails) : tails())
        .then(([tail]) => tail)
        .catch(failed);
    }
    await this.settle(feed, readers, found);
  }

  /** Answers one feed's read to the requests it served. */
  private async settle(
    feed: LogFeed,
    readers: LogWatch[],
    found: Awaited<ReturnType<LogRead>> | null,
  ) {
    const lost = found
      ? await Promise.all(
          readers.map(
            async watch => (await watch.sees?.(found.status).catch(() => false)) === false,
          ),
        )
      : [];
    feed.reading = undefined;
    if (this.feeds.get(feed.key) !== feed) return;
    // A request whose viewer no longer sees the task ends.
    readers.forEach((watch, index) => lost[index] && this.end(watch));
    const current = readers.filter(watch => feed.watches.has(watch));
    let again = current.length < feed.watches.size;
    // A failed read or a deleted task ends its requests.
    if (!found) for (const watch of current) this.end(watch);
    else {
      const { status, lines, pendingLogs, pendingResult } = found;
      const full = lines.length === STREAM_LINES;
      const done = DONE.has(status.status) && !full && !pendingLogs && !pendingResult;
      const events = lines.map(
        line =>
          [line.seq, `id: ${line.seq}\nevent: log\ndata: ${JSON.stringify(line)}\n\n`] as const,
      );
      if (full) again = true;
      const approval =
        status.status === 'waiting' ? (status.approval as { id?: string } | undefined) : undefined;
      for (const watch of current) {
        let text = events.flatMap(([seq, text]) => (seq > watch.cursor ? [text] : [])).join('');
        if (!full && !done) text += 'event: caught-up\ndata: {}\n\n';
        if (!full && approval?.id) text += `event: approval\ndata: ${JSON.stringify(approval)}\n\n`;
        watch.cursor = Math.max(watch.cursor, lines.at(-1)?.seq ?? -1);
        if (done) this.end(watch, `${text}event: end\ndata: {}\n\n`);
        else if (full) this.send(watch, text);
        else this.end(watch, text);
      }
    }
    // A full page, or a request that joined during the read, reads again now.
    if (again && this.feeds.get(feed.key) === feed) void this.read(feed);
  }
}

/** `log` events past `after` from the next read, `approval` when the task waits on one, and `end` once the task is done and its logs and result are in; then the body ends. */
function streamTask(
  req: Request,
  ctx: ServerContext,
  key: string,
  after: number,
  source: LogSource,
  sees?: LogWatch['sees'],
): Response {
  const watcher = ctx.logWatcher ?? new LogWatcher();
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      stop = watcher.watch(
        `${ctx.organizationId}:${key}`,
        after,
        source,
        text => controller.enqueue(encoder.encode(text)),
        () => controller.close(),
        sees,
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
