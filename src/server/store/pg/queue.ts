/** The queue on Postgres: `FOR UPDATE SKIP LOCKED` claims; the kick after each enqueue starts the work. */
import { CasingCache } from 'drizzle-orm/casing';
import { randomBytes } from 'node:crypto';

import {
  and,
  asc,
  desc,
  eq,
  gt,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';

import { createTaskToken } from '../../tasks/token';
import type { AgentTask } from '../../../agent/types';
import type { TaskLogLine, TaskStatus } from '../types';
import {
  ACTIVE_STATES,
  sessionKey,
  type Delivery,
  type ClaimedTask,
  type TaskCounts,
  type TaskMetrics,
  type TaskFilter,
  type TaskListOptions,
  type ListCursor,
  type TaskQueue,
  type Outcome,
  type InboxEntry,
  type Completion,
  type TaskFence,
  type TaskPatch,
} from '../../tasks/queue';
import { taskRecord, stateKey, statePrefix, rows, defined, ms } from './tables/shared';
import { CASING, pipeline, readQuery, type Db } from './client';
import { TERMINAL_STATUSES } from '../../../core/types';
import { listRank } from '../../../core/defaults';
import { AUTO_ARCHIVE_MS } from '../../../core/state';
import {
  integrationApp as app,
  integrationAppInstallation as install,
  chatState,
  usage,
  task,
  taskInbox,
  taskLog,
  taskTombstone,
} from './schema';

function addTokens(previous: SQL, value: unknown): SQL {
  if (typeof value === 'number')
    return sql`to_jsonb(coalesce(case when jsonb_typeof(${previous}) = 'number' then (${previous} #>> '{}')::numeric end, 0) + ${value}::numeric)`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return previous;
  const fields = Object.entries(value).map(
    ([key, amount]) => sql`${key}::text, ${addTokens(sql`(${previous} -> ${key}::text)`, amount)}`,
  );

  return sql`(case when jsonb_typeof(${previous}) = 'object' then ${previous} else '{}'::jsonb end || jsonb_build_object(${sql.join(fields, sql`, `)}))`;
}

/** `listRank` as SQL. */
const rank = (status: SQLWrapper) =>
  sql<number>`(case ${status} ${sql.join(
    [...ACTIVE_STATES, ...TERMINAL_STATUSES].map(
      state => sql`when ${state} then ${sql.raw(String(listRank(state)))}`,
    ),
    sql` `,
  )} end)`;

/** Milliseconds, as cursors carry them. */
const millis = (at: SQLWrapper) => sql`date_trunc('milliseconds', ${at})`;

const pageOrder = (row: Record<'status' | 'createdAt' | 'publicId', SQLWrapper>) => [
  asc(rank(row.status)),
  desc(millis(row.createdAt)),
  desc(row.publicId),
];

export class DrizzleQueue implements TaskQueue {
  constructor(private readonly db: Db) {}

  async metrics(organizationId: string, since: number): Promise<TaskMetrics> {
    const rows = await this.db
      .select({
        status: task.status,
        total: sql<number>`count(*)::int`,
        recent: sql<number>`count(*) filter (where ${task.createdAt} >= ${new Date(since).toISOString()}::timestamptz)::int`,
      })
      .from(task)
      .where(eq(task.organizationId, organizationId))
      .groupBy(task.status);
    const result: TaskMetrics = {
      tasks: { queued: 0, running: 0, waiting: 0, completed: 0, failed: 0, cancelled: 0 },
      queueDepth: 0,
    };
    for (const row of rows) {
      result.tasks[row.status] = row.recent;
      if (row.status === 'queued') result.queueDepth = row.total;
    }
    return result;
  }

  private where(organizationId: string, id: string) {
    return and(eq(task.organizationId, organizationId), eq(task.publicId, id));
  }

  private fence(organizationId: string, id: string, fence: TaskFence = {}) {
    return and(
      this.where(organizationId, id),
      fence.generation === undefined ? undefined : eq(task.generation, fence.generation),
      fence.attempts === undefined ? undefined : eq(task.attempts, fence.attempts),
      fence.tokenHash === undefined
        ? undefined
        : fence.tokenHash === null
          ? isNull(task.tokenHash)
          : eq(task.tokenHash, fence.tokenHash),
      fence.handle === undefined
        ? undefined
        : fence.handle === null
          ? isNull(task.handle)
          : eq(task.handle, fence.handle),
      fence.lastSeenAt === undefined
        ? undefined
        : fence.lastSeenAt === null
          ? isNull(task.lastSeenAt)
          : eq(task.lastSeenAt, new Date(fence.lastSeenAt)),
      fence.updatedAt === undefined ? undefined : eq(task.updatedAt, new Date(fence.updatedAt)),
      fence.statuses ? inArray(task.status, fence.statuses) : undefined,
    );
  }

  async enqueue(
    organizationId: string,
    agentTask: AgentTask,
    now: number,
    delivery?: { key: string; ttlMs: number },
    maxQueued?: number,
  ): Promise<boolean> {
    const statement = this.insertion(organizationId, agentTask, now, delivery, maxQueued);
    const [row] =
      maxQueued === undefined
        ? await rows<{ allowed: boolean; inserted: boolean }>(this.db, statement)
        : await pipeline<{ allowed: boolean; inserted: boolean }>(
            this.db,
            [sql`select pg_advisory_xact_lock(1, hashtext(${organizationId}))`],
            statement,
          );
    if (!row?.allowed) throw new Error('Organization task queue is full');
    return Boolean(row.inserted);
  }

  private insertion(
    organizationId: string,
    agentTask: AgentTask,
    now: number,
    delivery?: Delivery,
    maxQueued?: number,
    session?: { target: SQL; create: boolean },
  ) {
    const event = agentTask.event;
    const stamp = new Date(now).toISOString();
    const json = (value: unknown) =>
      sql`${value === undefined ? null : JSON.stringify(value)}::jsonb`;
    const receipt = delivery
      ? sql`
      receipt as (
        insert into ${chatState} (key, value, expires_at)
        select ${stateKey(organizationId, 'delivery', delivery.key)}, ${json({ at: now })}, ${new Date(now + delivery.ttlMs).toISOString()}::timestamptz
        from capacity where allowed ${session ? sql`and (${session.create} or exists (select 1 from target))` : sql``}
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
          where ${chatState.expiresAt} <= ${stamp}::timestamptz
        returning key
      ),`
      : sql``;
    return sql`
      with ${session ? sql`target as materialized (${session.target}),` : sql``} capacity as (
        select ${maxQueued === undefined ? sql`true` : sql`(select count(*) from ${task} where organization_id = ${organizationId} and status = 'queued') < ${maxQueued} ${delivery ? sql`or exists (select 1 from ${chatState} where key = ${stateKey(organizationId, 'delivery', delivery.key)} and expires_at > ${stamp}::timestamptz)` : sql``}`} ${session ? sql`or exists (select 1 from target) or not ${session.create}` : sql``} as allowed
      ), ${receipt} ${
        session
          ? sql`advanced as (
        update ${task} set inbox_seq = inbox_seq + 1, updated_at = ${stamp}::timestamptz where id in (select id from target) and exists (select 1 from receipt)
        returning id, inbox_seq, generation
      ), forwarded as (
        insert into ${taskInbox} (organization_id, task_id, seq, generation, at, kind, value)
        select ${organizationId}, id, inbox_seq, generation, ${stamp}::timestamptz, 'steer', ${json({ text: event?.text })} from advanced returning seq
      ),`
          : sql``
      } inserted as (
        insert into ${task} (organization_id, public_id, source, status, agent, flow, runner, permissions,
          app_id, installation_id, event, prompt, args, mcp, author, definition, credential, requester,
          runner_id, usage, tools, tool_scopes, context, files, attempts, created_at, updated_at)
        select ${organizationId}, ${agentTask.id}, ${agentTask.source}, 'queued', ${agentTask.agent}, ${agentTask.flow}, ${agentTask.runner}, ${agentTask.permissions ?? null},
          ${event ? sql`coalesce((select id from ${app} where key = ${event.appId} and organization_id in (${organizationId}, '')), 0)` : sql`null`},
          ${event ? sql`coalesce((select id from ${install} where key = ${`${event.appId}:${event.installationId}`} and organization_id = ${organizationId}), 0)` : sql`null`},
          ${json(event)}, ${agentTask.prompt ?? null}, ${json(agentTask.args)}, ${json(agentTask.mcp)}, ${agentTask.author ?? null}, ${json(agentTask.definition)},
          ${agentTask.credential ?? null}, ${agentTask.requester ?? null}, ${agentTask.runnerId ?? null}, ${json(agentTask.usage)}, ${json(agentTask.tools)},
          ${json(agentTask.toolScopes)}, ${json(agentTask.context)}, ${json(agentTask.files)}, 0, ${stamp}::timestamptz, ${stamp}::timestamptz
        from capacity where allowed ${session ? sql`and ${session.create} and not exists (select 1 from target)` : sql``} ${delivery ? sql`and exists (select 1 from receipt)` : sql``}
        returning id
      ) select allowed, exists (select 1 from inserted) as inserted ${session ? sql`, exists (select 1 from forwarded) as steered` : sql``} from capacity`;
  }

  async deliver(
    organizationId: string,
    agentTask: AgentTask,
    now: number,
    delivery: Delivery,
    steers: boolean,
    maxQueued?: number,
    create = true,
  ): Promise<{ taskId?: string; steered?: boolean }> {
    if (!steers)
      return create && (await this.enqueue(organizationId, agentTask, now, delivery, maxQueued))
        ? { taskId: agentTask.id }
        : {};
    const event = agentTask.event;
    const target = sql`select id from ${task} where organization_id = ${organizationId} and status in ('queued', 'running', 'waiting')
      and agent = ${agentTask.agent} and source = ${agentTask.source} and flow = 'default'
      and requester is not distinct from ${agentTask.requester ?? null}
      and event->>'appId' is not distinct from ${event?.appId ?? null}
      and event->>'installationId' is not distinct from ${event?.installationId ?? null}
      and event->'chat'->'thread'->>'id' is not distinct from ${event?.chat?.thread.id ?? null}
      and event->'actor'->>'id' = ${event?.actor.id || null}
      order by created_at desc, public_id desc limit 1 for update`;
    const statement = this.insertion(organizationId, agentTask, now, delivery, maxQueued, {
      target,
      create,
    });
    const locks = [
      sql`select pg_advisory_xact_lock(3, hashtext(${JSON.stringify([organizationId, sessionKey(agentTask)])}))`,
    ];
    if (maxQueued !== undefined && create)
      locks.push(sql`select pg_advisory_xact_lock(1, hashtext(${organizationId}))`);
    const [row] = await pipeline<{ allowed: boolean; inserted: boolean; steered: boolean }>(
      this.db,
      locks,
      statement,
    );
    if (!row?.allowed) throw new Error('Organization task queue is full');
    return row.inserted ? { taskId: agentTask.id } : row.steered ? { steered: true } : {};
  }

  async claim(_now: number, maxTasks?: number, knownWork = false, concurrentTasks?: number) {
    const available =
      concurrentTasks === undefined
        ? sql`true`
        : sql`(select count(*) from ${task} active where active.organization_id = ${task.organizationId} and active.status in ('running', 'waiting')) < ${concurrentTasks}`;
    if (!knownWork) {
      const [ready] = await readQuery(this.db, () =>
        rows<{ ready: boolean }>(
          this.db,
          sql`select exists (select 1 from ${task} where status = 'queued' and ${available})
        and ${maxTasks === undefined ? sql`true` : sql`(select count(*) from ${task} where status in ('running', 'waiting')) < ${maxTasks}`} as ready`,
        ),
      );
      if (!ready?.ready) return undefined;
    }
    const nonce = randomBytes(32).toString('base64url');
    const bearer = sql`translate(rtrim(replace(encode(convert_to(format('{"task":%s,"organization":%s,"attempt":%s}',
      to_json(public_id), to_json(organization_id), attempts + 1), 'UTF8'), 'base64'), E'\\n', ''), '='), '+/', '-_') || '.' || ${nonce}`;
    const statement = sql`with stamp as materialized (select date_trunc('milliseconds', clock_timestamp()) as at), picked as materialized (
      select id, ${bearer} as bearer from ${task} where status = 'queued'
        and ${available}
        ${maxTasks === undefined ? sql`` : sql`and (select count(*) from ${task} where status in ('running', 'waiting')) < ${maxTasks}`}
        order by created_at, id limit 1 for update
      ), claimed as (
        update ${task} set status = 'running', attempts = attempts + 1, locked_at = (select at from stamp),
          started_at = (select at from stamp), updated_at = (select at from stamp), last_seen_at = (select at from stamp),
          token_hash = translate(rtrim(encode(sha256(convert_to(picked.bearer, 'UTF8')), 'base64'), '='), '+/', '-_')
        from picked where ${task.id} = picked.id returning ${task}.*
      ) select to_jsonb(claimed) as record, exists (select 1 from ${task} where status = 'queued' and id <> claimed.id
        and ${concurrentTasks === undefined ? sql`true` : sql`(select count(*) from ${task} active where active.organization_id = ${task.organizationId} and active.status in ('running', 'waiting')) + case when ${task.organizationId} = claimed.organization_id then 1 else 0 end < ${concurrentTasks}`})
        and ${maxTasks === undefined ? sql`true` : sql`(select count(*) from ${task} where status in ('running', 'waiting')) + 1 < ${maxTasks}`} as more from claimed`;
    const [claimed] = await pipeline<{ record: Record<string, unknown>; more: boolean }>(
      this.db,
      maxTasks === undefined && concurrentTasks === undefined
        ? []
        : [sql`select pg_advisory_xact_lock(2, 0)`],
      statement,
    );
    if (!claimed) return undefined;
    const casing = new CasingCache(CASING);
    const row = Object.fromEntries(
      Object.entries(getTableColumns(task)).map(([key, column]) => {
        const value = claimed.record[casing.getColumnCasing(column)];
        return [key, value === null ? null : column.mapFromDriverValue(value)];
      }),
    ) as typeof task.$inferSelect;
    return {
      organizationId: row.organizationId,
      status: taskRecord(row),
      token: createTaskToken(row.publicId, row.organizationId, row.attempts, nonce).token,
      more: claimed.more,
    };
  }

  async touch(
    organizationId: string,
    id: string,
    tokenHash: string,
    attempts: number,
    now: number,
    allowCompleted = false,
  ): Promise<TaskStatus | undefined> {
    const active = inArray(task.status, ['running', 'waiting']);
    const at = new Date(now).toISOString();
    const [row] = await this.db
      .update(task)
      .set({
        lastSeenAt: sql`case when ${active} then ${at}::timestamptz else ${task.lastSeenAt} end`,
        updatedAt: sql`case when ${active} then ${at}::timestamptz else ${task.updatedAt} end`,
      })
      .where(
        this.fence(organizationId, id, {
          tokenHash,
          attempts,
          statuses: allowCompleted
            ? ['running', 'waiting', 'completed', 'failed', 'cancelled']
            : ['running', 'waiting'],
        }),
      )
      .returning();
    return row && taskRecord(row);
  }

  async patchTask(
    organizationId: string,
    id: string,
    patch: TaskPatch,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    const { answer, archivedAt, autoArchived: _auto, lastSeenAt, ...fields } = patch;
    const [row] = await this.db
      .update(task)
      .set({
        ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? null])),
        ...(answer === undefined
          ? {}
          : {
              answer: sql`coalesce(${task.answer}, '[]'::jsonb) || ${JSON.stringify([answer])}::jsonb`,
            }),
        ...(Object.hasOwn(patch, 'archivedAt')
          ? { archivedAt: archivedAt === undefined ? null : new Date(archivedAt) }
          : {}),
        ...(Object.hasOwn(patch, 'lastSeenAt')
          ? { lastSeenAt: lastSeenAt === undefined ? null : new Date(lastSeenAt) }
          : {}),
        updatedAt: new Date(now),
      })
      .where(this.fence(organizationId, id, fence))
      .returning({ id: task.id });
    return Boolean(row);
  }

  async archiveStopped(organizationId: string, now: number, ids?: string[]): Promise<void> {
    await this.db
      .update(task)
      .set({ archivedAt: new Date(now) })
      .where(
        and(
          eq(task.organizationId, organizationId),
          ids ? inArray(task.publicId, ids) : undefined,
          isNull(task.archivedAt),
          inArray(task.status, [...TERMINAL_STATUSES]),
          lt(sql`coalesce(${task.finishedAt}, ${task.updatedAt})`, new Date(now - AUTO_ARCHIVE_MS)),
        ),
      );
  }

  async requeue(
    organizationId: string,
    id: string,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    const [row] = await this.db
      .update(task)
      .set({
        status: 'queued',
        lockedAt: null,
        handle: null,
        tokenHash: null,
        lastSeenAt: null,
        updatedAt: new Date(now),
      })
      .where(this.fence(organizationId, id, { ...fence, statuses: ['running', 'waiting'] }))
      .returning({ id: task.id });
    return Boolean(row);
  }

  async finish(
    organizationId: string,
    id: string,
    outcome: Outcome,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    const at = new Date(now);
    const [row] = await this.db
      .update(task)
      .set({
        status: outcome.status,
        result: outcome.result ?? null,
        error: outcome.error ?? null,
        tokens: outcome.tokens ?? null,
        lastSeenAt: at,
        lockedAt: null,
        finishedAt: at,
        updatedAt: at,
      })
      .where(
        this.fence(organizationId, id, { ...fence, statuses: ['queued', 'running', 'waiting'] }),
      )
      .returning({ id: task.id });
    return Boolean(row);
  }

  async continueTask(
    organizationId: string,
    id: string,
    next: Pick<AgentTask, 'prompt' | 'context'>,
    now: number,
    fence: TaskFence,
  ): Promise<boolean> {
    const note = sql`(select value from ${chatState} where key = ${statePrefix(organizationId, 'note')} ||
      case when ${task.source} = ${task.event}->>'integration' then
        (${task.event}->>'appId') || ':' || (${task.event}->>'installationId') || ':' || coalesce(${task.event}->'chat'->'thread'->>'id', ${task.event}->>'deliveryId')
        else 'task:' || ${task.publicId} end
      and (${chatState.expiresAt} is null or ${chatState.expiresAt} > ${new Date(now).toISOString()}::timestamptz))`;
    const context = sql`(${JSON.stringify(next.context ?? {})}::jsonb - 'note') || jsonb_strip_nulls(jsonb_build_object('note', nullif(${note}, '""'::jsonb)))`;
    const [row] = await this.db
      .update(task)
      .set({
        prompt: next.prompt ?? null,
        context,
        status: 'queued',
        attempts: 0,
        generation: sql`${task.generation} + 1`,
        inboxAck: -1,
        result: null,
        error: null,
        tokens: null,
        handle: null,
        tokenHash: null,
        lastSeenAt: null,
        logCursor: null,
        lockedAt: null,
        startedAt: null,
        finishedAt: null,
        cancelRequestedAt: null,
        approval: null,
        answer: null,
        archivedAt: null,
        updatedAt: new Date(now),
      })
      .where(
        this.fence(organizationId, id, {
          ...fence,
          statuses: ['completed', 'failed', 'cancelled'],
        }),
      )
      .returning({ context: task.context });
    if (row) next.context = row.context ?? undefined;
    return Boolean(row);
  }

  async completeTask(
    organizationId: string,
    id: string,
    completion: Completion,
    now: number,
  ): Promise<boolean> {
    const { outcome, usage: record, note } = completion;
    const at = new Date(now).toISOString();
    const noteKey = note && stateKey(organizationId, 'note', note.key);
    const noteMutation = !note
      ? sql``
      : note.value
        ? sql`, note as (
      insert into ${chatState} (key, value, expires_at)
      select ${noteKey}, ${JSON.stringify(note.value)}::jsonb, ${new Date(now + note.ttlMs).toISOString()}::timestamptz from finished
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
    )`
        : sql`, note as (delete from ${chatState} where key = ${noteKey} and exists (select 1 from finished))`;
    const [row] = await rows<{ completed: boolean }>(
      this.db,
      sql`
      with finished as (
        update ${task} set status = ${outcome.status}, result = ${JSON.stringify(outcome.result ?? null)}::jsonb,
          error = ${outcome.error ?? null}, tokens = ${JSON.stringify(outcome.tokens ?? null)}::jsonb,
          last_seen_at = ${at}::timestamptz, locked_at = null, finished_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
        where ${this.fence(organizationId, id, { attempts: completion.attempts, tokenHash: completion.tokenHash, statuses: ['running', 'waiting'] })}
        returning id, installation_id, generation
      ), inbox as (delete from ${taskInbox} where (task_id, generation) in (select id, generation from finished)), recorded as (
        insert into ${usage} (organization_id, task_id, installation_id, agent, target, engine, model, credential, runner_ms, tokens, at, updated_at)
        select ${organizationId}, id, installation_id, ${record.agent}, ${record.target}, ${record.engine ?? null}, ${record.model ?? null},
          ${record.credential}, ${record.runnerElapsedMs}, ${JSON.stringify(record.tokens ?? null)}::jsonb, ${new Date(record.at).toISOString()}::timestamptz, ${at}::timestamptz from finished
        on conflict (task_id) do update set installation_id = excluded.installation_id, agent = excluded.agent, target = excluded.target,
          engine = excluded.engine, model = excluded.model, credential = excluded.credential, runner_ms = ${usage.runnerMs} + excluded.runner_ms,
          tokens = ${addTokens(sql`${usage.tokens}`, record.tokens)}, at = excluded.at, updated_at = excluded.updated_at
      ) ${noteMutation}
      select exists (select 1 from finished) as completed`,
    );
    return Boolean(row?.completed);
  }

  async cancel(
    organizationId: string,
    id: string,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    const at = new Date(now).toISOString();
    const [row] = await rows<{ accepted: boolean }>(
      this.db,
      sql`
      with cancelled as (
        update ${task} set status = case when status = 'queued' then 'cancelled' else status end,
          finished_at = case when status = 'queued' then ${at}::timestamptz else finished_at end,
          inbox_seq = case when status = 'queued' then inbox_seq else inbox_seq + 1 end,
          cancel_requested_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
        where ${this.fence(organizationId, id, { ...fence, statuses: ACTIVE_STATES })} returning id, generation, inbox_seq, status
      ), message as (
        insert into ${taskInbox} (organization_id, task_id, seq, generation, kind, value, at)
        select ${organizationId}, id, inbox_seq, generation, 'cancel', 'null'::jsonb, ${at}::timestamptz from cancelled where status in ('running', 'waiting')
      ) select exists(select 1 from cancelled) as accepted`,
    );
    return Boolean(row?.accepted);
  }

  async cancelRequested(organizationId: string, id: string): Promise<boolean> {
    const [row] = await readQuery(this.db, () =>
      this.db
        .select({ at: task.cancelRequestedAt })
        .from(task)
        .where(this.where(organizationId, id)),
    );
    return Boolean(row?.at);
  }

  private filter(organizationId: string, opts: TaskFilter) {
    const states = opts.status ? [opts.status] : opts.statuses;
    const q = opts.q?.trim();
    const pattern = q && `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return and(
      eq(task.organizationId, organizationId),
      states ? inArray(task.status, states) : undefined,
      opts.agent ? eq(task.agent, opts.agent) : undefined,
      opts.source ? eq(task.source, opts.source) : undefined,
      opts.archived === undefined
        ? undefined
        : opts.archived
          ? isNotNull(task.archivedAt)
          : isNull(task.archivedAt),
      pattern
        ? or(
            ilike(sql`${task.event}->>'text'`, pattern),
            ilike(task.prompt, pattern),
            ilike(task.agent, pattern),
            ilike(task.publicId, pattern),
          )
        : undefined,
    );
  }

  private pageQuery(organizationId: string, opts: TaskListOptions) {
    const { before } = opts;
    const columns = opts.summary
      ? {
          publicId: task.publicId,
          source: task.source,
          agent: task.agent,
          flow: task.flow,
          prompt: task.prompt,
          event:
            sql`case when ${task.event} is not null then jsonb_build_object('integration', ${task.event}->>'integration', 'type', ${task.event}->>'type', 'text', ${task.event}->>'text') end`.as(
              'event',
            ),
          status: task.status,
          attempts: task.attempts,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
        }
      : getTableColumns(task);
    const query = this.db
      .select(columns)
      .from(task)
      .where(and(this.filter(organizationId, opts), before ? this.after(before) : undefined))
      .orderBy(...pageOrder(task));
    return opts.limit === undefined ? query : query.limit(opts.limit);
  }

  /** Rows after the cursor in list order. */
  private after(before: ListCursor) {
    const older = sql`(${millis(task.createdAt)}, ${task.publicId}) < (${new Date(before.createdAt).toISOString()}::timestamptz, ${before.id})`;
    return or(gt(rank(task.status), before.rank), and(eq(rank(task.status), before.rank), older));
  }

  private record(row: Record<string, unknown>, summary?: boolean): TaskStatus {
    if (!summary) return taskRecord(row as typeof task.$inferSelect);
    return defined({
      task: defined({
        id: row.publicId,
        source: row.source,
        agent: row.agent,
        flow: row.flow,
        prompt: row.prompt,
        event: row.event,
      }),
      status: row.status,
      attempts: row.attempts,
      createdAt: ms(row.createdAt as Date),
      startedAt: row.startedAt ? ms(row.startedAt as Date) : undefined,
      finishedAt: row.finishedAt ? ms(row.finishedAt as Date) : undefined,
    }) as TaskStatus;
  }

  async list(organizationId: string, opts: TaskListOptions = {}): Promise<TaskStatus[]> {
    const records = await readQuery(this.db, () => this.pageQuery(organizationId, opts));
    return records.map(row => this.record(row, opts.summary));
  }

  async changes(scopes: Array<{ organizationId: string; ids: string[] }>, since: number) {
    if (!scopes.length) return { rows: [], deleted: [] };
    const organizationIds = scopes.map(scope => scope.organizationId);
    // Two array parameters however many tasks are asked.
    const organizations = scopes.flatMap(scope => scope.ids.map(() => scope.organizationId));
    const ids = scopes.flatMap(scope => scope.ids);
    const asked = ids.length
      ? sql`(${task.organizationId}, ${task.publicId}) in (select * from unnest(${sql.param(organizations)}::text[], ${sql.param(ids)}::text[]))`
      : sql`false`;
    // Only asked tasks carry their result, error and answers.
    const [records, tombstones] = await Promise.all([
      readQuery(this.db, () =>
        this.db
          .select({
            organizationId: task.organizationId,
            publicId: task.publicId,
            source: task.source,
            agent: task.agent,
            flow: task.flow,
            status: task.status,
            approval: task.approval,
            answer: sql<unknown>`case when ${asked} then ${task.answer} end`,
            result: sql<
              typeof task.$inferSelect.result
            >`case when ${asked} then ${task.result} end`,
            error: sql<string | null>`case when ${asked} then ${task.error} end`,
            attempts: task.attempts,
            archivedAt: task.archivedAt,
            createdAt: task.createdAt,
            startedAt: task.startedAt,
            finishedAt: task.finishedAt,
            updatedAt: task.updatedAt,
          })
          .from(task)
          .where(
            or(
              and(
                inArray(task.organizationId, organizationIds),
                gt(task.updatedAt, new Date(since)),
              ),
              ids.length ? asked : undefined,
            ),
          ),
      ),
      readQuery(this.db, () =>
        this.db
          .select()
          .from(taskTombstone)
          .where(
            and(
              inArray(taskTombstone.organizationId, organizationIds),
              gt(taskTombstone.deletedAt, new Date(since)),
            ),
          ),
      ),
    ]);
    const rows = records.map(row => ({
      organizationId: row.organizationId,
      status: defined({
        task: { id: row.publicId, source: row.source, agent: row.agent, flow: row.flow },
        status: row.status,
        approval: row.approval,
        answer: Array.isArray(row.answer) ? row.answer : undefined,
        result: row.result,
        error: row.error,
        attempts: row.attempts,
        archivedAt: row.archivedAt && ms(row.archivedAt),
        createdAt: ms(row.createdAt),
        startedAt: row.startedAt && ms(row.startedAt),
        finishedAt: row.finishedAt && ms(row.finishedAt),
        updatedAt: ms(row.updatedAt),
      }) as TaskStatus,
    }));

    return {
      rows,
      deleted: tombstones.map(row => ({
        organizationId: row.organizationId,
        id: row.publicId,
        at: ms(row.deletedAt),
      })),
    };
  }

  private countQuery(organizationId: string, filter: TaskFilter) {
    return this.db
      .select({
        all: sql<number>`count(*)::int`.as('all'),
        active:
          sql<number>`(count(*) filter (where ${inArray(task.status, ACTIVE_STATES)}))::int`.as(
            'active',
          ),
        waiting: sql<number>`(count(*) filter (where ${eq(task.status, 'waiting')}))::int`.as(
          'waiting',
        ),
      })
      .from(task)
      .where(this.filter(organizationId, filter));
  }

  async counts(organizationId: string, filter: TaskFilter = {}): Promise<TaskCounts> {
    const [row] = await readQuery(this.db, () => this.countQuery(organizationId, filter));
    return row ?? { all: 0, active: 0, waiting: 0 };
  }

  async listWithCounts(organizationId: string, opts: TaskListOptions) {
    const totals = this.db.$with('totals').as(this.countQuery(organizationId, opts));
    const page = this.db
      .$with('page')
      .as(this.pageQuery(organizationId, { ...opts, limit: opts.limit ?? 20 }));
    const fields = Object.fromEntries(
      Object.keys(page._.selectedFields).map(key => [
        key,
        (page as unknown as Record<string, import('drizzle-orm/pg-core').PgColumn>)[key]!,
      ]),
    ) as Record<string, import('drizzle-orm/pg-core').PgColumn>;
    const records: Array<Record<string, unknown> & TaskCounts> = await readQuery(this.db, () =>
      this.db
        .with(totals, page)
        .select({ ...fields, all: totals.all, active: totals.active, waiting: totals.waiting })
        .from(totals)
        .leftJoin(page, sql`true`)
        .orderBy(
          ...pageOrder({
            status: fields.status!,
            createdAt: fields.createdAt!,
            publicId: fields.publicId!,
          }),
        ),
    );
    const { all = 0, active = 0, waiting = 0 } = records[0] ?? {};
    return {
      items: records
        .filter(row => row.publicId !== null && row.publicId !== undefined)
        .map(row => this.record(row, opts.summary)),
      counts: { all, active, waiting },
    };
  }

  async runningCount(): Promise<number> {
    const [row] = await readQuery(this.db, () =>
      this.db
        .select({ value: sql<number>`count(*)::int` })
        .from(task)
        .where(inArray(task.status, ['running', 'waiting'])),
    );
    return row?.value ?? 0;
  }

  async running(): Promise<ClaimedTask[]> {
    const rows = await readQuery(this.db, () =>
      this.db
        .select()
        .from(task)
        .where(inArray(task.status, ['running', 'waiting'])),
    );
    return rows.map(row => ({
      organizationId: row.organizationId,
      status: taskRecord(row),
    }));
  }

  async appendLogs(
    organizationId: string,
    id: string,
    lines: TaskLogLine[],
    from: { seq: number; cursor: number },
    progress: { cursor: number; seq: number; bytes: number },
    now: number,
    fence: TaskFence,
  ): Promise<boolean> {
    const insertion = lines.length
      ? sql`, inserted as (
      insert into ${taskLog} (organization_id, task_id, seq, at, level, line)
      select ${organizationId}, accepted.id, entry.seq, to_timestamp(entry.at / 1000.0), entry.level, entry.line
      from accepted cross join jsonb_to_recordset(${JSON.stringify(lines)}::jsonb) as entry(seq int, at bigint, level text, line text)
    )`
      : sql``;
    const [row] = await rows<{ accepted: boolean }>(
      this.db,
      sql`
      with accepted as (
        update ${task} set log_cursor = ${progress.cursor}, log_seq = ${progress.seq}, log_bytes = ${progress.bytes}, updated_at = ${new Date(now).toISOString()}::timestamptz
        where ${this.fence(organizationId, id, fence)} and coalesce(log_seq, 0) = ${from.seq} and coalesce(log_cursor, -1) = ${from.cursor}
        returning id
      ) ${insertion} select exists (select 1 from accepted) as accepted`,
    );
    return Boolean(row?.accepted);
  }

  async readInbox(
    organizationId: string,
    id: string,
    generation: number,
    after: number,
  ): Promise<InboxEntry[]> {
    const records = await readQuery(this.db, () =>
      this.db
        .select({
          seq: taskInbox.seq,
          generation: taskInbox.generation,
          at: taskInbox.at,
          kind: taskInbox.kind,
          value: taskInbox.value,
        })
        .from(taskInbox)
        .innerJoin(task, eq(task.id, taskInbox.taskId))
        .where(
          and(
            this.where(organizationId, id),
            eq(task.generation, generation),
            inArray(task.status, ACTIVE_STATES),
            eq(taskInbox.generation, generation),
            sql`${taskInbox.seq} > ${after}`,
          ),
        )
        .orderBy(asc(taskInbox.seq))
        .limit(100),
    );
    return records.map(row => ({ ...row, at: ms(row.at) }));
  }

  async appendInbox(
    organizationId: string,
    id: string,
    kind: InboxEntry['kind'],
    value: unknown,
    now: number,
    generation: number,
  ): Promise<InboxEntry | undefined> {
    const [row] = await rows<{ seq: number }>(
      this.db,
      sql`
      with next as (
        update ${task} set inbox_seq = inbox_seq + 1, updated_at = ${new Date(now).toISOString()}::timestamptz where ${this.fence(organizationId, id, { generation, statuses: ACTIVE_STATES })} returning id, inbox_seq, generation
      ) insert into ${taskInbox} (organization_id, task_id, seq, generation, kind, value, at)
        select ${organizationId}, id, inbox_seq, generation, ${kind}, ${JSON.stringify(value ?? null)}::jsonb, ${new Date(now).toISOString()}::timestamptz from next returning seq`,
    );
    return row && { seq: row.seq, generation, at: now, kind, value };
  }

  async fetchInbox(
    organizationId: string,
    id: string,
    tokenHash: string,
    attempts: number,
    after: number,
  ): Promise<InboxEntry[] | undefined> {
    const [row] = await readQuery(this.db, () =>
      rows<{ entries: InboxEntry[] }>(
        this.db,
        sql`
      select coalesce(jsonb_agg(jsonb_build_object('seq', i.seq, 'generation', i.generation, 'at', extract(epoch from i.at) * 1000, 'kind', i.kind, 'value', i.value) order by i.seq) filter (where i.seq is not null), '[]'::jsonb) as entries
      from ${task} left join ${taskInbox} i on i.task_id = ${task.id} and i.generation = ${task.generation} and i.seq > ${after}
      where ${this.fence(organizationId, id, { tokenHash, attempts, statuses: ['running', 'waiting'] })} group by ${task.id}`,
      ),
    );
    return row?.entries;
  }

  async ackInbox(
    organizationId: string,
    id: string,
    ack: import('../../tasks/queue').InboxAck,
    fence: TaskFence,
  ): Promise<boolean> {
    if (fence.generation !== undefined && fence.generation !== ack.generation) return false;
    const [row] = await rows<{ accepted: boolean }>(
      this.db,
      sql`
      with current as (
        select id from ${task} where ${this.fence(organizationId, id, { ...fence, generation: ack.generation, statuses: undefined })}
          and inbox_seq >= ${ack.seq} and (status in ('running', 'waiting') or (status in ('completed', 'failed', 'cancelled') and inbox_ack >= ${ack.seq})) for update
      ), applied as (
        delete from ${taskInbox} where task_id in (select id from current) and generation = ${ack.generation} and seq <= ${ack.seq} returning seq, kind, value
      ), answers as (
        select jsonb_agg(a.value order by a.seq) as value from jsonb_to_recordset(${JSON.stringify(ack.answers ?? [])}::jsonb) a(seq int, value jsonb)
        where exists (select 1 from applied where applied.seq = a.seq and applied.kind = 'ask')
      ), updated as (
        update ${task} set inbox_ack = greatest(inbox_ack, ${ack.seq}), answer = coalesce(answer, '[]'::jsonb) || coalesce(answers.value, '[]'::jsonb),
          status = case when exists(select 1 from applied where kind = 'cancel') then 'cancelled'
            when exists(select 1 from applied where kind = 'approve' and value->>'approvalId' = ${task.approval}->>'id') then 'running' else status end,
          approval = case when exists(select 1 from applied where kind = 'approve' and value->>'approvalId' = ${task.approval}->>'id') then null else approval end,
          finished_at = case when exists(select 1 from applied where kind = 'cancel') then now() else finished_at end,
          updated_at = now()
        from answers where id in (select id from current)
      ) select exists (select 1 from current) as accepted`,
    );
    return Boolean(row?.accepted);
  }

  async pendingInbox(): Promise<ClaimedTask[]> {
    const records = await readQuery(this.db, () =>
      this.db
        .select()
        .from(task)
        .where(
          and(
            inArray(task.status, ['running', 'waiting']),
            sql`exists (select 1 from ${taskInbox} where ${taskInbox.taskId} = ${task.id} and ${taskInbox.generation} = ${task.generation})`,
          ),
        ),
    );
    return records.map(row => ({ organizationId: row.organizationId, status: taskRecord(row) }));
  }
}
