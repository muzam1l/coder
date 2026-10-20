/** The queue on Postgres: claims serialize under an advisory lock; a kick starts the work. */
import {
  connectionSnapshots,
  sealedCredential,
  sealedInstallation,
  sealedRow,
  sealedRunner,
  tokenState,
  unseenAcknowledged,
  type Sealed,
} from './tables/resources';
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

import { BATCH_LEASE_MS } from '../types';
import { createTaskToken } from '../../tasks/token';
import { ApprovalRefusedError, mergeApprovals, refusedAnswer } from '../../../core/approvals';
import type { AgentTask } from '../../../agent/types';
import type { TaskLogLine, TaskStatus } from '../types';
import type { StoredConfig } from '../../settings/config';
import {
  ACTIVE_STATES,
  BatchClaimLost,
  batchAdmissions,
  type Admission,
  type BatchAdmission,
  type CallbackState,
  sessionKey,
  reviewKey,
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
  type TaskRefresh,
} from '../../tasks/queue';
import {
  taskRecord,
  storedTaskContext,
  readTaskContext,
  fromJson,
  statePrefix,
  stateKey,
  rows,
  defined,
  ms,
} from './tables/shared';
import { appValue } from './tables/apps';
import { pipeline, readQuery, type Db } from './client';
import { STOPPED_BY_USER, TERMINAL_STATUSES, type Approval } from '../../../core/types';
import { listRank } from '../../../core/defaults';
import { AUTO_ARCHIVE_MS } from '../../../core/state';
import {
  integrationApp as app,
  integrationAppInstallation as install,
  chatState,
  engineCredential,
  runner,
  secret,
  usage,
  task,
  taskInbox,
  taskLog,
  taskTombstone,
} from './schema';

/** The organization part of a state key, from a row's organization id. */
const orgKey = (organizationId: SQL, kind: string) =>
  sql`('[' || to_json(${organizationId})::text || ',' || to_json(${kind}::text)::text || ']:')`;

/** The task's own credential row, as `credentialId` names it. */
const credentialOf = (row: SQL) =>
  sql`(select ${sealedRow(sql`c`, sql`s`)} from ${engineCredential} c join ${secret} s on s.id = c.secret_id
    where c.organization_id = ${row}.organization_id and coalesce(c.owner || '/', '') || c.label = ${row}.credential)`;
const configOf = (organizationId: SQL) =>
  sql`(select ${chatState.value} from ${chatState} where ${chatState.key} = 'o:' || ${orgKey(organizationId, 'config')} || 'workspace')`;
const runnerOf = (row: SQL) =>
  sql`(select ${sealedRow(sql`r`, sql`s`)} from ${runner} r join ${secret} s on s.id = r.secret_id
    where r.organization_id = ${row}.organization_id and r.public_id = ${row}.runner_id)`;

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

/** Ids in byte order, as the server and CLI compare them, whatever the database collation. */
const bytes = (id: SQLWrapper) => sql`${id} collate "C"`;

/** `awaitsApproval` in SQL: the turn waits, or an escalation has no answer. */
const awaiting = or(
  eq(task.status, 'waiting'),
  sql`jsonb_path_exists(${task.context}, '$.approvals[*] ? (!(exists(@.response)) || @.response == null)')`,
)!;

const pageOrder = (row: Record<'status' | 'createdAt' | 'publicId', SQLWrapper>) => [
  asc(rank(row.status)),
  desc(millis(row.createdAt)),
  desc(bytes(row.publicId)),
];

const deltaOrder = (row: Record<'updatedAt' | 'publicId', SQLWrapper>) => [
  asc(row.updatedAt),
  asc(bytes(row.publicId)),
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
    delivery?: Delivery,
    maxQueued?: number,
    admission?: Admission,
  ): Promise<boolean> {
    const statement = this.insertion(
      organizationId,
      agentTask,
      now,
      delivery,
      maxQueued,
      undefined,
      admission,
    );
    const [row] = await pipeline<{ allowed: boolean; inserted: boolean }>(
      this.db,
      maxQueued === undefined
        ? []
        : [sql`select pg_advisory_xact_lock(1, hashtext(${organizationId}))`],
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
    session?: { target: SQL; create: boolean; steer: string },
    admission?: Admission,
  ) {
    const event = agentTask.event;
    const stamp = new Date(now).toISOString();
    const json = (value: unknown) =>
      sql`${value === undefined ? null : JSON.stringify(value)}::jsonb`;
    const key = (id: string) => stateKey(organizationId, 'delivery', id);
    // The receipt lands over the claim this request holds, or over an expired row; a live one is someone else's.
    const receipt = delivery
      ? sql`
      receipt as (
        insert into ${chatState} (key, value, expires_at)
        select ${key(delivery.key)}, ${json({ at: now })}, ${new Date(now + delivery.ttlMs).toISOString()}::timestamptz
        from capacity where allowed ${session ? sql`and (${session.create} or exists (select 1 from target))` : sql``}
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
          where ${chatState.expiresAt} <= ${stamp}::timestamptz or ${chatState.value}->>'owner' = ${delivery.owner ?? null}::text
        returning key
      ),`
      : sql``;
    const admitted = sql`exists (select 1 from inserted)`;
    const upsert = sql`on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`;
    const { conversation, unseen, secrets } = admission ?? {};
    const recorded = sql`${
      conversation
        ? sql`, remembered as (insert into ${chatState} (key, value, expires_at)
        select key, value, ${new Date(now + conversation.ttlMs).toISOString()}::timestamptz from (values
          (${key(conversation.key)}, ${json(conversation.record)}), (${key(conversation.root)}, ${json({ at: conversation.record.at })})) as row(key, value)
        where ${admitted} ${upsert})`
        : sql``
    }${
      unseen
        ? sql`, acknowledged as (update ${chatState} set value = ${unseenAcknowledged(unseen.version)}
        where key = ${key(`since:${unseen.key}`)} and ${chatState.value}->>'epoch' is not distinct from ${unseen.epoch ?? null}::text
          and (expires_at is null or expires_at > ${stamp}::timestamptz) and ${admitted})`
        : sql``
    }${
      secrets?.length
        ? sql`, secrets as (insert into ${chatState} (key, value, expires_at)
        select key, value, expires_at from (values ${sql.join(
          secrets.map(
            row =>
              sql`(${stateKey(organizationId, 'snapshot', row.id)}, ${json({ secret: row.value, expiresAt: row.expiresAt })}, ${new Date(row.expiresAt).toISOString()}::timestamptz)`,
          ),
          sql`, `,
        )}) as row(key, value, expires_at) where ${admitted} on conflict (key) do nothing)`
        : sql``
    }`;
    return sql`
      with ${session ? sql`target as materialized (${session.target}),` : sql``} capacity as (
        select ${maxQueued === undefined ? sql`true` : sql`(select count(*) from ${task} where organization_id = ${organizationId} and status = 'queued') < ${maxQueued} ${delivery ? sql`or exists (select 1 from ${chatState} where key = ${key(delivery.key)} and expires_at > ${stamp}::timestamptz and value->>'owner' is distinct from ${delivery.owner ?? null}::text)` : sql``}`} ${session ? sql`or exists (select 1 from target) or not ${session.create}` : sql``} as allowed
      ), ${receipt} ${
        session
          ? sql`advanced as (
        update ${task} set inbox_seq = inbox_seq + 1, updated_at = ${stamp}::timestamptz where id in (select id from target) and exists (select 1 from receipt)
        returning id, inbox_seq, generation
      ), forwarded as (
        insert into ${taskInbox} (organization_id, task_id, seq, generation, at, kind, value)
        select ${organizationId}, id, inbox_seq, generation, ${stamp}::timestamptz, 'steer', ${json({ text: session!.steer })} from advanced returning seq
      ),`
          : sql``
      } inserted as (
        insert into ${task} (organization_id, public_id, source, status, agent, flow, review_key, runner, permissions,
          app_id, installation_id, event, prompt, args, mcp, author, definition, credential, requester,
          runner_id, usage, tools, context, files, attempts, created_at, updated_at)
        select ${organizationId}, ${agentTask.id}, ${agentTask.source}, 'queued', ${agentTask.agent}, ${agentTask.flow}, ${reviewKey(agentTask) ?? null}, ${agentTask.runner}, ${agentTask.permissions ?? null},
          ${event ? sql`coalesce((select id from ${app} where key = ${event.appId} and organization_id in (${organizationId}, '')), 0)` : sql`null`},
          ${event ? sql`coalesce((select id from ${install} where key = ${`${event.appId}:${event.installationId}`} and organization_id = ${organizationId}), 0)` : sql`null`},
          ${json(event)}, ${agentTask.prompt ?? null}, ${json(agentTask.args)}, ${json(agentTask.mcp)}, ${agentTask.author ?? null}, ${json(agentTask.definition)},
          ${agentTask.credential ?? null}, ${agentTask.requester ?? null}, ${agentTask.runnerId ?? null}, ${json(agentTask.usage)}, ${json(agentTask.tools)},
          ${json(storedTaskContext(agentTask))}, ${json(agentTask.files)}, 0, ${stamp}::timestamptz, ${stamp}::timestamptz
        from capacity where allowed ${session ? sql`and ${session.create} and not exists (select 1 from target)` : sql``} ${delivery ? sql`and exists (select 1 from receipt)` : sql``}
        returning id
      )${recorded} select allowed, exists (select 1 from inserted) as inserted ${session ? sql`, exists (select 1 from forwarded) as steered` : sql``} from capacity`;
  }

  async deliver(
    organizationId: string,
    agentTask: AgentTask,
    now: number,
    delivery: Delivery,
    steer: string | undefined,
    maxQueued?: number,
    create = true,
    admission?: Admission,
  ): Promise<{ taskId?: string; steered?: boolean }> {
    if (steer === undefined)
      return create &&
        (await this.enqueue(organizationId, agentTask, now, delivery, maxQueued, admission))
        ? { taskId: agentTask.id }
        : {};
    const event = agentTask.event;
    const target = sql`select id from ${task} where organization_id = ${organizationId} and status in ('queued', 'running', 'waiting')
      and agent = ${agentTask.agent} and source = ${agentTask.source} and flow = 'default'
      and event->>'appId' is not distinct from ${event?.appId ?? null}
      and event->>'installationId' is not distinct from ${event?.installationId ?? null}
      and event->'chat'->'thread'->>'id' = ${event?.chat?.thread.id || null}
      order by created_at desc, public_id desc limit 1 for update`;
    const statement = this.insertion(
      organizationId,
      agentTask,
      now,
      delivery,
      maxQueued,
      { target, create, steer },
      admission,
    );
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
    const unblocked = sql`not exists (select 1 from ${task} reviewing
      where reviewing.organization_id = ${task.organizationId} and reviewing.status in ('running', 'waiting')
        and reviewing.review_key = ${task.reviewKey})`;
    const available =
      concurrentTasks === undefined
        ? sql`true`
        : sql`(select count(*) from ${task} active where active.organization_id = ${task.organizationId} and active.status in ('running', 'waiting')) < ${concurrentTasks}`;
    if (!knownWork) {
      const [ready] = await readQuery(this.db, () =>
        rows<{ ready: boolean }>(
          this.db,
          sql`select exists (select 1 from ${task} where status = 'queued' and ${available} and ${unblocked})
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
        and ${available} and ${unblocked}
        ${maxTasks === undefined ? sql`` : sql`and (select count(*) from ${task} where status in ('running', 'waiting')) < ${maxTasks}`}
        order by created_at, id limit 1 for update
      ), claimed as (
        update ${task} set status = 'running', attempts = attempts + 1, locked_at = (select at from stamp),
          started_at = (select at from stamp), updated_at = (select at from stamp), last_seen_at = (select at from stamp),
          token_hash = translate(rtrim(encode(sha256(convert_to(picked.bearer, 'UTF8')), 'base64'), '='), '+/', '-_')
        from picked where ${task.id} = picked.id returning ${task}.*
      ) select to_jsonb(claimed) as record, exists (select 1 from ${task} where status = 'queued' and id <> claimed.id
        and ${unblocked} and (${task.organizationId} <> claimed.organization_id or ${task.reviewKey} is null or ${task.reviewKey} is distinct from claimed.review_key)
        and ${concurrentTasks === undefined ? sql`true` : sql`(select count(*) from ${task} active where active.organization_id = ${task.organizationId} and active.status in ('running', 'waiting')) + case when ${task.organizationId} = claimed.organization_id then 1 else 0 end < ${concurrentTasks}`})
        and ${maxTasks === undefined ? sql`true` : sql`(select count(*) from ${task} where status in ('running', 'waiting')) + 1 < ${maxTasks}`} as more,
        ${credentialOf(sql`claimed`)} as credential, ${configOf(sql`claimed.organization_id`)} as config, ${runnerOf(sql`claimed`)} as runner
        from claimed`;
    const [claimed] = await pipeline<{
      record: Record<string, unknown>;
      more: boolean;
      credential: Sealed | null;
      config: StoredConfig | null;
      runner: Sealed | null;
    }>(this.db, [sql`select pg_advisory_xact_lock(2, 0)`], statement);
    if (!claimed) return undefined;
    const row = fromJson(task, claimed.record);
    return {
      organizationId: row.organizationId,
      status: taskRecord(row),
      token: createTaskToken(row.publicId, row.organizationId, row.attempts, nonce).token,
      more: claimed.more,
      loaded: {
        credential: claimed.credential ? sealedCredential(claimed.credential).value : undefined,
        config: claimed.config ?? undefined,
        runner: claimed.runner ? sealedRunner(claimed.runner).value : undefined,
      },
    };
  }

  /** The task behind a runner's bearer, touched; `include` loads what the callback needs in the same statement. */
  async authorize(
    id: string,
    tokenHash: string,
    attempts: number,
    organizationId: string,
    now: number,
    options: { allowCompleted?: boolean; include?: 'secrets' | 'context' } = {},
  ): Promise<CallbackState | undefined> {
    const active = inArray(task.status, ['running', 'waiting']);
    const at = new Date(now).toISOString();
    const touched = this.db
      .update(task)
      .set({
        lastSeenAt: sql`case when ${active} then ${at}::timestamptz else ${task.lastSeenAt} end`,
        updatedAt: sql`case when ${active} then ${at}::timestamptz else ${task.updatedAt} end`,
      })
      .where(
        this.fence(organizationId, id, {
          tokenHash,
          attempts,
          statuses: options.allowCompleted
            ? ['running', 'waiting', 'completed', 'failed', 'cancelled']
            : ['running', 'waiting'],
        }),
      )
      .returning();
    const context = options.include === 'context';
    const secrets = Boolean(options.include);
    const t = chatState;
    const org = sql`touched.organization_id`;
    // Snapshot keys of this organization, built in SQL since its id comes from the row.
    const snapshot = (id: SQL) => sql`('o:' || ${orgKey(org, 'snapshot')} || ${id})`;
    const pattern = (value: SQL) =>
      sql`replace(replace(replace(${value}, '\\', '\\\\'), '%', '\\%'), '_', '\\_')`;
    const liveState = sql`(${t.expiresAt} is null or ${t.expiresAt} > ${at}::timestamptz)`;
    const [row] = await rows<{
      status: Record<string, unknown>;
      app: Sealed | null;
      installation: Parameters<typeof sealedInstallation>[0] | null;
      credential: Sealed | null;
      credentials: Sealed[] | null;
      config: StoredConfig | null;
      runner: Sealed | null;
      secrets: { rows: string[]; old: unknown } | null;
      resolved: { key: string; value: { resolvedConnections: string; expiresAt?: number } } | null;
      tokens: Record<string, unknown> | null;
    }>(
      this.db,
      sql`with touched as (${touched.getSQL()}), target as (
        select i.key, a.key as app from touched, ${install} i join ${app} a on a.id = i.app_id
        where i.key = touched.event->>'appId' || ':' || (touched.event->>'installationId') and i.organization_id = touched.organization_id and ${context}
      )
      select to_jsonb(touched) as status,
        case when ${context} then (select ${sealedRow(sql`a`, sql`s`)} from ${app} a join ${secret} s on s.id = a.credentials_secret_id
          where a.key = touched.event->>'appId' and a.organization_id in (touched.organization_id, '')) end as app,
        case when ${secrets} then (select ${sealedRow(sql`i`, sql`s`)} || jsonb_build_object('app', to_jsonb(a), 'credentials', to_jsonb(c))
          from ${install} i join ${app} a on a.id = i.app_id join ${secret} c on c.id = a.credentials_secret_id left join ${secret} s on s.id = i.token_secret_id
          where i.key = touched.event->>'appId' || ':' || (touched.event->>'installationId') and i.organization_id = touched.organization_id and i.deleted_at is null) end as installation,
        case when ${secrets} then ${credentialOf(sql`touched`)} end as credential,
        case when ${secrets} and touched.credential is null then (select coalesce(jsonb_agg(${sealedRow(sql`c`, sql`s`)}), '[]'::jsonb)
          from ${engineCredential} c join ${secret} s on s.id = c.secret_id where c.organization_id = touched.organization_id
          and (c.owner is null or c.owner = touched.requester)) end as credentials,
        case when ${context} then ${configOf(org)} end as config,
        case when ${context} then ${runnerOf(sql`touched`)} end as runner,
        case when ${secrets} then jsonb_build_object('rows', coalesce((select jsonb_agg(${t.value}->>'secret') from ${t}
          where ${t.key} like ${pattern(snapshot(sql`'connection-secrets:' || touched.public_id || ':'`))} || '%' and ${liveState}), '[]'::jsonb),
          'old', (select ${t.value} from ${t} where ${t.key} = ${snapshot(sql`'connection-secrets:' || touched.public_id`)} and ${liveState})) end as secrets,
        case when ${context} then (select jsonb_build_object('key', ${t.key}, 'value', ${t.value}) from ${t}
          where ${t.key} like ${pattern(snapshot(sql`'connections:' || touched.public_id || ':' || touched.generation || ':' || touched.attempts || ':'`))} || '%' and ${liveState} limit 1) end as resolved,
        case when ${context} then (select coalesce(jsonb_object_agg(${t.key}, ${t.value}), '{}'::jsonb) from ${t} where ${liveState} and (
          ${t.key} like any (select ${pattern(snapshot(sql`'token:' || key || ':'`))} || '%' from target)
          or ${t.key} in (select ${snapshot(sql`'token-drop:' || key`)} from target union all select ${snapshot(sql`'token-drop:' || app`)} from target))) end as tokens
      from touched`,
    );
    if (!row) return undefined;
    const record = fromJson(task, row.status);
    const prefix = statePrefix(record.organizationId, 'snapshot');
    const value = <T, R>(found: T | null, read: (found: T) => R) =>
      found ? read(found) : undefined;

    return {
      organizationId: record.organizationId,
      status: taskRecord(record),
      ...(secrets
        ? {
            loaded: {
              installation: value(
                row.installation,
                found => sealedInstallation(found).installation,
              ),
              credential: value(row.credential, found => sealedCredential(found).value),
              ...(row.credentials ? { credentials: row.credentials.map(sealedCredential) } : {}),
              secrets: value(row.secrets, found => ({
                rows: found.rows,
                ...(found.old ? { old: found.old } : {}),
              })),
              ...(context
                ? {
                    app: value(row.app, found =>
                      appValue(fromJson(app, found.row), fromJson(secret, found.sealed)),
                    ),
                    config: row.config ?? undefined,
                    runner: value(row.runner, found => sealedRunner(found).value),
                    resolved: value(row.resolved, found => ({
                      id: found.key.slice(prefix.length),
                      value: found.value,
                    })),
                    tokens: tokenState(record.organizationId, row.tokens ?? {}),
                  }
                : {}),
            },
          }
        : {}),
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
    return (await this.authorize(id, tokenHash, attempts, organizationId, now, { allowCompleted }))
      ?.status;
  }

  async patchTask(
    organizationId: string,
    id: string,
    patch: TaskPatch,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    const {
      answer,
      approvals,
      archivedAt,
      autoArchived: _auto,
      lastSeenAt,
      logsComplete,
      ...fields
    } = patch;
    // Approvals merge under the row lock, so concurrent answers and runner reports all land.
    const [row] = await this.db.transaction(async tx => {
      const [known] = approvals
        ? await tx
            .select({ context: task.context })
            .from(task)
            .where(this.where(organizationId, id))
            .for('update')
        : [];
      return tx
        .update(task)
        .set({
          ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? null])),
          ...(approvals
            ? {
                context: sql`jsonb_set(coalesce(${task.context}, '{}'::jsonb), '{approvals}', ${JSON.stringify(mergeApprovals(known?.context?.approvals ?? [], approvals))}::jsonb)`,
              }
            : {}),
          ...(logsComplete !== undefined
            ? {
                context: sql`jsonb_set(coalesce(${task.context}, '{}'::jsonb), '{runnerLogs}', coalesce(${task.context}->'runnerLogs', '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('complete', ${logsComplete ?? null}::boolean, 'handle', ${task.handle}, 'attempts', ${task.attempts}, 'generation', ${task.generation})))`,
              }
            : {}),
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
    });
    return Boolean(row);
  }

  async archiveStopped(
    organizationId: string | undefined,
    now: number,
    ids?: string[],
  ): Promise<void> {
    await this.db
      .update(task)
      .set({ archivedAt: new Date(now), updatedAt: new Date(now) })
      .where(
        and(
          organizationId === undefined ? undefined : eq(task.organizationId, organizationId),
          ids ? inArray(task.publicId, ids) : undefined,
          isNull(task.archivedAt),
          inArray(task.status, [...TERMINAL_STATUSES]),
          lt(
            sql`coalesce(${task.finishedAt}, ${task.updatedAt})`,
            sql`${new Date(now - AUTO_ARCHIVE_MS).toISOString()}::timestamptz`,
          ),
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

  private connectionLock(organizationId: string, id: string): SQL {
    return sql`select pg_advisory_xact_lock(3, hashtext(${`app:${organizationId}:connections:${id}`}))`;
  }

  async deleteTask(organizationId: string, id: string, fence: TaskFence): Promise<boolean> {
    const [row] = await pipeline<{ deleted: number }>(
      this.db,
      [this.connectionLock(organizationId, id)],
      sql`
      with gone as (
        delete from ${task} where ${this.fence(organizationId, id, fence)}
        returning organization_id, public_id
      ), marked as (
        insert into ${taskTombstone} (organization_id, public_id, deleted_at)
        select organization_id, public_id, clock_timestamp() from gone
      ), connections as (delete from ${chatState} where ${connectionSnapshots(organizationId, id)} and exists (select 1 from gone))
      select count(*)::int as deleted from gone`,
    );

    return Boolean(row?.deleted);
  }

  async finish(
    organizationId: string,
    id: string,
    outcome: Outcome,
    now: number,
    fence: TaskFence = {},
  ): Promise<boolean> {
    const at = new Date(now);
    const statement = this.db
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
    const [row] = await pipeline<{ id: number }>(
      this.db,
      [this.connectionLock(organizationId, id)],
      sql`
      with finished as (${statement.getSQL()}), purged as (
        delete from ${chatState} where ${connectionSnapshots(organizationId, id)} and exists (select 1 from finished)
      ) select id from finished`,
    );

    return Boolean(row);
  }

  async continueTask(
    organizationId: string,
    id: string,
    next: TaskRefresh,
    now: number,
    fence: TaskFence,
  ): Promise<boolean> {
    const context = sql`(${JSON.stringify(next.context ?? {})}::jsonb - 'connections' - 'engineChain' - 'engineCredentials') || jsonb_strip_nulls(jsonb_build_object('connections', ${task.context}->'connections', 'engineChain', ${task.context}->'engineChain', 'engineCredentials', ${task.context}->'engineCredentials'))`;
    const [row] = await this.db
      .update(task)
      .set({
        prompt: next.prompt ?? null,
        context,
        ...(next.definition ? { definition: next.definition } : {}),
        ...(next.usage ? { usage: next.usage } : {}),
        ...(next.tools ? { tools: next.tools } : {}),
        ...('files' in next ? { files: next.files ?? null } : {}),
        ...('permissions' in next ? { permissions: next.permissions ?? null } : {}),
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
    if (row) next.context = readTaskContext(row.context).context;
    return Boolean(row);
  }

  async completeTask(
    organizationId: string,
    id: string,
    completion: Completion,
    now: number,
  ): Promise<boolean> {
    const { outcome, usage: record } = completion;
    const at = new Date(now).toISOString();
    // The runner's log marker lands with the outcome when no machine stop has to come first.
    const context = completion.logsComplete
      ? sql`, context = jsonb_set(coalesce(${task.context}, '{}'::jsonb), '{runnerLogs}', jsonb_strip_nulls(jsonb_build_object('complete', true, 'handle', ${task.handle}, 'attempts', ${task.attempts}, 'generation', ${task.generation})))`
      : sql``;
    const known = completion.known?.length
      ? sql`, posts as (insert into ${chatState} (key, value, expires_at)
      select key, ${JSON.stringify({ at: now })}::jsonb, expires_at from (values ${sql.join(
        completion.known.map(
          post =>
            sql`(${stateKey(organizationId, 'delivery', post.id)}, ${new Date(now + post.ttlMs).toISOString()}::timestamptz)`,
        ),
        sql`, `,
      )}) as row(key, expires_at) where exists (select 1 from finished)
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at)`
      : sql``;
    const [row] = await pipeline<{ completed: boolean }>(
      this.db,
      [this.connectionLock(organizationId, id)],
      sql`
    with finished as (
      update ${task} set status = ${outcome.status}, result = ${JSON.stringify(outcome.result ?? null)}::jsonb,
        error = ${outcome.error ?? null}, tokens = ${JSON.stringify(outcome.tokens ?? null)}::jsonb,
        last_seen_at = ${at}::timestamptz, locked_at = null, finished_at = ${at}::timestamptz, updated_at = ${at}::timestamptz${context}
      where ${this.fence(organizationId, id, { attempts: completion.attempts, tokenHash: completion.tokenHash, statuses: ['running', 'waiting'] })}
      returning id, installation_id, generation
    ), connections as (delete from ${chatState} where ${connectionSnapshots(organizationId, id)} and exists (select 1 from finished)), inbox as (delete from ${taskInbox} where (task_id, generation) in (select id, generation from finished))${known}, recorded as (
      insert into ${usage} (organization_id, task_id, installation_id, agent, target, engine, model, credential, runner_ms, tokens, at, updated_at)
      select ${organizationId}, id, installation_id, ${record.agent}, ${record.target}, ${record.engine ?? null}, ${record.model ?? null},
        ${record.credential}, ${record.runnerElapsedMs}, ${JSON.stringify(record.tokens ?? null)}::jsonb, ${new Date(record.at).toISOString()}::timestamptz, ${at}::timestamptz from finished
      on conflict (task_id) do update set installation_id = excluded.installation_id, agent = excluded.agent, target = excluded.target,
        engine = excluded.engine, model = excluded.model, credential = excluded.credential, runner_ms = ${usage.runnerMs} + excluded.runner_ms,
        tokens = ${addTokens(sql`${usage.tokens}`, record.tokens)}, at = excluded.at, updated_at = excluded.updated_at
    )
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
    const [row] = await pipeline<{ accepted: boolean }>(
      this.db,
      [this.connectionLock(organizationId, id)],
      sql`
    with cancelled as (
      update ${task} set status = case when status = 'queued' then 'cancelled' else status end,
        finished_at = case when status = 'queued' then ${at}::timestamptz else finished_at end,
        error = case when status = 'queued' then ${STOPPED_BY_USER} else error end,
        inbox_seq = case when status = 'queued' then inbox_seq else inbox_seq + 1 end,
        cancel_requested_at = ${at}::timestamptz, updated_at = ${at}::timestamptz
      where ${this.fence(organizationId, id, { ...fence, statuses: ACTIVE_STATES })} returning id, generation, inbox_seq, status
    ), connections as (delete from ${chatState} where ${connectionSnapshots(organizationId, id)} and exists (select 1 from cancelled where status = 'cancelled')), message as (
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
    const states = opts.status && opts.status !== 'waiting' ? [opts.status] : opts.statuses;
    const q = opts.q?.trim();
    const pattern = q && `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    return and(
      eq(task.organizationId, organizationId),
      states ? inArray(task.status, states) : undefined,
      opts.status === 'waiting' ? awaiting : undefined,
      opts.agent ? eq(task.agent, opts.agent) : undefined,
      opts.source ? eq(task.source, opts.source) : undefined,
      opts.reviewKey ? eq(task.reviewKey, opts.reviewKey) : undefined,
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
          // The engine, model and effort the list shows, from what ran or else the agent's defaults.
          usage:
            sql`jsonb_strip_nulls(jsonb_build_object('engine', coalesce(${task.usage}->>'engine', ${task.definition}->>'engine'), 'model', coalesce(${task.usage}->>'model', ${task.definition}->>'model'), 'effort', coalesce(${task.usage}->>'effort', ${task.definition}->>'effort')))`.as(
              'usage',
            ),
          status: task.status,
          attempts: task.attempts,
          approval: task.approval,
          archivedAt: task.archivedAt,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          updatedAt: task.updatedAt,
        }
      : getTableColumns(task);
    const query = this.db
      .select(columns)
      .from(task)
      .where(
        and(
          this.filter(organizationId, opts),
          opts.since === undefined
            ? undefined
            : or(
                gt(task.updatedAt, new Date(opts.since)),
                opts.sinceId
                  ? and(
                      eq(task.updatedAt, new Date(opts.since)),
                      gt(bytes(task.publicId), opts.sinceId),
                    )
                  : undefined,
              ),
          before ? this.after(before) : undefined,
        ),
      )
      .orderBy(...(opts.since === undefined ? pageOrder(task) : deltaOrder(task)));
    return opts.limit === undefined ? query : query.limit(opts.limit);
  }

  /** Rows after the cursor in list order. */
  private after(before: ListCursor) {
    if ('updatedAt' in before)
      return or(
        gt(task.updatedAt, new Date(before.updatedAt)),
        and(eq(task.updatedAt, new Date(before.updatedAt)), gt(bytes(task.publicId), before.id)),
      );
    const older = sql`(${millis(task.createdAt)}, ${bytes(task.publicId)}) < (${new Date(before.createdAt).toISOString()}::timestamptz, ${before.id})`;
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
        usage: Object.keys((row.usage as object | null) ?? {}).length ? row.usage : undefined,
      }),
      status: row.status,
      attempts: row.attempts,
      approval: row.approval,
      archivedAt: row.archivedAt ? ms(row.archivedAt as Date) : undefined,
      createdAt: ms(row.createdAt as Date),
      startedAt: row.startedAt ? ms(row.startedAt as Date) : undefined,
      finishedAt: row.finishedAt ? ms(row.finishedAt as Date) : undefined,
      updatedAt: ms(row.updatedAt as Date),
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
        waiting: sql<number>`(count(*) filter (where ${awaiting}))::int`.as('waiting'),
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
          ...(opts.since === undefined
            ? pageOrder({
                status: fields.status!,
                createdAt: fields.createdAt!,
                publicId: fields.publicId!,
              })
            : deltaOrder({ updatedAt: fields.updatedAt!, publicId: fields.publicId! })),
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
    batch?: BatchAdmission,
    approvals?: Approval[],
  ): Promise<InboxEntry | undefined> {
    if (approvals)
      return this.db.transaction(async tx => {
        const [known] = await tx
          .select({ context: task.context })
          .from(task)
          .where(this.where(organizationId, id))
          .for('update');
        for (const answer of approvals) {
          const refused = refusedAnswer(
            known?.context?.approvals?.find(entry => entry.id === answer.id),
            answer,
          );
          if (refused) throw new ApprovalRefusedError(refused);
        }
        const merged = mergeApprovals(known?.context?.approvals ?? [], approvals);
        return this.insertInbox(
          tx,
          organizationId,
          id,
          kind,
          value,
          now,
          generation,
          batch,
          merged,
        );
      });

    return this.insertInbox(this.db, organizationId, id, kind, value, now, generation, batch);
  }

  /** One statement: the task's inbox position moves, the entry lands, and the batch or approvals write with it. */
  private async insertInbox(
    db: Pick<typeof this.db, 'execute'>,
    organizationId: string,
    id: string,
    kind: InboxEntry['kind'],
    value: unknown,
    now: number,
    generation: number,
    batch?: BatchAdmission,
    approvals?: Approval[],
  ): Promise<InboxEntry | undefined> {
    const held = batch
      ? sql`select key, value from ${chatState}
          where key = ${stateKey(organizationId, 'delivery', batch.key)}
            and value->'sending'->>'owner' = ${batch.owner}
            and (expires_at is null or expires_at > ${new Date(now).toISOString()}::timestamptz) for update`
      : sql`select null`;
    const admissions = batch && batchAdmissions(batch);
    const context = admissions
      ? sql`, context = coalesce(${task.context}, '{}'::jsonb) || jsonb_build_object('admissions',
          coalesce(${task.context}->'admissions', '{}'::jsonb) || ${JSON.stringify(admissions)}::jsonb)`
      : approvals
        ? sql`, context = jsonb_set(coalesce(${task.context}, '{}'::jsonb), '{approvals}', ${JSON.stringify(approvals)}::jsonb)`
        : sql``;
    const reserved = sql`(${chatState.value}->'sending'->>'count')::int`;
    const admitted = sql`coalesce((select n from jsonb_array_elements(${chatState.value}->'items') with ordinality e(item,n)
          where n <= ${reserved} and item->>'admission' = ${batch?.through ?? null}::text limit 1), 0)`;
    const [row] = await rows<{ seq: number | null; held: boolean }>(
      db,
      sql`
      with held as materialized (${held}), next as (
        update ${task} set inbox_seq = inbox_seq + 1, updated_at = ${new Date(now).toISOString()}::timestamptz${context}
        where ${this.fence(organizationId, id, { generation, statuses: ACTIVE_STATES })}
          and exists(select 1 from held) returning id, inbox_seq, generation
      ), admitted as (
        insert into ${taskInbox} (organization_id, task_id, seq, generation, kind, value, at)
        select ${organizationId}, id, inbox_seq, generation, ${kind}, ${JSON.stringify(admissions ? { ...(value as object), admissions } : (value ?? null))}::jsonb, ${new Date(now).toISOString()}::timestamptz from next returning seq
      ) ${
        batch
          ? sql`, acknowledged as (
        update ${chatState} set value = (${chatState.value} - 'sending') || jsonb_build_object(
          'items', coalesce((select jsonb_agg(item order by n) from jsonb_array_elements(${chatState.value}->'items') with ordinality e(item,n) where n > ${admitted}), '[]'::jsonb)) ||
          case when ${reserved} > ${admitted} then jsonb_build_object('sending',
            (${chatState.value}->'sending') || jsonb_build_object('count', ${reserved} - ${admitted}, 'until', ${now + BATCH_LEASE_MS}::bigint)) else '{}'::jsonb end
        where key in (select key from held) and exists(select 1 from admitted)
      )`
          : sql``
      }
      select (select seq from admitted) as seq, exists(select 1 from held) as held`,
    );
    if (batch && !row?.held) throw new BatchClaimLost();
    return row?.seq != null ? { seq: row.seq, generation, at: now, kind, value } : undefined;
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
  ): Promise<TaskStatus['status'] | undefined> {
    if (fence.generation !== undefined && fence.generation !== ack.generation) return undefined;
    const [row] = await pipeline<{ accepted: boolean; status: TaskStatus['status'] | null }>(
      this.db,
      [this.connectionLock(organizationId, id)],
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
        error = case when exists(select 1 from applied where kind = 'cancel') then ${STOPPED_BY_USER} else error end,
        updated_at = now()
      from answers where id in (select id from current) returning status
    ), connections as (delete from ${chatState} where ${connectionSnapshots(organizationId, id)} and exists (select 1 from updated where status = 'cancelled'))
    select exists (select 1 from current) as accepted, (select status from updated) as status`,
    );
    return row?.accepted ? (row.status ?? undefined) : undefined;
  }

  async pendingInbox(organizationId?: string): Promise<ClaimedTask[]> {
    const records = await readQuery(this.db, () =>
      this.db
        .select()
        .from(task)
        .where(
          and(
            organizationId === undefined ? undefined : eq(task.organizationId, organizationId),
            inArray(task.status, ['running', 'waiting']),
            sql`exists (select 1 from ${taskInbox} where ${taskInbox.taskId} = ${task.id} and ${taskInbox.generation} = ${task.generation})`,
          ),
        ),
    );
    return records.map(row => ({ organizationId: row.organizationId, status: taskRecord(row) }));
  }
}
