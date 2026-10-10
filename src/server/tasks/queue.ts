/** The task queue: claim, retry, finish, cancel. Logs and lookups go through the `Store` (`task`, `tasklog`). */
import { randomUUID } from 'node:crypto';
import { noteKey } from './thread';
import { createTaskToken } from './token';
import type { AgentTask, TaskSource } from '../../agent/types';
import type { TaskLogLine, TaskStatus, Store, UsageRecord } from '../store/types';
import { scoped, type ServerContext } from '../context';
import { taskRunner } from '../runners';
import { pushLocalInbox } from './local';
import { byListKey, listRank, type ListKey } from '../../core/defaults';
import { archiveDue } from '../../core/state';

export interface ClaimedTask {
  organizationId: string;
  status: TaskStatus;
}
/** A message to a running task: a steer, an answer, or an approval. */
export interface InboxEntry {
  seq: number;
  generation: number;
  at: number;
  kind: 'steer' | 'ask' | 'approve' | 'cancel';
  value: unknown;
}

export type Outcome = Pick<TaskStatus, 'result' | 'error' | 'tokens'> & {
  status: 'completed' | 'failed' | 'cancelled';
};

export interface TaskFilter {
  status?: TaskStatus['status'];
  /** Any of these states; `status` wins when both are given. */
  statuses?: TaskStatus['status'][];
  agent?: string;
  source?: TaskSource;
  archived?: boolean;
  /** Case-insensitive match on the request text, agent, or task id. */
  q?: string;
}

export interface TaskListOptions extends TaskFilter {
  limit?: number;
  /** Keyset cursor: only tasks after this one, in list order. */
  before?: ListCursor;
  summary?: boolean;
}

export interface TaskCounts {
  all: number;
  active: number;
  waiting: number;
}

export interface TaskMetrics {
  tasks: Record<TaskStatus['status'], number>;
  queueDepth: number;
}

export const ACTIVE_STATES: TaskStatus['status'][] = ['queued', 'running', 'waiting'];

/** Whether a task passes a filter; the memory queue's version of the SQL predicate. */
export function matchesTask(status: TaskStatus, filter: TaskFilter): boolean {
  const states = filter.status ? [filter.status] : filter.statuses;
  if (states && !states.includes(status.status)) return false;
  if (filter.agent && status.task.agent !== filter.agent) return false;
  if (filter.source && status.task.source !== filter.source) return false;
  if (filter.archived !== undefined && filter.archived !== (status.archivedAt !== undefined))
    return false;
  const q = filter.q?.trim().toLowerCase();
  return (
    !q ||
    [status.task.prompt ?? status.task.event?.text, status.task.agent, status.task.id].some(value =>
      value?.toLowerCase().includes(q),
    )
  );
}

export type ListCursor = ListKey;

export const listCursor = (row: TaskStatus): ListCursor => ({
  rank: listRank(row.status),
  createdAt: row.createdAt,
  id: row.task.id,
});

/** The CLI's list order, so a keyset cursor is stable under inserts. */
export const listOrder = (a: TaskStatus, b: TaskStatus) => byListKey(listCursor(a), listCursor(b));

/** Whether a row comes after the cursor in list order. */
export const afterCursor = (row: TaskStatus, before?: ListCursor) =>
  !before || byListKey(listCursor(row), before) > 0;

export interface TaskFence {
  generation?: number;
  attempts?: number;
  tokenHash?: string | null;
  handle?: string | null;
  lastSeenAt?: number | null;
  updatedAt?: number;
  statuses?: TaskStatus['status'][];
}

export interface InboxAck {
  generation: number;
  seq: number;
  answers?: Array<{ seq: number; value: unknown }>;
}

export type TaskPatch = Partial<
  Pick<
    TaskStatus,
    | 'status'
    | 'handle'
    | 'tokenHash'
    | 'lastSeenAt'
    | 'logCursor'
    | 'logSeq'
    | 'logBytes'
    | 'archivedAt'
    | 'autoArchived'
    | 'approval'
  >
> & { answer?: unknown };

export interface Completion {
  outcome: Outcome;
  usage: UsageRecord;
  note?: { key: string; value: string; ttlMs: number };
  attempts: number;
  tokenHash: string;
}

export interface Delivery {
  key: string;
  ttlMs: number;
}
interface PendingDelivery {
  pending?: { task?: AgentTask; inbox?: { taskId: string; id: string; entry: InboxEntry } };
}

export function sessionKey(task: Pick<AgentTask, 'agent' | 'requester' | 'event'>): string {
  const event = task.event;
  return JSON.stringify([
    event?.appId,
    event?.installationId,
    event?.chat?.thread.id,
    task.agent,
    task.requester,
    event?.actor.id,
  ]);
}

export function sameSession(task: AgentTask, incoming: AgentTask): boolean {
  return (
    task.flow === 'default' &&
    Boolean(task.event?.actor.id) &&
    sessionKey(task) === sessionKey(incoming)
  );
}

export interface TaskQueue {
  metrics?(organizationId: string, since: number): Promise<TaskMetrics>;
  scheduler?: { running?: Promise<void>; waiting?: Promise<void> };
  inboxDelivery?: Map<string, { work?: Promise<void>; again?: boolean }>;
  deliver(
    organizationId: string,
    task: AgentTask,
    now: number,
    delivery: Delivery,
    steers: boolean,
    maxQueued?: number,
    create?: boolean,
  ): Promise<{ taskId?: string; steered?: boolean }>;
  enqueue(
    organizationId: string,
    task: AgentTask,
    now: number,
    delivery?: { key: string; ttlMs: number },
    maxQueued?: number,
  ): Promise<boolean>;
  /** The oldest queued task of any organization, now running; `undefined` when the queue is empty. */
  claim(
    now: number,
    maxTasks?: number,
    knownWork?: boolean,
    concurrentTasks?: number,
  ): Promise<(ClaimedTask & { token: string; more: boolean }) | undefined>;
  touch(
    organizationId: string,
    id: string,
    tokenHash: string,
    attempts: number,
    now: number,
    allowCompleted?: boolean,
  ): Promise<TaskStatus | undefined>;
  patchTask(
    organizationId: string,
    id: string,
    patch: TaskPatch,
    now: number,
    fence?: TaskFence,
  ): Promise<boolean>;
  /** The CLI's auto-archive sweep over tasks stopped longer than AUTO_ARCHIVE_MS, or only `ids`; silent, so updatedAt stays. */
  archiveStopped(organizationId: string, now: number, ids?: string[]): Promise<void>;
  continueTask(
    organizationId: string,
    id: string,
    task: Pick<AgentTask, 'prompt' | 'context'>,
    now: number,
    fence: TaskFence,
  ): Promise<boolean>;
  completeTask(
    organizationId: string,
    id: string,
    completion: Completion,
    now: number,
  ): Promise<boolean>;
  requeue(organizationId: string, id: string, now: number, fence?: TaskFence): Promise<boolean>;
  finish(
    organizationId: string,
    id: string,
    outcome: Outcome,
    now: number,
    fence?: TaskFence,
  ): Promise<boolean>;
  /** Queued tasks are cancelled at once; running ones are flagged for the worker. False when unknown or done. */
  cancel(organizationId: string, id: string, now: number, fence?: TaskFence): Promise<boolean>;
  appendLogs(
    organizationId: string,
    id: string,
    lines: TaskLogLine[],
    from: { seq: number; cursor: number },
    progress: { cursor: number; seq: number; bytes: number },
    now: number,
    fence: TaskFence,
  ): Promise<boolean>;
  readInbox(
    organizationId: string,
    id: string,
    generation: number,
    after: number,
  ): Promise<InboxEntry[]>;
  fetchInbox(
    organizationId: string,
    id: string,
    tokenHash: string,
    attempts: number,
    after: number,
  ): Promise<InboxEntry[] | undefined>;
  ackInbox(organizationId: string, id: string, ack: InboxAck, fence: TaskFence): Promise<boolean>;
  pendingInbox(): Promise<ClaimedTask[]>;
  cancelRequested(organizationId: string, id: string): Promise<boolean>;
  /** Newest first. */
  list(organizationId: string, opts?: TaskListOptions): Promise<TaskStatus[]>;
  /** In one call, tasks of these organizations updated or deleted after `since`, and the named ones; a store queue returns every task. */
  changes(
    scopes: Array<{ organizationId: string; ids: string[] }>,
    since: number,
  ): Promise<{
    rows: ClaimedTask[];
    deleted: Array<{ organizationId: string; id: string; at: number }>;
  }>;
  /** How many tasks match, and how many of those are active or waiting. */
  counts(organizationId: string, filter?: TaskFilter): Promise<TaskCounts>;
  listWithCounts?(
    organizationId: string,
    opts: TaskListOptions,
  ): Promise<{ items: TaskStatus[]; counts: TaskCounts }>;
  runningCount(): Promise<number>;
  running(): Promise<ClaimedTask[]>;
  appendInbox(
    organizationId: string,
    id: string,
    kind: InboxEntry['kind'],
    value: unknown,
    now: number,
    generation: number,
  ): Promise<InboxEntry | undefined>;
}

/** Delete only the observed conversation, coordinated with the queue's writes. */
/** A deleted task's tombstone outlives any events stream's resume window. */
export const TOMBSTONE_MS = 10 * 60_000;

export async function deleteTask(ctx: ServerContext, status: TaskStatus): Promise<boolean> {
  const id = status.task.id;
  const generation = status.generation ?? 0;
  const fence = {
    generation,
    attempts: status.attempts,
    tokenHash: status.tokenHash ?? null,
    handle: status.handle ?? null,
  };
  if (ctx.queue instanceof StoreQueue) return ctx.queue.deleteTask(ctx.organizationId, id, fence);

  const [{ DrizzleStore }, { task, taskTombstone }, { and, eq, isNull, sql }, { rows }] =
    await Promise.all([
      import('../store/pg/store'),
      import('../store/pg/schema'),
      import('drizzle-orm'),
      import('../store/pg/tables/shared'),
    ]);
  if (!(ctx.store instanceof DrizzleStore))
    throw new Error('Task store does not support fenced deletion');
  const now = (ctx.now ?? Date.now)();
  // The delete and its tombstone commit together, so every server's streams see it.
  const [row] = await rows<{ deleted: number }>(
    ctx.store.db,
    sql`with gone as (
      delete from ${task}
      where ${and(
        eq(task.organizationId, ctx.organizationId),
        eq(task.publicId, id),
        eq(task.generation, generation),
        eq(task.attempts, fence.attempts),
        fence.tokenHash === null ? isNull(task.tokenHash) : eq(task.tokenHash, fence.tokenHash),
        fence.handle === null ? isNull(task.handle) : eq(task.handle, fence.handle),
      )}
      returning organization_id, public_id
    ), marked as (
      insert into ${taskTombstone} (organization_id, public_id, deleted_at)
      select organization_id, public_id, ${new Date(now).toISOString()}::timestamptz from gone
    ), pruned as (
      delete from ${taskTombstone}
      where deleted_at < ${new Date(now - TOMBSTONE_MS).toISOString()}::timestamptz
    )
    select count(*)::int as deleted from gone`,
  );

  return Boolean(row?.deleted);
}

export async function addInbox(
  ctx: ServerContext,
  id: string,
  kind: InboxEntry['kind'],
  value: unknown,
  generation: number,
): Promise<InboxEntry | undefined> {
  const entry = await ctx.queue.appendInbox(
    ctx.organizationId,
    id,
    kind,
    value,
    (ctx.now ?? Date.now)(),
    generation,
  );
  if (entry) await pushInbox(ctx, id);
  return entry;
}

export async function readInbox(
  ctx: ServerContext,
  id: string,
  after = -1,
  generation?: number,
): Promise<InboxEntry[]> {
  generation ??= (await ctx.store.get('task', id))?.generation ?? 0;

  return ctx.queue.readInbox(ctx.organizationId, id, generation, after);
}

const DONE = new Set<TaskStatus['status']>(['completed', 'failed', 'cancelled']);

/** Queue over a plain `Store` (memory, file): one process, so a promise chain is the lock. */
export class StoreQueue implements TaskQueue {
  private lock: Promise<unknown> = Promise.resolve();
  /** Deleted task ids and when, for events streams. */
  private tombstones = new Map<string, number>();

  constructor(private readonly store: Store) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.lock.then(work, work);
    this.lock = next.catch(() => {});
    return next;
  }

  private async read(id: string): Promise<TaskStatus | undefined> {
    return this.store.get('task', id);
  }

  async enqueue(
    _organizationId: string,
    task: AgentTask,
    now: number,
    delivery?: { key: string; ttlMs: number },
    maxQueued?: number,
  ): Promise<boolean> {
    return this.serial(() => this.insert(task, now, delivery, maxQueued));
  }

  private async insert(
    task: AgentTask,
    now: number,
    delivery?: Delivery,
    maxQueued?: number,
  ): Promise<boolean> {
    const receipt = delivery && (await this.store.get<PendingDelivery>('delivery', delivery.key));
    if (receipt && !receipt.pending) return false;

    task = receipt?.pending?.task ?? task;

    const existing = await this.read(task.id);
    if (!existing && maxQueued !== undefined) {
      const queued = (await this.store.list('task')).filter(
        row => row.value.status === 'queued',
      ).length;
      if (queued >= maxQueued) throw new Error('Organization task queue is full');
    }
    if (delivery && !receipt)
      await this.store.put('delivery', delivery.key, { at: now, pending: { task } });
    if (!existing)
      await this.store.put('task', task.id, {
        task,
        status: 'queued',
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      } satisfies TaskStatus);
    if (delivery)
      await this.store.put('delivery', delivery.key, { at: now }, { ttlMs: delivery.ttlMs });

    return true;
  }

  private async nextSeq(id: string): Promise<number> {
    const entries = await this.store.list('inbox', { prefix: `${id}:` });
    const pending = await this.store.list<PendingDelivery>('delivery');
    const reserved = pending.flatMap(row =>
      row.value.pending?.inbox?.id.startsWith(`${id}:`) ? [row.value.pending.inbox.entry.seq] : [],
    );

    return (
      Math.max(
        (await this.read(id))?.inboxSeq ?? -1,
        ...entries.map(row => row.value.seq),
        ...reserved,
      ) + 1
    );
  }

  deliver(
    organizationId: string,
    task: AgentTask,
    now: number,
    delivery: Delivery,
    steers: boolean,
    maxQueued?: number,
    create = true,
  ): Promise<{ taskId?: string; steered?: boolean }> {
    const work = async () => {
      let receipt = await this.store.get<PendingDelivery>('delivery', delivery.key);
      if (receipt && !receipt.pending) return {};
      if (receipt?.pending?.inbox) {
        const { taskId, id, entry } = receipt.pending.inbox;
        const target = await this.read(taskId);
        if (
          target &&
          ACTIVE_STATES.includes(target.status) &&
          (target.generation ?? 0) === entry.generation &&
          sameSession(target.task, task)
        ) {
          await this.store.put('task', taskId, {
            ...target,
            inboxSeq: Math.max(target.inboxSeq ?? -1, entry.seq),
            updatedAt: now,
          });
          await this.store.put('inbox', id, entry);
          await this.store.put('delivery', delivery.key, { at: now }, { ttlMs: delivery.ttlMs });
          return { steered: true };
        }
        await this.store.delete('delivery', delivery.key);
        receipt = undefined;
      }
      const active =
        steers && !receipt?.pending?.task
          ? (
              await this.list(organizationId, {
                statuses: ACTIVE_STATES,
                agent: task.agent,
                source: task.source,
              })
            ).find(row => sameSession(row.task, task))
          : undefined;
      if (!active)
        return create && (await this.insert(task, now, delivery, maxQueued))
          ? { taskId: task.id }
          : {};
      const seq = await this.nextSeq(active.task.id);
      const entry: InboxEntry = {
        seq,
        generation: active.generation ?? 0,
        at: now,
        kind: 'steer',
        value: { text: task.event!.text },
      };
      const id = `${active.task.id}:${String(seq).padStart(8, '0')}`;
      await this.store.put('delivery', delivery.key, {
        at: now,
        pending: { inbox: { taskId: active.task.id, id, entry } },
      });
      await this.store.put('task', active.task.id, { ...active, inboxSeq: seq, updatedAt: now });
      await this.store.put('inbox', id, entry);
      await this.store.put('delivery', delivery.key, { at: now }, { ttlMs: delivery.ttlMs });
      return { steered: true };
    };
    return this.serial(work);
  }

  claim(
    now: number,
    maxTasks?: number,
  ): Promise<(ClaimedTask & { token: string; more: boolean }) | undefined> {
    return this.serial(async () => {
      const rows = (await this.store.list('task')).map(row => row.value);
      if (
        maxTasks !== undefined &&
        rows.filter(row => ['running', 'waiting'].includes(row.status)).length >= maxTasks
      )
        return undefined;

      const queued = rows
        .filter(status => status.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt);
      const next = queued[0];
      if (!next) return undefined;

      const token = createTaskToken(next.task.id, 'default', next.attempts + 1);
      const status: TaskStatus = {
        ...next,
        tokenHash: token.hash,
        lastSeenAt: now,
        status: 'running',
        attempts: next.attempts + 1,
        startedAt: now,
        updatedAt: now,
      };

      await this.store.put('task', status.task.id, status);

      return {
        organizationId: 'default',
        status,
        token: token.token,
        more:
          queued.length > 1 &&
          (maxTasks === undefined ||
            rows.filter(row => ['running', 'waiting'].includes(row.status)).length + 1 < maxTasks),
      };
    });
  }

  private allowed(status: TaskStatus, fence: TaskFence): boolean {
    return (
      (fence.generation === undefined || (status.generation ?? 0) === fence.generation) &&
      (fence.attempts === undefined || status.attempts === fence.attempts) &&
      (fence.tokenHash === undefined || (status.tokenHash ?? null) === fence.tokenHash) &&
      (fence.handle === undefined || (status.handle ?? null) === fence.handle) &&
      (fence.lastSeenAt === undefined || (status.lastSeenAt ?? null) === fence.lastSeenAt) &&
      (fence.updatedAt === undefined || status.updatedAt === fence.updatedAt) &&
      (!fence.statuses || fence.statuses.includes(status.status))
    );
  }

  touch(
    organizationId: string,
    id: string,
    tokenHash: string,
    attempts: number,
    now: number,
    allowCompleted = false,
  ): Promise<TaskStatus | undefined> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (
        !current ||
        !this.allowed(current, { tokenHash, attempts }) ||
        (!allowCompleted && DONE.has(current.status)) ||
        current.status === 'queued'
      )
        return undefined;
      if (DONE.has(current.status)) return current;
      const next = { ...current, lastSeenAt: now, updatedAt: now };
      await this.store.put('task', id, next);
      return next;
    });
  }

  async archiveStopped(_organizationId: string, now: number, ids?: string[]): Promise<void> {
    const due = (status?: TaskStatus): status is TaskStatus =>
      status !== undefined &&
      DONE.has(status.status) &&
      status.archivedAt === undefined &&
      (!ids || ids.includes(status.task.id)) &&
      archiveDue(status.finishedAt ?? status.updatedAt, now);

    for (const { value } of await this.store.list('task'))
      if (due(value))
        await this.serial(async () => {
          // Rechecked under the lock, so a task continued since the list read stays.
          const current = await this.read(value.task.id);
          if (due(current))
            await this.store.put('task', current.task.id, {
              ...current,
              archivedAt: now,
              autoArchived: true,
            });
        });
  }

  patchTask(
    _organizationId: string,
    id: string,
    patch: TaskPatch,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || !this.allowed(current, fence)) return false;
      const { answer, ...fields } = patch;
      await this.store.put('task', id, {
        ...current,
        ...fields,
        ...(answer !== undefined ? { answer: [...(current.answer ?? []), answer] } : {}),
        updatedAt: now,
      });
      return true;
    });
  }

  deleteTask(_organizationId: string, id: string, fence: TaskFence): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || !this.allowed(current, fence)) return false;
      await this.store.delete('task', id);
      this.tombstone(id);

      return true;
    });
  }

  continueTask(
    _organizationId: string,
    id: string,
    task: Pick<AgentTask, 'prompt' | 'context'>,
    now: number,
    fence: TaskFence,
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || !DONE.has(current.status) || !this.allowed(current, fence)) return false;

      const { note: previous, ...context } = task.context ?? {};
      const note = await this.store.get('note', noteKey(current.task));

      task.context = { ...context, ...(note ? { note } : {}) };
      await this.store.put(
        'task',
        id,
        {
          task: { ...current.task, ...task },
          status: 'queued',
          attempts: 0,
          logSeq: current.logSeq,
          logBytes: current.logBytes,
          generation: (current.generation ?? 0) + 1,
          inboxSeq: current.inboxSeq,
          createdAt: current.createdAt,
          updatedAt: now,
        },
        { unarchive: true },
      );

      return true;
    });
  }

  completeTask(
    _organizationId: string,
    id: string,
    completion: Completion,
    now: number,
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (
        !current ||
        !this.allowed(current, {
          attempts: completion.attempts,
          tokenHash: completion.tokenHash,
          statuses: ['running', 'waiting'],
        })
      )
        return false;

      await this.store.put('usage', `${id}:${current.generation ?? 0}`, completion.usage);
      if (completion.note) {
        const { key, value, ttlMs } = completion.note;
        if (value) await this.store.put('note', key, value, { ttlMs });
        else await this.store.delete('note', key);
      }

      for (const row of await this.store.list('inbox', { prefix: `${id}:` }))
        if (row.value.generation === (current.generation ?? 0))
          await this.store.delete('inbox', row.id);
      await this.store.put('task', id, {
        ...current,
        ...completion.outcome,
        lastSeenAt: now,
        finishedAt: now,
        updatedAt: now,
      });

      return true;
    });
  }

  requeue(
    _organizationId: string,
    id: string,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || !this.allowed(current, { ...fence, statuses: ['running', 'waiting'] }))
        return false;
      await this.store.put('task', id, {
        ...current,
        status: 'queued',
        handle: undefined,
        tokenHash: undefined,
        lastSeenAt: undefined,
        updatedAt: now,
      });
      return true;
    });
  }

  finish(
    _organizationId: string,
    id: string,
    outcome: Outcome,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (
        !current ||
        !this.allowed(current, { ...fence, statuses: ['queued', 'running', 'waiting'] })
      )
        return false;
      await this.store.put('task', id, {
        ...current,
        ...outcome,
        lastSeenAt: now,
        finishedAt: now,
        updatedAt: now,
      });
      return true;
    });
  }

  cancel(
    _organizationId: string,
    id: string,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || DONE.has(current.status) || !this.allowed(current, fence)) return false;
      const entry =
        current.status !== 'queued'
          ? {
              seq: await this.nextSeq(id),
              generation: current.generation ?? 0,
              kind: 'cancel' as const,
              value: null,
              at: now,
            }
          : undefined;
      if (entry)
        await this.store.put('inbox', `${id}:${String(entry.seq).padStart(8, '0')}`, entry);
      await this.store.put('task', id, {
        ...current,
        ...(current.status === 'queued' ? { status: 'cancelled', finishedAt: now } : {}),
        cancelRequestedAt: now,
        ...(entry ? { inboxSeq: entry.seq } : {}),
        updatedAt: now,
      } satisfies TaskStatus);
      return true;
    });
  }

  async cancelRequested(_organizationId: string, id: string): Promise<boolean> {
    return (await this.read(id))?.cancelRequestedAt !== undefined;
  }

  async list(_organizationId: string, opts: TaskListOptions = {}): Promise<TaskStatus[]> {
    const { before } = opts;

    return (await this.store.list('task'))
      .map(row => row.value)
      .filter(status => matchesTask(status, opts))
      .filter(status => afterCursor(status, before))
      .sort(listOrder)
      .slice(0, opts.limit);
  }

  /** A deleted task, for events streams. */
  tombstone(id: string) {
    this.tombstones.set(id, Date.now());
  }

  async changes(scopes: Array<{ organizationId: string }>, since: number) {
    const organizationId = scopes[0]?.organizationId;
    if (!organizationId) return { rows: [], deleted: [] };

    for (const [id, at] of this.tombstones)
      if (at < Date.now() - TOMBSTONE_MS) this.tombstones.delete(id);

    return {
      rows: (await this.store.list('task')).map(row => ({ organizationId, status: row.value })),
      deleted: [...this.tombstones]
        .filter(([, at]) => at > since)
        .map(([id, at]) => ({ organizationId, id, at })),
    };
  }

  async counts(_organizationId: string, filter: TaskFilter = {}): Promise<TaskCounts> {
    const rows = (await this.store.list('task'))
      .map(row => row.value)
      .filter(status => matchesTask(status, filter));

    return {
      all: rows.length,
      active: rows.filter(row => ACTIVE_STATES.includes(row.status)).length,
      waiting: rows.filter(row => row.status === 'waiting').length,
    };
  }

  async runningCount(): Promise<number> {
    return (await this.store.list('task')).filter(row =>
      ['running', 'waiting'].includes(row.value.status),
    ).length;
  }

  async running(): Promise<ClaimedTask[]> {
    return (await this.store.list('task'))
      .map(row => row.value)
      .filter(status => ['running', 'waiting'].includes(status.status))
      .map(status => ({ organizationId: 'default', status }));
  }

  appendLogs(
    _organizationId: string,
    id: string,
    lines: TaskLogLine[],
    from: { seq: number; cursor: number },
    progress: { cursor: number; seq: number; bytes: number },
    now: number,
    fence: TaskFence,
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (
        !current ||
        !this.allowed(current, fence) ||
        (current.logSeq ?? 0) !== from.seq ||
        (current.logCursor ?? -1) !== from.cursor
      )
        return false;
      await this.store.putMany(
        'tasklog',
        lines.map(({ seq, ...value }) => ({ id: `${id}:${String(seq).padStart(6, '0')}`, value })),
      );
      await this.store.put('task', id, {
        ...current,
        logCursor: progress.cursor,
        logSeq: progress.seq,
        logBytes: progress.bytes,
        updatedAt: now,
      });
      return true;
    });
  }

  readInbox(
    _organizationId: string,
    id: string,
    generation: number,
    after: number,
  ): Promise<InboxEntry[]> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (
        !current ||
        !ACTIVE_STATES.includes(current.status) ||
        (current.generation ?? 0) !== generation
      )
        return [];

      return (await this.store.list('inbox', { prefix: `${id}:` }))
        .map(row => row.value)
        .filter(entry => entry.generation === generation && entry.seq > after)
        .slice(0, 100);
    });
  }

  fetchInbox(
    _organizationId: string,
    id: string,
    tokenHash: string,
    attempts: number,
    after: number,
  ): Promise<InboxEntry[] | undefined> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (
        !current ||
        !this.allowed(current, { tokenHash, attempts, statuses: ['running', 'waiting'] })
      )
        return undefined;

      return (await this.store.list('inbox', { prefix: `${id}:` }))
        .map(row => row.value)
        .filter(entry => entry.generation === (current.generation ?? 0) && entry.seq > after)
        .sort((a, b) => a.seq - b.seq);
    });
  }

  ackInbox(_organizationId: string, id: string, ack: InboxAck, fence: TaskFence): Promise<boolean> {
    return this.serial(async () => {
      if (fence.generation !== undefined && fence.generation !== ack.generation) return false;

      const current = await this.read(id);
      if (
        !current ||
        !this.allowed(current, { ...fence, generation: ack.generation, statuses: undefined }) ||
        ack.seq > (current.inboxSeq ?? -1)
      )
        return false;

      const after = current.inboxAck?.generation === ack.generation ? current.inboxAck.seq : -1;
      if (DONE.has(current.status)) return ack.seq <= after;
      if (!['running', 'waiting'].includes(current.status)) return false;

      const applied = (await this.store.list('inbox', { prefix: `${id}:` })).filter(
        row => row.value.generation === ack.generation && row.value.seq <= ack.seq,
      );
      const answers = (ack.answers ?? [])
        .filter(
          answer =>
            answer.seq > after &&
            applied.some(row => row.value.kind === 'ask' && row.value.seq === answer.seq),
        )
        .map(answer => answer.value);
      const cancelled = applied.some(row => row.value.kind === 'cancel');
      const approvalId = (current.approval as { id?: string })?.id;
      const approved =
        approvalId &&
        applied.some(
          row =>
            row.value.kind === 'approve' &&
            (row.value.value as { approvalId?: string })?.approvalId === approvalId,
        );

      await this.store.put('task', id, {
        ...current,
        inboxAck: { generation: ack.generation, seq: Math.max(after, ack.seq) },
        ...(answers.length ? { answer: [...(current.answer ?? []), ...answers] } : {}),
        ...(approved ? { status: 'running', approval: undefined } : {}),
        ...(cancelled ? { status: 'cancelled', finishedAt: Date.now() } : {}),
        updatedAt: Date.now(),
      });
      for (const row of applied) await this.store.delete('inbox', row.id);

      return true;
    });
  }

  async pendingInbox(): Promise<ClaimedTask[]> {
    const pending = await this.store.list('inbox');

    return (await this.running()).filter(({ status }) =>
      pending.some(
        row =>
          row.id.startsWith(`${status.task.id}:`) &&
          row.value.generation === (status.generation ?? 0),
      ),
    );
  }

  appendInbox(
    _organizationId: string,
    id: string,
    kind: InboxEntry['kind'],
    value: unknown,
    now: number,
    generation: number,
  ): Promise<InboxEntry | undefined> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (
        !current ||
        !ACTIVE_STATES.includes(current.status) ||
        (current.generation ?? 0) !== generation
      )
        return undefined;
      const seq = await this.nextSeq(id);
      const entry = { seq, generation, at: now, kind, value };
      await this.store.put('inbox', `${id}:${String(seq).padStart(8, '0')}`, entry);
      await this.store.put('task', id, { ...current, inboxSeq: seq, updatedAt: now });
      return entry;
    });
  }
}

const INBOX_LEASE_MS = 30_000;

export function pushInbox(ctx: ServerContext, id: string): Promise<void> {
  const queue = (ctx.queue.inboxDelivery ??= new Map());
  const key = JSON.stringify([ctx.organizationId, id]);
  let state = queue.get(key);
  if (!state) queue.set(key, (state = {}));
  if (state.work) {
    state.again = true;
    return state.work;
  }
  const current = state;
  const work = async () => {
    let lease: string | undefined;
    const owner = randomUUID();
    let failures = 0;
    let generation = 0;
    let releasedGeneration: number | undefined;
    const deliver = async () => {
      for (;;) {
        current.again = false;

        const status = await ctx.store.get('task', id);
        if (!status?.handle || !['running', 'waiting'].includes(status.status)) return;

        const runner = await taskRunner(ctx, status.task);
        const local = Boolean(ctx.local && status.handle.startsWith('cli:'));
        if (!local && !runner?.push) return;

        generation = status.generation ?? 0;

        const fence = {
          generation,
          attempts: status.attempts,
          tokenHash: status.tokenHash ?? null,
          handle: status.handle,
        };
        const deliveryKey = `inbox:${JSON.stringify([id, fence])}`;
        if (lease !== deliveryKey) {
          if (lease) await ctx.store.updateDeliveryLease(lease, owner);
          lease = undefined;
          const claimed = await ctx.store.claimDeliveryLease(deliveryKey, owner, INBOX_LEASE_MS);
          if (claimed === undefined) return;
          lease = deliveryKey;
          failures = claimed;
        } else if (
          !(await ctx.store.updateDeliveryLease(
            lease,
            owner,
            { owner, failures },
            { ttlMs: INBOX_LEASE_MS },
          ))
        )
          return;

        const entries = (
          await ctx.queue.readInbox(ctx.organizationId, id, status.generation ?? 0, -1)
        ).slice(0, 100);
        if (!entries.length) {
          if (current.again) continue;
          return;
        }

        const ack = local
          ? await pushLocalInbox(ctx, status, entries)
          : await runner!.push!(status.handle, entries);
        if (
          ack.generation !== (status.generation ?? 0) ||
          !entries.some(entry => entry.seq === ack.seq)
        )
          throw new Error('Invalid inbox acknowledgement');
        if (!(await ctx.queue.ackInbox(ctx.organizationId, id, ack, fence))) return;

        failures = 0;
        if (entries.length < 100 && !current.again) return;
      }
    };
    try {
      await deliver();
    } catch {
      if (lease) {
        const retryMs = Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));
        const value = { owner, failures: failures + 1, next: (ctx.now ?? Date.now)() + retryMs };
        await ctx.store.updateDeliveryLease(lease, owner, value, { ttlMs: retryMs });
        lease = undefined;
      }
    } finally {
      if (lease) {
        await ctx.store.updateDeliveryLease(lease, owner);
        releasedGeneration = generation;
      }
    }
    return releasedGeneration;
  };
  current.work = (async () => {
    for (;;) {
      const generation = await work();
      if (generation === undefined) break;
      const pending = await ctx.queue.readInbox(ctx.organizationId, id, generation, -1);
      if (!pending.length && !current.again) break;
    }
    queue.delete(key);
  })().finally(() => {
    if (queue.get(key) === current) queue.delete(key);
  });
  return current.work;
}

export async function flushInbox(ctx: ServerContext): Promise<void> {
  const pending = await ctx.queue.pendingInbox();
  await Promise.allSettled(
    pending.map(({ organizationId, status }) =>
      pushInbox(scoped(ctx, organizationId), status.task.id),
    ),
  );
}

export function scheduleInbox(ctx: ServerContext): void {
  const work = flushInbox(ctx).catch(() => {});
  if (ctx.waitUntil) ctx.waitUntil(work);
  else void work;
}
