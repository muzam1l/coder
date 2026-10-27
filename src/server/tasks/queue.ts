/** The task queue: claim, retry, finish, cancel. Logs and lookups go through the `Store` (`task`, `tasklog`). */
import { deleteTaskConnections } from '../connections/resolve';
import {
  MEMBERS_CLAIM_MS,
  canView,
  createTaskToken,
  spaceKey,
  taskAudience,
  type SpaceEvent,
  type Viewer,
} from './access';
import { randomUUID } from 'node:crypto';
import type { AgentTask, TaskContext, TaskSource } from '../../agent/types';
import type { LinkedMember } from '../../integrations/types';
import type { TaskLogLine, TaskStatus, Store, UsageRecord } from '../store/types';
import { workspaceUsageKey } from '../store/types';
import type { Loaded } from '../store/primed';
import { scoped, type ServerContext } from '../context';
import { taskRunner } from '../runners/select';
import { pushLocalInbox } from './local';
import { awaitsApproval, byId, byListKey, listRank, type ListKey } from '../../core/task/view';
import { archiveDue } from '../../core/state';
import { STOPPED_BY_USER, type Approval } from '../../core/types';
import { ApprovalRefusedError, mergeApprovals, refusedAnswer } from '../../core/approvals';
import type { Batch, Conversation } from './conversation';
import { usageRecordOf } from './usage';

export interface ClaimedTask {
  organizationId: string;
  status: TaskStatus;
}

/** What `inspect` reads of a running task: its row without the task body, which a failure report loads by id. */
export type RunningTask = Pick<
  TaskStatus,
  | 'status'
  | 'attempts'
  | 'generation'
  | 'handle'
  | 'tokenHash'
  | 'lastSeenAt'
  | 'logsComplete'
  | 'startedAt'
  | 'cancelRequestedAt'
  | 'updatedAt'
> & { task: Pick<AgentTask, 'id' | 'runner' | 'runnerId' | 'vcpus'> };

export function taskTimes(status: TaskStatus, now = Date.now()) {
  const active = status.status === 'running' || status.status === 'waiting';
  const end = active ? now : (status.finishedAt ?? status.updatedAt);

  return {
    lastActivityAt: Math.max(status.updatedAt, status.lastSeenAt ?? 0),
    lastTurnMs: status.startedAt === undefined ? 0 : Math.max(0, end - status.startedAt),
  };
}
/** A message to a running task: a steer, an answer, or an approval. */
export interface InboxEntry {
  seq: number;
  generation: number;
  at: number;
  kind: 'steer' | 'ask' | 'approve' | 'cancel';
  value: unknown;
}

/** The batch an inbox entry delivers: fenced by the sender's reservation, admitted through the last item's id. */
export interface BatchAdmission {
  key: string;
  owner: string;
  through: string;
}

/** What a delivery records on the task and its inbox entry: the admitted id under the batch's kind. */
export const batchAdmissions = (batch: BatchAdmission): NonNullable<TaskContext['admissions']> => ({
  [batch.key.slice(0, batch.key.indexOf(':'))]: batch.through,
});

export class BatchClaimLost extends Error {}

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
  since?: number;
  sinceId?: string;
  /** Only the children of this task. */
  parent?: string;
  /** Only tasks routed to this registered runner. */
  runnerId?: string;
  /** A member who is not an admin: their own tasks, public ones, and those of the private spaces they can see. */
  viewer?: Viewer;
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

/** What a delete leaves for events streams: the task's audience, the member who asked and its parent, so only who saw it hears the delete. */
export interface Tombstone {
  at: number;
  audience?: string;
  requestedBy?: string;
  parent?: string;
}

/** What a log stream reads of its task each poll: its state, who sees it, and its new lines. */
export interface LogTail {
  status: Pick<TaskStatus, 'status' | 'approval'> & {
    task: Pick<AgentTask, 'id' | 'audience' | 'requestedBy'>;
  };
  lines: TaskLogLine[];
}

/** Active unarchived tasks of one audience and one asking member, so every viewer's count comes from one read. */
export interface AudienceCount {
  audience?: string;
  requestedBy?: string;
  active: number;
}

/** Whether a task passes a filter; the memory queue's version of the SQL predicate. */
export function matchesTask(status: TaskStatus, filter: TaskFilter): boolean {
  if (
    filter.since !== undefined &&
    (status.updatedAt < filter.since ||
      (status.updatedAt === filter.since && (!filter.sinceId || status.task.id <= filter.sinceId)))
  )
    return false;
  const states = filter.status ? [filter.status] : filter.statuses;
  if (filter.status === 'waiting') {
    if (!awaitsApproval(status.status, status.approvals ?? status.task.context?.approvals))
      return false;
  } else if (states && !states.includes(status.status)) return false;
  if (filter.agent && status.task.agent !== filter.agent) return false;
  if (filter.source && status.task.source !== filter.source) return false;
  if (filter.parent && status.task.parent !== filter.parent) return false;
  if (filter.runnerId && status.task.runnerId !== filter.runnerId) return false;
  if (filter.archived !== undefined && filter.archived !== (status.archivedAt !== undefined))
    return false;
  if (!canView(filter.viewer, status.task)) return false;
  const q = filter.q?.trim().toLowerCase();
  return (
    !q ||
    [status.task.prompt ?? status.task.event?.text, status.task.agent, status.task.id].some(value =>
      value?.toLowerCase().includes(q),
    )
  );
}

export type ListCursor = ListKey | { updatedAt: number; id: string };

export const listCursor = (row: TaskStatus): ListKey => ({
  rank: listRank(row.status),
  createdAt: row.createdAt,
  id: row.task.id,
});

export const deltaCursor = (row: TaskStatus) => ({ updatedAt: row.updatedAt, id: row.task.id });

/** The delta order, which `deltaCursor` pages through. */
export const deltaOrder = (a: TaskStatus, b: TaskStatus) =>
  a.updatedAt - b.updatedAt || byId(a.task.id, b.task.id);

/** The CLI's list order, so a keyset cursor is stable under inserts. */
export const listOrder = (a: TaskStatus, b: TaskStatus) => byListKey(listCursor(a), listCursor(b));

/** Whether a row comes after the cursor in list order. */
export const afterCursor = (row: TaskStatus, before?: ListCursor) =>
  !before ||
  ('updatedAt' in before
    ? row.updatedAt > before.updatedAt ||
      (row.updatedAt === before.updatedAt && row.task.id > before.id)
    : byListKey(listCursor(row), before) > 0);

/** What a continued task takes for its next turn: the prompt and context, and the agent as it is now. */
export type TaskRefresh = Pick<AgentTask, 'prompt' | 'context'> &
  Partial<
    Pick<
      AgentTask,
      | 'event'
      | 'definition'
      | 'usage'
      | 'tools'
      | 'files'
      | 'access'
      | 'models'
      | 'runner'
      | 'runnerId'
      | 'vcpus'
      | 'failureReply'
      | 'notice'
    >
  >;

export interface TaskFence {
  generation?: number;
  attempts?: number;
  tokenHash?: string | null;
  handle?: string | null;
  lastSeenAt?: number | null;
  updatedAt?: number;
  statuses?: TaskStatus['status'][];
  /** The approval with this id has no answer yet. */
  unanswered?: string;
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
    | 'logsComplete'
    | 'archivedAt'
    | 'autoArchived'
    | 'approval'
    | 'fallbacks'
    | 'typingEnded'
  >
> & { answer?: unknown; approvals?: Approval[]; resolvedModel?: string };

export interface Completion {
  outcome: Outcome;
  usage: UsageRecord;
  attempts: number;
  tokenHash: string;
  /** Messages the task posted, remembered so reactions on them are recognized. */
  known?: Array<{ id: string; ttlMs: number }>;
  /** No more output follows: the machine needs no stop. */
  logsComplete?: boolean;
}

export interface Delivery {
  key: string;
  ttlMs: number;
  /** The claim this request holds on the delivery; the receipt lands over it. */
  owner?: string;
}
export interface PendingDelivery {
  pending?: { task?: AgentTask; inbox?: { taskId: string; id: string; entry: InboxEntry } };
}

/** What a new task's admission writes with it: its conversation, the unseen messages it carries and its sealed redaction secrets. */
export interface Admission {
  conversation?: { key: string; record: Conversation; root: string; ttlMs: number };
  unseen?: { key: string; version: number; epoch?: string };
  secrets?: Array<{ id: string; value: string; expiresAt: number }>;
}

/** The task behind a runner's bearer, with the rows its authorization read alongside where the store could. */
export interface CallbackState {
  organizationId: string;
  status: TaskStatus;
  loaded?: Loaded;
}

/** The conversation a task belongs to: app, installation, Chat SDK thread and agent; who wrote or asked is no part of it. */
export function sessionKey(task: Pick<AgentTask, 'agent' | 'event'>): string {
  const event = task.event;
  return JSON.stringify([event?.appId, event?.installationId, event?.chat?.thread.id, task.agent]);
}

function sameSession(task: AgentTask, incoming: AgentTask): boolean {
  return (
    task.flow === 'default' &&
    Boolean(task.event?.chat) &&
    sessionKey(task) === sessionKey(incoming)
  );
}

export interface TaskQueue {
  deleteTask(organizationId: string, id: string, fence: TaskFence, now?: number): Promise<boolean>;
  metrics(organizationId: string, since: number): Promise<TaskMetrics>;
  scheduler?: { running?: Promise<void>; waiting?: Promise<void> };
  inboxDelivery?: Map<string, { work?: Promise<void>; again?: boolean }>;
  /** Inserts the task with what its admission records, or with `steer` appends that text to the conversation's active task instead. */
  deliver(
    organizationId: string,
    task: AgentTask,
    now: number,
    delivery: Delivery,
    steer: string | undefined,
    maxQueued?: number,
    create?: boolean,
    admission?: Admission,
  ): Promise<{ taskId?: string; steered?: boolean }>;
  /** The task behind a runner's bearer token, touched, with what the callback needs loaded alongside. */
  authorize(
    id: string,
    tokenHash: string,
    attempts: number,
    organizationId: string,
    now: number,
    options?: { allowCompleted?: boolean; include?: 'secrets' | 'context' },
  ): Promise<CallbackState | undefined>;
  enqueue(
    organizationId: string,
    task: AgentTask,
    now: number,
    delivery?: { key: string; ttlMs: number },
    maxQueued?: number,
  ): Promise<boolean>;
  /** The oldest queued task of any organization, now running, with what its start needs; `undefined` when the queue is empty. `concurrentTasks` caps a workspace's tasks on the server's own runner. */
  claim(
    now: number,
    maxTasks?: number,
    knownWork?: boolean,
    concurrentTasks?: (organizationId: string) => Promise<number | undefined>,
  ): Promise<(ClaimedTask & { token: string; more: boolean; loaded?: Loaded }) | undefined>;
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
  /** Makes a task without `requestedBy` that member's, its DM audience too; false when it already has one. */
  setRequestedBy(
    organizationId: string,
    id: string,
    requestedBy: string,
    now: number,
  ): Promise<boolean>;
  /** Archives tasks stopped longer than AUTO_ARCHIVE_MS, or only `ids`; deltas carry the change. */
  archiveStopped(organizationId: string | undefined, now: number, ids?: string[]): Promise<void>;
  continueTask(
    organizationId: string,
    id: string,
    task: TaskRefresh,
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
  /** The task's status once the acknowledgement applied; nothing when it was refused. */
  ackInbox(
    organizationId: string,
    id: string,
    ack: InboxAck,
    fence: TaskFence,
  ): Promise<TaskStatus['status'] | undefined>;
  pendingInbox(organizationId?: string): Promise<ClaimedTask[]>;
  cancelRequested(organizationId: string, id: string): Promise<boolean>;
  /** Newest first. */
  list(organizationId: string, opts?: TaskListOptions): Promise<TaskStatus[]>;
  /** The audiences among `audiences` of private spaces whose stored member list holds a platform identity linked to `user`. */
  memberSpaces(organizationId: string, user: string, audiences: string[]): Promise<string[]>;
  /** The private spaces of `event`'s integration and account whose member list is stored and that still have tasks. */
  listedSpaces(organizationId: string, event: SpaceEvent): Promise<SpaceEvent[]>;
  /** The platform user ids linked to members of the organization. */
  linkedMembers(organizationId: string, platform: string): Promise<LinkedMember[]>;
  /** When a private space's member list was last fetched. */
  spaceSynced(organizationId: string, event: SpaceEvent): Promise<number | undefined>;
  /** Takes the one fetch claim on a space's member list; false while another server holds it, unless `force` takes it over. */
  claimSpace(
    organizationId: string,
    event: SpaceEvent,
    now: number,
    force?: boolean,
  ): Promise<boolean>;
  /** Replaces a private space's member list with what its platform just listed, or releases the claim when the fetch failed. */
  saveSpaceMembers(
    organizationId: string,
    event: SpaceEvent,
    members: string[] | undefined,
    now: number,
  ): Promise<void>;
  /** A member joined or left a listed space, or it turned public or private: its tasks take the new audience and its list goes. */
  spaceChanged(
    organizationId: string,
    event: SpaceEvent,
    change: { joined?: string; left?: string; private?: boolean },
    now: number,
  ): Promise<void>;
  /** In one call, tasks of these organizations updated or deleted after `since`, and the `fresh` ones however old; asked `ids` carry their results. A store queue returns every task. */
  changes(
    scopes: Array<{ organizationId: string; ids: string[]; fresh: string[] }>,
    since: number,
  ): Promise<{
    rows: ClaimedTask[];
    deleted: Array<{ organizationId: string; id: string } & Tombstone>;
  }>;
  /** In one read, each named task's state and up to `limit` of its log lines after `after`; `undefined` for a task that is gone. */
  logTails(
    tails: Array<{ organizationId: string; id: string; after: number }>,
    limit: number,
  ): Promise<Array<LogTail | undefined>>;
  /** How many tasks match, and how many of those are active or waiting. */
  counts(organizationId: string, filter?: TaskFilter): Promise<TaskCounts>;
  /** The workspace's active unarchived tasks by audience and the member who asked, for every open stream's count at once. */
  activeCounts(organizationId: string): Promise<AudienceCount[]>;
  listWithCounts?(
    organizationId: string,
    opts: TaskListOptions,
  ): Promise<{ items: TaskStatus[]; counts: TaskCounts }>;
  runningCount(): Promise<number>;
  running(): Promise<Array<{ organizationId: string; status: RunningTask }>>;
  /** Appends an inbox entry; `approvals` are merged into the task in the same write. */
  appendInbox(
    organizationId: string,
    id: string,
    kind: InboxEntry['kind'],
    value: unknown,
    now: number,
    generation: number,
    batch?: BatchAdmission,
    approvals?: Approval[],
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
  return ctx.queue.deleteTask(ctx.organizationId, id, fence, (ctx.now ?? Date.now)());
}

/** The task with these admissions recorded in its context, a steer's or a consumed entry's. */
/** The task with its approvals list replaced: what the runner reported, merged over what the server answered. */
export const withApprovals = (task: AgentTask, approvals: Approval[]): AgentTask => ({
  ...task,
  context: {
    ...task.context,
    approvals: mergeApprovals(task.context?.approvals ?? [], approvals),
  },
});

const withAdmissions = (
  task: AgentTask,
  admissions: NonNullable<TaskContext['admissions']>,
): AgentTask => ({
  ...task,
  context: { ...task.context, admissions: { ...task.context?.admissions, ...admissions } },
});

/** Appends to the task's inbox under its generation and pushes it to the runner, which starts from the task as the caller read it. */
export async function addInbox(
  ctx: ServerContext,
  status: TaskStatus,
  kind: InboxEntry['kind'],
  value: unknown,
  batch?: BatchAdmission,
  approvals?: Approval[],
): Promise<InboxEntry | undefined> {
  const id = status.task.id;
  const entry = await ctx.queue.appendInbox(
    ctx.organizationId,
    id,
    kind,
    value,
    (ctx.now ?? Date.now)(),
    status.generation ?? 0,
    batch,
    approvals,
  );
  if (entry) await pushInbox(ctx, id, status.task, status);
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

/** Queue over a plain `Store`; its lock keeps task transitions and monthly charges together. */
export class StoreQueue implements TaskQueue {
  /** Deleted task ids and when, for events streams. */
  private tombstones = new Map<string, Tombstone>();
  /** Private spaces' member lists, by space key. */
  private spaces = new Map<
    string,
    { syncedAt?: number; claimedAt?: number; members: Set<string> }
  >();

  constructor(private readonly store: Store) {}

  async metrics(organizationId: string, since: number): Promise<TaskMetrics> {
    const rows = await this.list(organizationId);
    const tasks: Record<TaskStatus['status'], number> = {
      queued: 0,
      running: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const row of rows) if (row.createdAt >= since) tasks[row.status]++;

    return { tasks, queueDepth: rows.filter(row => row.status === 'queued').length };
  }

  private serial<T>(work: () => Promise<T>): Promise<T> {
    return this.store.withAppLock('task-queue', work);
  }

  private async read(id: string): Promise<TaskStatus | undefined> {
    return this.store.get('task', id);
  }

  /** Adds an attempt that ends without the runner's completion to its turn's usage; the CLI importer counts local tasks. */
  private async addRunnerTime(current: TaskStatus, now: number): Promise<void> {
    if (
      !['running', 'waiting'].includes(current.status) ||
      current.startedAt === undefined ||
      current.handle?.startsWith('cli:')
    )
      return;
    const key = `${current.task.id}:${current.generation ?? 0}`;
    const record = usageRecordOf(current, now);
    const usage = await this.store.get('usage', key);
    await this.store.put('usage', key, {
      ...(usage ?? record),
      runnerElapsedMs: (usage?.runnerElapsedMs ?? 0) + record.runnerElapsedMs,
      at: now,
    });
    await this.chargeCpuTime(current, record.runnerElapsedMs, now);
  }

  private async chargeCpuTime(current: TaskStatus, elapsed: number, now: number): Promise<void> {
    const vcpus = current.task.vcpus;
    if (elapsed <= 0 || !vcpus) return;
    const key = workspaceUsageKey(now);
    const usage = await this.store.get('snapshot', key);
    const meters = usage && 'meters' in usage ? usage.meters : {};
    const meter = `cpu:${current.task.runner}`;
    await this.store.put('snapshot', key, {
      meters: { ...meters, [meter]: (meters[meter] ?? 0) + elapsed * vcpus },
    });
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
    // The pending task survives a crash before the row lands; the claim's owner keeps the delivery leased meanwhile.
    if (delivery && !receipt?.pending?.task)
      await this.store.put('delivery', delivery.key, {
        at: now,
        ...(delivery.owner ? { owner: delivery.owner } : {}),
        pending: { task },
      });
    if (!existing)
      await this.store.put('task', task.id, {
        task: { ...task, ...taskAudience(task) },
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

  /** What a new task's admission records beside it. */
  private async admit(task: AgentTask, admission: Admission | undefined, now: number) {
    if (!admission) return;
    const { conversation, unseen } = admission;
    if (conversation)
      await this.store.putMany(
        'delivery',
        [
          { id: conversation.key, value: conversation.record },
          { id: conversation.root, value: { at: conversation.record.at } },
        ],
        { ttlMs: conversation.ttlMs },
      );
    if (unseen) await this.store.acknowledgeUnseen(unseen.key, unseen.version, unseen.epoch);
    for (const row of admission.secrets ?? [])
      await this.store.put(
        'snapshot',
        row.id,
        { secret: row.value, expiresAt: row.expiresAt },
        { ttlMs: Math.max(1, row.expiresAt - now) },
      );
  }

  deliver(
    organizationId: string,
    task: AgentTask,
    now: number,
    delivery: Delivery,
    steer: string | undefined,
    maxQueued?: number,
    create = true,
    admission?: Admission,
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
        steer !== undefined && !receipt?.pending?.task
          ? (
              await this.list(organizationId, {
                statuses: ACTIVE_STATES,
                agent: task.agent,
                source: task.source,
              })
            ).find(row => sameSession(row.task, task))
          : undefined;
      if (!active) {
        if (!create || !(await this.insert(task, now, delivery, maxQueued))) return {};
        await this.admit(task, admission, now);

        return { taskId: task.id };
      }
      const seq = await this.nextSeq(active.task.id);
      const entry: InboxEntry = {
        seq,
        generation: active.generation ?? 0,
        at: now,
        kind: 'steer',
        value: { text: steer, asker: task.context?.asker ?? null },
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
    _knownWork?: boolean,
    concurrentTasks?: (organizationId: string) => Promise<number | undefined>,
  ): Promise<(ClaimedTask & { token: string; more: boolean }) | undefined> {
    return this.serial(async () => {
      const rows = (await this.store.list('task')).map(row => row.value);
      const running = rows.filter(row => ['running', 'waiting'].includes(row.status)).length;
      if (maxTasks !== undefined && running >= maxTasks) return undefined;
      const limit = await concurrentTasks?.('default');
      const charged = rows.filter(
        row => ['running', 'waiting'].includes(row.status) && row.task.vcpus,
      ).length;
      const allowed = (row: TaskStatus, claimed = 0) =>
        limit === undefined || !row.task.vcpus || charged + claimed < limit;

      const queued = rows
        .filter(status => status.status === 'queued')
        .sort((a, b) => a.createdAt - b.createdAt);
      const next = queued.find(row => allowed(row));
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
          queued.some(row => row !== next && allowed(row, next.task.vcpus ? 1 : 0)) &&
          (maxTasks === undefined || running + 1 < maxTasks),
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
      (!fence.statuses || fence.statuses.includes(status.status)) &&
      (fence.unanswered === undefined ||
        !status.task.context?.approvals?.find(entry => entry.id === fence.unanswered)?.response)
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
      // Liveness only, so events streams see no change.
      const next = { ...current, lastSeenAt: now };
      await this.store.put('task', id, next);
      return next;
    });
  }

  async authorize(
    id: string,
    tokenHash: string,
    attempts: number,
    organizationId: string,
    now: number,
    options: { allowCompleted?: boolean } = {},
  ): Promise<CallbackState | undefined> {
    const status = await this.touch(
      organizationId,
      id,
      tokenHash,
      attempts,
      now,
      options.allowCompleted,
    );

    return status && { organizationId: 'default', status };
  }

  async archiveStopped(
    _organizationId: string | undefined,
    now: number,
    ids?: string[],
  ): Promise<void> {
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
              updatedAt: now,
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
      const { answer, approvals, resolvedModel, ...fields } = patch;
      const task = resolvedModel
        ? { ...current.task, usage: { ...current.task.usage, resolvedModel } }
        : current.task;
      await this.store.put('task', id, {
        ...current,
        task,
        ...(Object.hasOwn(patch, 'handle') && patch.handle !== current.handle
          ? { logsComplete: undefined }
          : {}),
        ...fields,
        ...(answer !== undefined ? { answer: [...(current.answer ?? []), answer] } : {}),
        ...(approvals ? { task: withApprovals(task, approvals) } : {}),
        updatedAt: now,
      });
      return true;
    });
  }

  setRequestedBy(
    _organizationId: string,
    id: string,
    requestedBy: string,
    now: number,
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || current.task.requestedBy) return false;
      const task = { ...current.task, requestedBy };
      if (task.audience === 'dm:') task.audience = `dm:${requestedBy}`;
      await this.store.put('task', id, { ...current, task, updatedAt: now });

      return true;
    });
  }

  deleteTask(
    _organizationId: string,
    id: string,
    fence: TaskFence,
    now = Date.now(),
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || !this.allowed(current, fence)) return false;
      await this.addRunnerTime(current, now);
      await this.store.delete('task', id);
      this.tombstone(
        id,
        taskAudience(current.task).audience,
        current.task.requestedBy,
        current.task.parent,
      );
      await deleteTaskConnections(this.store, id);

      return true;
    });
  }

  continueTask(
    _organizationId: string,
    id: string,
    task: TaskRefresh,
    now: number,
    fence: TaskFence,
  ): Promise<boolean> {
    return this.serial(async () => {
      const current = await this.read(id);
      if (!current || !DONE.has(current.status) || !this.allowed(current, fence)) return false;
      // Answers recorded since the continuation read the task are newer than its copy.
      const context = task.context && {
        ...task.context,
        approvals: mergeApprovals(
          task.context.approvals ?? [],
          current.task.context?.approvals ?? [],
        ),
      };

      await this.store.put(
        'task',
        id,
        {
          task: { ...current.task, ...task, ...(context ? { context } : {}) },
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

      const key = `${id}:${current.generation ?? 0}`;
      const prior = await this.store.get('usage', key);
      await this.store.put('usage', key, {
        ...completion.usage,
        runnerElapsedMs: (prior?.runnerElapsedMs ?? 0) + completion.usage.runnerElapsedMs,
      });
      await this.chargeCpuTime(current, completion.usage.runnerElapsedMs, now);

      for (const row of await this.store.list('inbox', { prefix: `${id}:` }))
        if (row.value.generation === (current.generation ?? 0))
          await this.store.delete('inbox', row.id);
      await this.store.put('task', id, {
        ...current,
        ...completion.outcome,
        ...(completion.logsComplete ? { logsComplete: true } : {}),
        lastSeenAt: now,
        finishedAt: now,
        updatedAt: now,
      });
      for (const known of completion.known ?? [])
        await this.store.put('delivery', known.id, { at: now }, { ttlMs: known.ttlMs });
      await deleteTaskConnections(this.store, id);

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
      await this.addRunnerTime(current, now);
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
      await this.addRunnerTime(current, now);
      await this.store.put('task', id, {
        ...current,
        ...outcome,
        lastSeenAt: now,
        finishedAt: now,
        updatedAt: now,
      });
      await deleteTaskConnections(this.store, id);
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
        ...(current.status === 'queued'
          ? { status: 'cancelled', error: STOPPED_BY_USER, finishedAt: now }
          : {}),
        cancelRequestedAt: now,
        ...(entry ? { inboxSeq: entry.seq } : {}),
        updatedAt: now,
      } satisfies TaskStatus);
      if (current.status === 'queued') await deleteTaskConnections(this.store, id);
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
      .sort(opts.since === undefined ? listOrder : deltaOrder)
      .slice(0, opts.limit);
  }

  /** A deleted task, for events streams. */
  tombstone(id: string, audience?: string, requestedBy?: string, parent?: string) {
    this.tombstones.set(id, {
      at: Date.now(),
      ...(audience === undefined ? {} : { audience }),
      ...(requestedBy === undefined ? {} : { requestedBy }),
      ...(parent === undefined ? {} : { parent }),
    });
  }

  /** The memory store links no platform identities, so a member sees no private space. */
  async memberSpaces(): Promise<string[]> {
    return [];
  }

  /** The memory store links no platform identities, so no list needs fetching again. */
  async listedSpaces(): Promise<SpaceEvent[]> {
    return [];
  }

  async linkedMembers(): Promise<LinkedMember[]> {
    return [];
  }

  async spaceSynced(_organizationId: string, event: SpaceEvent) {
    return this.spaces.get(spaceKey(event))?.syncedAt;
  }

  async claimSpace(_organizationId: string, event: SpaceEvent, now: number, force = false) {
    const key = spaceKey(event);
    const space = this.spaces.get(key) ?? { members: new Set<string>() };
    if (!force && space.claimedAt !== undefined && now - space.claimedAt < MEMBERS_CLAIM_MS)
      return false;
    this.spaces.set(key, { ...space, claimedAt: now });

    return true;
  }

  async saveSpaceMembers(
    _organizationId: string,
    event: SpaceEvent,
    members: string[] | undefined,
    now: number,
  ) {
    const key = spaceKey(event);
    const space = this.spaces.get(key) ?? { members: new Set<string>() };
    if (space.claimedAt !== now) return;
    this.spaces.set(
      key,
      members ? { syncedAt: now, members: new Set(members) } : { ...space, claimedAt: undefined },
    );
  }

  async spaceChanged(
    _organizationId: string,
    event: SpaceEvent,
    change: { joined?: string; left?: string; private?: boolean },
    now: number,
  ) {
    const key = spaceKey(event);
    const space = this.spaces.get(key);
    if (space && (change.joined || change.left))
      this.spaces.set(key, { ...space, claimedAt: undefined });
    const members = space?.members;
    if (change.joined) members?.add(change.joined);
    if (change.left) members?.delete(change.left);
    if (change.private === undefined) return;
    const audience = change.private ? `space:${key}` : '';
    for (const { value } of await this.store.list('task')) {
      const task = value.task;
      if (task.space !== key || task.audience?.startsWith('dm:')) continue;
      const event = task.event?.space
        ? { ...task.event, space: { ...task.event.space, private: change.private } }
        : task.event;
      await this.store.put('task', task.id, {
        ...value,
        task: { ...task, audience, ...(event ? { event } : {}) },
        updatedAt: now,
      });
    }
    this.spaces.delete(key);
  }

  async changes(scopes: Array<{ organizationId: string }>, since: number) {
    const organizationId = scopes[0]?.organizationId;
    if (!organizationId) return { rows: [], deleted: [] };

    for (const [id, { at }] of this.tombstones)
      if (at < Date.now() - TOMBSTONE_MS) this.tombstones.delete(id);

    return {
      rows: (await this.store.list('task')).map(row => ({ organizationId, status: row.value })),
      deleted: [...this.tombstones]
        .filter(([, { at }]) => at > since)
        .map(([id, tombstone]) => ({ organizationId, id, ...tombstone })),
    };
  }

  async logTails(tails: Array<{ id: string; after: number }>, limit: number) {
    const { readLog } = await import('./logs');

    return Promise.all(
      tails.map(async ({ id, after }) => {
        const status = await this.store.get('task', id);
        return status && { status, lines: await readLog(this.store, id, after, limit) };
      }),
    );
  }

  async counts(_organizationId: string, filter: TaskFilter = {}): Promise<TaskCounts> {
    const rows = (await this.store.list('task'))
      .map(row => row.value)
      .filter(status => matchesTask(status, filter));

    return {
      all: rows.length,
      active: rows.filter(row => ACTIVE_STATES.includes(row.status)).length,
      waiting: rows.filter(row => awaitsApproval(row.status, row.task.context?.approvals)).length,
    };
  }

  async runningCount(): Promise<number> {
    return (await this.store.list('task')).filter(row =>
      ['running', 'waiting'].includes(row.value.status),
    ).length;
  }

  async activeCounts(): Promise<AudienceCount[]> {
    const groups = new Map<string, AudienceCount>();
    for (const { value } of await this.store.list('task')) {
      if (value.archivedAt !== undefined || !ACTIVE_STATES.includes(value.status)) continue;
      const { audience } = value.task;
      const key = `${audience ?? null}\n${value.task.requestedBy ?? ''}`;
      const group = groups.get(key) ?? {
        ...(audience === undefined ? {} : { audience }),
        ...(value.task.requestedBy ? { requestedBy: value.task.requestedBy } : {}),
        active: 0,
      };
      groups.set(key, { ...group, active: group.active + 1 });
    }

    return [...groups.values()];
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

  ackInbox(
    _organizationId: string,
    id: string,
    ack: InboxAck,
    fence: TaskFence,
  ): Promise<TaskStatus['status'] | undefined> {
    return this.serial(async () => {
      if (fence.generation !== undefined && fence.generation !== ack.generation) return undefined;

      const current = await this.read(id);
      if (
        !current ||
        !this.allowed(current, { ...fence, generation: ack.generation, statuses: undefined }) ||
        ack.seq > (current.inboxSeq ?? -1)
      )
        return undefined;

      const after = current.inboxAck?.generation === ack.generation ? current.inboxAck.seq : -1;
      if (DONE.has(current.status)) return ack.seq <= after ? current.status : undefined;
      if (!['running', 'waiting'].includes(current.status)) return undefined;

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

      const admissions = Object.assign(
        {},
        ...applied.map(row => (row.value.value as { admissions?: object } | null)?.admissions),
      ) as NonNullable<TaskContext['admissions']>;
      const now = Date.now();
      if (cancelled) await this.addRunnerTime(current, now);

      const next: TaskStatus = {
        ...current,
        ...(Object.keys(admissions).length
          ? { task: withAdmissions(current.task, admissions) }
          : {}),
        inboxAck: { generation: ack.generation, seq: Math.max(after, ack.seq) },
        ...(answers.length ? { answer: [...(current.answer ?? []), ...answers] } : {}),
        ...(approved ? { status: 'running', approval: undefined } : {}),
        ...(cancelled ? { status: 'cancelled', error: STOPPED_BY_USER, finishedAt: now } : {}),
        updatedAt: now,
      };
      await this.store.put('task', id, next);
      for (const row of applied) await this.store.delete('inbox', row.id);
      if (cancelled) await deleteTaskConnections(this.store, id);

      return next.status;
    });
  }

  async pendingInbox(_organizationId?: string): Promise<ClaimedTask[]> {
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
    batch?: BatchAdmission,
    approvals?: Approval[],
  ): Promise<InboxEntry | undefined> {
    const work = async () => {
      if (batch) {
        const pending = await this.store.get<Batch>('delivery', batch.key);
        if (pending?.sending?.owner !== batch.owner) throw new BatchClaimLost();
      }
      const current = await this.read(id);
      if (
        !current ||
        !ACTIVE_STATES.includes(current.status) ||
        (current.generation ?? 0) !== generation
      )
        return undefined;
      for (const answer of approvals ?? []) {
        const refused = refusedAnswer(
          current.task.context?.approvals?.find(entry => entry.id === answer.id),
          answer,
        );
        if (refused) throw new ApprovalRefusedError(refused);
      }
      const seq = await this.nextSeq(id);
      const admissions = batch && batchAdmissions(batch);
      const entry = {
        seq,
        generation,
        at: now,
        kind,
        value: admissions ? { ...(value as object), admissions } : value,
      };
      // The entry carries the admission first, so a crash before the task write still reconciles.
      await this.store.put('inbox', `${id}:${String(seq).padStart(8, '0')}`, entry);
      let next = current.task;
      if (admissions) next = withAdmissions(next, admissions);
      if (approvals) next = withApprovals(next, approvals);
      await this.store.put('task', id, { ...current, task: next, inboxSeq: seq, updatedAt: now });
      if (batch) await this.store.finishBatch(batch.key, batch.owner, true, batch.through);
      return entry;
    };
    return this.serial(() => (batch ? this.store.withAppLock(`batch:${batch.key}`, work) : work()));
  }
}

const INBOX_LEASE_MS = 30_000;

/** Delivers a task's inbox to its runner; `known` is the task as the caller just read it, so the first round skips that read. */
export function pushInbox(
  ctx: ServerContext,
  id: string,
  task?: AgentTask,
  known?: TaskStatus,
): Promise<void> {
  if (task && !ctx.local && !task.runnerId && !ctx.runners[task.runner]?.push)
    return Promise.resolve();
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
    let fresh = known;
    const deliver = async () => {
      for (;;) {
        current.again = false;

        const status = fresh ?? (await ctx.store.get('task', id));
        fresh = undefined;
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
    } catch (error) {
      console.error(`coder server: inbox delivery failed for ${id}`, error);
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

export async function flushInbox(ctx: ServerContext, organizationId?: string): Promise<void> {
  const pending = await ctx.queue.pendingInbox(organizationId);
  await Promise.allSettled(
    pending.map(({ organizationId, status }) =>
      pushInbox(scoped(ctx, organizationId), status.task.id),
    ),
  );
}

export function scheduleInbox(ctx: ServerContext, organizationId?: string): void {
  const work = flushInbox(ctx, organizationId).catch(error =>
    console.error('coder server: inbox flush failed', error),
  );
  if (ctx.waitUntil) ctx.waitUntil(work);
  else void work;
}
