/** The queue on Postgres: claims serialize under an advisory lock; a kick starts the work. */
import {
  sealedCredential,
  sealedInstallation,
  sealedRunner,
  tokenState,
  unseenAcknowledged,
  type JsonRow,
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
import { ApprovalRefusedError, mergeApprovals, refusedAnswer } from '../../../core/approvals';
import type { AgentTask } from '../../../agent/types';
import type { LinkedMember } from '../../../integrations/types';
import type { TaskLogLine, TaskStatus } from '../types';
import type { StoredConfig } from '../../settings/config';
import {
  MEMBERS_CLAIM_MS,
  createTaskToken,
  spaceAudience,
  spaceKey,
  taskAudience,
  type SpaceEvent,
} from '../../tasks/access';
import {
  ACTIVE_STATES,
  BatchClaimLost,
  batchAdmissions,
  type Admission,
  type AudienceCount,
  type BatchAdmission,
  type CallbackState,
  sessionKey,
  type Delivery,
  type ClaimedTask,
  type TaskCounts,
  type TaskMetrics,
  type TaskFilter,
  type TaskListOptions,
  type ListCursor,
  type LogTail,
  type TaskQueue,
  type Outcome,
  type InboxEntry,
  type Completion,
  type TaskFence,
  type TaskPatch,
  type TaskRefresh,
  type RunningTask,
} from '../../tasks/queue';
import { taskRecord, fromJson, stateKey, rows, defined, ms, withSecret } from './tables/shared';
import { taskSecretRows } from './store';
import { appValue } from './tables/apps';
import { pipeline, readQuery, type Db } from './client';
import { STOPPED_BY_USER, TERMINAL_STATUSES, type Approval } from '../../../core/types';
import { listRank, logEntry } from '../../../core/task/view';
import { AUTO_ARCHIVE_MS } from '../../../core/state';
import {
  integrationApp as app,
  integrationAppInstallation as install,
  chatState,
  engineCredential,
  platformLink,
  privateSpace,
  spaceMember,
  runner,
  secret,
  task,
  taskInbox,
  taskLog,
  taskSecret,
  taskTombstone,
  workspace,
  workspaceUsage,
} from './schema';
import { countTokens } from '../../tasks/usage';

/** The organization part of a state key, from a row's organization id. */
const orgKey = (organizationId: SQL, kind: string) =>
  sql`('[' || to_json(${organizationId})::text || ',' || to_json(${kind}::text)::text || ']:')`;

/** The credential row of the task's first attempt, as `credentialId` names it, with its secret. */
const credentialOf = (row: SQL) =>
  sql`(select ${withSecret(sql`to_jsonb(c)`, sql`s.value`)} from ${engineCredential} c join ${secret} s on s.id = c.secret_id
    where c.organization_id = ${row}.organization_id and coalesce(c.owner || '/', '') || c.label = ${row}.models->0->>'credential')`;
const configOf = (organizationId: SQL) =>
  sql`(select ${workspace.config} from ${workspace} where ${workspace.organizationId} = ${organizationId})`;
const workspaceOf = (organizationId: SQL) =>
  sql`coalesce((select jsonb_strip_nulls(jsonb_build_object('slug', ${workspace.slug}, 'name', ${workspace.name}))
    from ${workspace} where ${workspace.organizationId} = ${organizationId}), '{}'::jsonb)`;
const runnerOf = (row: SQL) =>
  sql`(select ${withSecret(sql`to_jsonb(r)`, sql`s.value`)} from ${runner} r join ${secret} s on s.id = r.secret_id
    where r.organization_id = ${row}.organization_id and r.public_id = ${row}.runner_id)`;
/** An app with its credentials, its own or the shared app's row. */
const appOf = (where: SQL) =>
  sql`(select jsonb_build_object('row', to_jsonb(a), 'credentials', s.value)
    from ${app} a join ${secret} s on s.id = a.credentials_secret_id where ${where})`;
/** CTEs deleting the secrets of the tasks `source` selects, with the rows that filed them. */
const dropTaskSecrets = (source: SQL) =>
  sql`task_secrets as (delete from ${taskSecret} where task_id in (${source}) returning secret_id),
    dropped_secrets as (delete from ${secret} where id in (select secret_id from task_secrets))`;

function addTokens(previous: SQL, value: unknown): SQL {
  if (typeof value === 'number')
    return sql`to_jsonb(coalesce(case when jsonb_typeof(${previous}) = 'number' then (${previous} #>> '{}')::numeric end, 0) + ${value}::numeric)`;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return previous;
  const fields = Object.entries(value).map(
    ([key, amount]) => sql`${key}::text, ${addTokens(sql`(${previous} -> ${key}::text)`, amount)}`,
  );

  return sql`(case when jsonb_typeof(${previous}) = 'object' then ${previous} else '{}'::jsonb end || jsonb_build_object(${sql.join(fields, sql`, `)}))`;
}

/** The runner time of an attempt that ends without the runner's completion. */
const runnerTime = (now: number) =>
  sql`case when ${task.status} in ('running', 'waiting') and ${task.startedAt} is not null
    then coalesce(${task.runnerMs}, 0) + greatest(0, ${now} - floor(extract(epoch from ${task.startedAt}) * 1000))::int
    else ${task.runnerMs} end`;

/** The fenced task locked as `prior`, with its attempt's ms not yet in `runner_ms`. */
const priorAttempt = (
  where: SQL | undefined,
  now: number,
  elapsed = sql`coalesce(${runnerTime(now)}, 0) - coalesce(${task.runnerMs}, 0)`,
) =>
  sql`prior as materialized (select id, organization_id, runner_kind, vcpus, ${elapsed} as elapsed from ${task} where ${where} for update)`;

/** Charges a charged attempt its elapsed ms times its `vcpus` to the workspace's `cpu:<kind>` meter. */
const chargeCpuUsage = (now: number, source = sql`finished`) => sql`charged as (
  insert into ${workspaceUsage} (organization_id, month, meter, amount)
  select prior.organization_id, ${new Date(now).toISOString().slice(0, 7)}, 'cpu:' || prior.runner_kind,
    prior.elapsed::bigint * prior.vcpus
  from prior join ${source} on ${source}.id = prior.id
  where prior.vcpus is not null and prior.elapsed > 0
  on conflict (organization_id, month, meter) do update
    set amount = ${workspaceUsage.amount} + excluded.amount
)`;

/** `listRank` as SQL. */
const rank = (status: SQLWrapper) =>
  sql<number>`(case ${status} ${sql.join(
    [...ACTIVE_STATES, ...TERMINAL_STATUSES].map(
      chatState => sql`when ${chatState} then ${sql.raw(String(listRank(chatState)))}`,
    ),
    sql` `,
  )} end)`;

/** A running task's heartbeat is rewritten at most this often, so callbacks rarely touch the wide row. */
const HEARTBEAT_MS = 15_000;

/** Milliseconds, as cursors carry them. */
const millis = (at: SQLWrapper) => sql`date_trunc('milliseconds', ${at})`;

/** Ids in byte order, as the server and CLI compare them, whatever the database collation. */
const bytes = (id: SQLWrapper) => sql`${id} collate "C"`;

/** `awaitsApproval` in SQL: the turn waits, or an escalation has no answer. */
const awaiting = or(
  eq(task.status, 'waiting'),
  sql`jsonb_path_exists(${task.context}, '$.approvals[*] ? (!(exists(@.response)) || @.response == null)')`,
)!;

/** `spaceAudience` in SQL, of a private space row. */
const spaceAudienceOf = sql<string>`'space:' || ${privateSpace.integration} || ':' || ${privateSpace.account} || ':' || ${privateSpace.space}`;

/** The private space audiences a member's linked platform identities are listed in, as one array the audience index serves. */
const memberAudiences = (organizationId: string, user: string) =>
  sql`array(select ${spaceAudienceOf} from ${privateSpace} join ${spaceMember} on ${spaceMember.spaceId} = ${privateSpace.id} join ${platformLink} on ${platformLink.platform} = ${privateSpace.integration} and ${platformLink.platformUserId} = ${spaceMember.member} where ${platformLink.userId} = ${user} and ${privateSpace.organizationId} = ${organizationId})`;

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
      fence.unanswered === undefined
        ? undefined
        : sql`not exists (select 1 from jsonb_array_elements(coalesce(${task.context} -> 'approvals', '[]'::jsonb)) as entry where entry ->> 'id' = ${fence.unanswered} and jsonb_typeof(entry -> 'response') = 'object')`,
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
    const { audience, space } = taskAudience(agentTask);
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
    }${secrets?.length ? sql`, ${taskSecretRows(secrets, sql`select id from inserted`)}` : sql``}`;
    return sql`
      with ${session ? sql`target as materialized (${session.target}),` : sql``} capacity as (
        select ${maxQueued === undefined ? sql`true` : sql`(select count(*) from ${task} where organization_id = ${organizationId} and status = 'queued') < ${maxQueued} ${delivery ? sql`or exists (select 1 from ${chatState} where key = ${key(delivery.key)} and expires_at > ${stamp}::timestamptz and value->>'owner' is distinct from ${delivery.owner ?? null}::text)` : sql``}`} ${session ? sql`or exists (select 1 from target) or not ${session.create}` : sql``} as allowed
      ), ${receipt} ${
        session
          ? sql`advanced as (
        update ${task} set inbox_seq = inbox_seq + 1, updated_at = ${stamp}::timestamptz where id in (select id from target) and exists (select 1 from receipt)
        returning id, inbox_seq, generation
      ), forwarded as (
        insert into ${taskInbox} (task_id, seq, generation, at, kind, value)
        select id, inbox_seq, generation, ${stamp}::timestamptz, 'steer', ${json({ text: session!.steer, asker: agentTask.context?.asker ?? null })} from advanced returning seq
      ),`
          : sql``
      } inserted as (
        insert into ${task} (organization_id, public_id, source, status, agent, flow, runner_kind, access,
          installation_id, event, audience, space, parent, connections, models, name, cwd, prompt, args, mcp, append_system, add_dirs, author, definition, requested_by,
          runner_id, vcpus, engine_settings, tools, context, files, failure_reply, notice, task_url, settings_url, attempts, created_at, updated_at)
        select ${organizationId}, ${agentTask.id}, ${agentTask.source}, 'queued', ${agentTask.agent}, ${agentTask.flow}, ${agentTask.runner}, ${agentTask.access ?? null},
          ${event ? sql`coalesce((select id from ${install} where key = ${`${event.appId}:${event.installationId}`} and organization_id = ${organizationId}), 0)` : sql`null`},
          ${json(event)}, ${audience}, ${space ?? null}, ${agentTask.parent ?? null}, ${json(agentTask.connections)}, ${json(agentTask.models)},
          ${agentTask.name ?? null}, ${agentTask.cwd ?? null}, ${agentTask.prompt ?? null}, ${json(agentTask.args)}, ${json(agentTask.mcp)},
          ${agentTask.appendSystem ?? null}, ${json(agentTask.addDirs)}, ${agentTask.author ?? null}, ${json(agentTask.definition)},
          ${agentTask.requestedBy ?? null}, ${agentTask.runnerId ?? null}, ${agentTask.vcpus ?? null}, ${json(agentTask.usage)}, ${json(agentTask.tools)},
          ${json(agentTask.context)}, ${json(agentTask.files)}, ${agentTask.failureReply ?? null}, ${agentTask.notice ?? null}, ${agentTask.taskUrl ?? null}, ${agentTask.settingsUrl ?? null},
          0, ${stamp}::timestamptz, ${stamp}::timestamptz
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

  async claim(
    _now: number,
    maxTasks?: number,
    knownWork = false,
    concurrentTasks?: (organizationId: string) => Promise<number | undefined>,
  ) {
    const free =
      maxTasks === undefined
        ? sql`true`
        : sql`(select count(*) from ${task} where status in ('running', 'waiting')) < ${maxTasks}`;
    const charged = (organizationId: SQLWrapper) =>
      sql`(select count(*) from ${task} active where active.organization_id = ${organizationId}
        and active.status in ('running', 'waiting') and active.vcpus is not null)`;
    let limits: Record<string, number | null> | undefined;
    if (concurrentTasks) {
      // Workspaces with charged tasks queued, with how many run, in the same read as readiness.
      const [found] = await readQuery(this.db, () =>
        rows<{ queued: Record<string, number> | null; own: boolean; free: boolean }>(
          this.db,
          sql`select (select jsonb_object_agg(organization_id, ${charged(sql`queued.organization_id`)})
            from (select distinct organization_id from ${task} where status = 'queued' and vcpus is not null) queued) as queued,
          exists (select 1 from ${task} where status = 'queued' and vcpus is null) as own, ${free} as free`,
        ),
      );
      const queued = Object.entries(found?.queued ?? {});
      const known = Object.fromEntries(
        await Promise.all(
          queued.map(async ([org]) => [org, (await concurrentTasks(org)) ?? null] as const),
        ),
      );
      const open = queued.some(([org, running]) => {
        const limit = known[org];
        return limit === null || running < limit!;
      });
      if (!knownWork && !(found?.free && (found.own || open))) return undefined;
      limits = known;
    }
    // Only charged tasks count and wait; a workspace missing from `limits` waits for the next claim, null is unlimited.
    const map = sql`${JSON.stringify(limits ?? {})}::jsonb`;
    const available = (claimed = sql`0`) =>
      limits === undefined
        ? sql`true`
        : sql`(${task.vcpus} is null or (${map} -> ${task.organizationId} is not null
          and ((${map} ->> ${task.organizationId}) is null
            or ${charged(task.organizationId)} + ${claimed} < (${map} ->> ${task.organizationId})::int)))`;
    if (!knownWork && !limits) {
      const [ready] = await readQuery(this.db, () =>
        rows<{ ready: boolean }>(
          this.db,
          sql`select exists (select 1 from ${task} where status = 'queued') and ${free} as ready`,
        ),
      );
      if (!ready?.ready) return undefined;
    }
    const nonce = randomBytes(32).toString('base64url');
    const bearer = sql`translate(rtrim(replace(encode(convert_to(format('{"task":%s,"organization":%s,"attempt":%s}',
      to_json(public_id), to_json(organization_id), attempts + 1), 'UTF8'), 'base64'), E'\\n', ''), '='), '+/', '-_') || '.' || ${nonce}`;
    const statement = sql`with stamp as materialized (select date_trunc('milliseconds', clock_timestamp()) as at), picked as materialized (
      select id, ${bearer} as bearer from ${task} where status = 'queued'
        and ${available()}
        ${maxTasks === undefined ? sql`` : sql`and (select count(*) from ${task} where status in ('running', 'waiting')) < ${maxTasks}`}
        order by created_at, id limit 1 for update
      ), claimed as (
        update ${task} set status = 'running', attempts = attempts + 1, logs_complete = null,
          started_at = (select at from stamp), updated_at = (select at from stamp), last_seen_at = (select at from stamp),
          token_hash = translate(rtrim(encode(sha256(convert_to(picked.bearer, 'UTF8')), 'base64'), '='), '+/', '-_')
        from picked where ${task.id} = picked.id returning ${task}.*
      ) select to_jsonb(claimed) as record, exists (select 1 from ${task} where status = 'queued' and id <> claimed.id
        and ${available(sql`case when ${task.organizationId} = claimed.organization_id and claimed.vcpus is not null then 1 else 0 end`)})
        and ${maxTasks === undefined ? sql`true` : sql`(select count(*) from ${task} where status in ('running', 'waiting')) + 1 < ${maxTasks}`} as more,
        ${credentialOf(sql`claimed`)} as credential, ${configOf(sql`claimed.organization_id`)} as config, ${runnerOf(sql`claimed`)} as runner
        from claimed`;
    const [claimed] = await pipeline<{
      record: Record<string, unknown>;
      more: boolean;
      credential: JsonRow | null;
      config: StoredConfig | null;
      runner: JsonRow | null;
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

  /** The task behind a runner's bearer, touched when its heartbeat is older than `HEARTBEAT_MS`; `include` loads what the callback needs in the same statement. */
  async authorize(
    id: string,
    tokenHash: string,
    attempts: number,
    organizationId: string,
    now: number,
    options: { allowCompleted?: boolean; include?: 'secrets' | 'context' } = {},
  ): Promise<CallbackState | undefined> {
    const at = new Date(now).toISOString();
    const fence = this.fence(organizationId, id, {
      tokenHash,
      attempts,
      statuses: options.allowCompleted
        ? ['running', 'waiting', 'completed', 'failed', 'cancelled']
        : ['running', 'waiting'],
    });
    // The row is rewritten only when its heartbeat is stale; otherwise it is read as it is.
    const stale = sql`${inArray(task.status, ['running', 'waiting'])} and (${task.lastSeenAt} is null or ${task.lastSeenAt} < ${new Date(now - HEARTBEAT_MS).toISOString()}::timestamptz)`;
    const touched = this.db
      .update(task)
      .set({ lastSeenAt: new Date(now) })
      .where(and(fence, stale))
      .returning();
    const unbeaten = this.db
      .select()
      .from(task)
      .where(and(fence, sql`not exists (select 1 from beaten)`));
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
      app: { row: JsonRow; credentials: string } | null;
      installation: Parameters<typeof sealedInstallation>[0] | null;
      credential: JsonRow | null;
      credentials: JsonRow[] | null;
      config: StoredConfig | null;
      workspace: { slug?: string; name?: string } | null;
      runner: JsonRow | null;
      secrets: { rows: string[] } | null;
      resolved: { key: string; value: { resolvedConnections: string; expiresAt?: number } } | null;
      tokens: Record<string, unknown> | null;
    }>(
      this.db,
      // Both sides list the schema's columns in one order: `task.*` follows the table's physical order, which migrations change.
      sql`with beaten as (${touched.getSQL()}), touched as (
        select * from beaten union all ${unbeaten.getSQL()}
      ), target as (
        select i.key, a.key as app from touched, ${install} i join ${app} a on a.id = i.app_id
        where i.key = touched.event->>'appId' || ':' || (touched.event->>'installationId') and i.organization_id = touched.organization_id and ${context}
      )
      select to_jsonb(touched) as status,
        case when ${context} then ${appOf(sql`a.key = touched.event->>'appId' and a.organization_id in (touched.organization_id, '')`)} end as app,
        case when ${secrets} then (select jsonb_build_object('row', to_jsonb(i), 'app', to_jsonb(a), 'credentials', cs.value, 'token', ts.value)
          from ${install} i join ${app} a on a.id = i.app_id join ${secret} cs on cs.id = a.credentials_secret_id left join ${secret} ts on ts.id = i.token_secret_id
          where i.key = touched.event->>'appId' || ':' || (touched.event->>'installationId') and i.organization_id = touched.organization_id and i.deleted_at is null) end as installation,
        case when ${secrets} then ${credentialOf(sql`touched`)} end as credential,
        case when ${secrets} then (select coalesce(jsonb_agg(${withSecret(sql`to_jsonb(c)`, sql`s.value`)}), '[]'::jsonb)
          from ${engineCredential} c join ${secret} s on s.id = c.secret_id where c.organization_id = touched.organization_id
          and (c.owner is null or c.owner = touched.requested_by)) end as credentials,
        case when ${secrets} then ${configOf(org)} end as config,
        case when ${context} then ${workspaceOf(org)} end as workspace,
        case when ${context} then ${runnerOf(sql`touched`)} end as runner,
        case when ${secrets} then jsonb_build_object('rows', coalesce((select jsonb_agg(s.value) from ${taskSecret} ts join ${secret} s on s.id = ts.secret_id
          where ts.task_id = touched.id and starts_with(ts.key, 'connection-secrets:' || touched.public_id || ':') and ts.expires_at > ${at}::timestamptz), '[]'::jsonb)) end as secrets,
        case when ${context} then (select jsonb_build_object('key', ts.key, 'value', jsonb_build_object('resolvedConnections', s.value, 'expiresAt', (extract(epoch from ts.expires_at) * 1000)::bigint))
          from ${taskSecret} ts join ${secret} s on s.id = ts.secret_id where ts.task_id = touched.id
          and starts_with(ts.key, 'connections:' || touched.public_id || ':' || touched.generation || ':' || touched.attempts || ':') and ts.expires_at > ${at}::timestamptz limit 1) end as resolved,
        case when ${context} then (select coalesce(jsonb_object_agg(${t.key}, ${t.value}), '{}'::jsonb) from ${t} where ${liveState} and (
          ${t.key} like any (select ${pattern(snapshot(sql`'token:' || key || ':'`))} || '%' from target)
          or ${t.key} in (select ${snapshot(sql`'token-drop:' || key`)} from target union all select ${snapshot(sql`'token-drop:' || app`)} from target))) end as tokens
      from touched`,
    );
    if (!row) return undefined;
    const record = fromJson(task, row.status);
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
              secrets: row.secrets ?? undefined,
              config: row.config ?? undefined,
              ...(context
                ? {
                    app: value(row.app, found =>
                      appValue(fromJson(app, found.row), found.credentials),
                    ),
                    workspace: row.workspace ?? undefined,
                    runner: value(row.runner, found => sealedRunner(found).value),
                    resolved: value(row.resolved, found => ({
                      id: found.key,
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
      resolvedModel,
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
          ...(Object.hasOwn(patch, 'logsComplete')
            ? { logsComplete: logsComplete ?? null }
            : Object.hasOwn(patch, 'handle')
              ? {
                  logsComplete: sql`case when ${task.handle} is distinct from ${patch.handle ?? null}::text then null else ${task.logsComplete} end`,
                }
              : {}),
          ...(answer === undefined
            ? {}
            : {
                answer: sql`coalesce(${task.answer}, '[]'::jsonb) || ${JSON.stringify([answer])}::jsonb`,
              }),
          ...(resolvedModel
            ? {
                engineSettings: sql`coalesce(${task.engineSettings}, '{}'::jsonb) || ${JSON.stringify({ resolvedModel })}::jsonb`,
              }
            : {}),
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

  async setRequestedBy(
    organizationId: string,
    id: string,
    requestedBy: string,
    now: number,
  ): Promise<boolean> {
    const [row] = await this.db
      .update(task)
      .set({
        requestedBy,
        audience: sql`case when ${task.audience} = 'dm:' then ${`dm:${requestedBy}`} else ${task.audience} end`,
        updatedAt: new Date(now),
      })
      .where(and(this.where(organizationId, id), isNull(task.requestedBy)))
      .returning({ id: task.id });
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
    const statement = this.db
      .update(task)
      .set({
        status: 'queued',
        handle: null,
        tokenHash: null,
        lastSeenAt: null,
        logsComplete: null,
        runnerMs: runnerTime(now),
        updatedAt: new Date(now),
      })
      .where(sql`${task.id} in (select id from prior)`)
      .returning({ id: task.id });
    const [row] = await rows<{ id: number }>(
      this.db,
      sql`
      with ${priorAttempt(this.fence(organizationId, id, { ...fence, statuses: ['running', 'waiting'] }), now)},
        finished as (${statement.getSQL()}), ${chargeCpuUsage(now)}
      select id from finished
    `,
    );

    return Boolean(row);
  }

  private connectionLock(organizationId: string, id: string): SQL {
    return sql`select pg_advisory_xact_lock(3, hashtext(${`app:${organizationId}:connections:${id}`}))`;
  }

  async deleteTask(
    organizationId: string,
    id: string,
    fence: TaskFence,
    now = Date.now(),
  ): Promise<boolean> {
    const [row] = await pipeline<{ deleted: number }>(
      this.db,
      [this.connectionLock(organizationId, id)],
      sql`
      with ${priorAttempt(this.fence(organizationId, id, fence), now)}, gone as (
        delete from ${task} where ${task.id} in (select id from prior)
        returning id, organization_id, public_id, audience, requested_by, parent
      ), ${chargeCpuUsage(now, sql`gone`)}, marked as (
        insert into ${taskTombstone} (organization_id, public_id, audience, requested_by, parent, deleted_at)
        select organization_id, public_id, audience, requested_by, parent, clock_timestamp() from gone
      ), ${dropTaskSecrets(sql`select id from gone`)}
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
        runnerMs: runnerTime(now),
        lastSeenAt: at,
        finishedAt: at,
        updatedAt: at,
      })
      .where(sql`${task.id} in (select id from prior)`)
      .returning({ id: task.id });
    const [row] = await pipeline<{ id: number }>(
      this.db,
      [this.connectionLock(organizationId, id)],
      sql`
      with ${priorAttempt(this.fence(organizationId, id, { ...fence, statuses: ['queued', 'running', 'waiting'] }), now)},
        finished as (${statement.getSQL()}), ${chargeCpuUsage(now)}, ${dropTaskSecrets(sql`select id from finished`)}
      select id from finished`,
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
    const [row] = await this.db.transaction(async tx => {
      const [known] = await tx
        .select({ context: task.context })
        .from(task)
        .where(this.where(organizationId, id))
        .for('update');
      // Answers recorded since the continuation read the task are newer than its copy.
      const context = next.context && {
        ...next.context,
        approvals: mergeApprovals(next.context.approvals ?? [], known?.context?.approvals ?? []),
      };
      return tx
        .update(task)
        .set({
          prompt: next.prompt ?? null,
          context: context ?? null,
          ...(next.event ? { event: next.event } : {}),
          ...(next.definition ? { definition: next.definition } : {}),
          ...(next.usage ? { engineSettings: next.usage } : {}),
          ...(next.tools ? { tools: next.tools } : {}),
          ...('files' in next ? { files: next.files ?? null } : {}),
          ...('access' in next ? { access: next.access ?? null } : {}),
          ...(next.models ? { models: next.models } : {}),
          ...(next.runner ? { runnerKind: next.runner } : {}),
          ...('runnerId' in next
            ? { runnerId: next.runnerId ?? null, vcpus: next.vcpus ?? null }
            : {}),
          ...('failureReply' in next ? { failureReply: next.failureReply ?? null } : {}),
          ...('notice' in next ? { notice: next.notice ?? null } : {}),
          status: 'queued',
          attempts: 0,
          generation: sql`${task.generation} + 1`,
          inboxAck: -1,
          typingEnded: null,
          result: null,
          error: null,
          tokens: null,
          handle: null,
          tokenHash: null,
          lastSeenAt: null,
          logCursor: null,
          logsComplete: null,
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
        .returning({ id: task.id });
    });
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
    const context = completion.logsComplete ? sql`, logs_complete = true` : sql``;
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
    with ${priorAttempt(this.fence(organizationId, id, { attempts: completion.attempts, tokenHash: completion.tokenHash, statuses: ['running', 'waiting'] }), now, sql`${record.runnerElapsedMs}::bigint`)}, finished as (
      update ${task} set status = ${outcome.status}, result = ${JSON.stringify(outcome.result ?? null)}::jsonb,
        error = ${outcome.error ?? null}, tokens = ${JSON.stringify(outcome.tokens ?? null)}::jsonb,
        engine = ${record.engine ?? null}, model = ${record.model ?? null}, credential = ${record.credential ?? null}, runner_ms = coalesce(runner_ms, 0) + ${record.runnerElapsedMs},
        token_count = coalesce(token_count, 0) + ${countTokens(record.tokens)}, usage_tokens = ${addTokens(sql`usage_tokens`, record.tokens)},
        last_seen_at = ${at}::timestamptz, finished_at = ${at}::timestamptz, updated_at = ${at}::timestamptz${context}
      where ${task.id} in (select id from prior)
      returning id, generation
    ), ${chargeCpuUsage(now)}, ${dropTaskSecrets(sql`select id from finished`)}, inbox as (delete from ${taskInbox} where (task_id, generation) in (select id, generation from finished))${known}
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
    ), ${dropTaskSecrets(sql`select id from cancelled where status = 'cancelled'`)}, message as (
      insert into ${taskInbox} (task_id, seq, generation, kind, value, at)
      select id, inbox_seq, generation, 'cancel', 'null'::jsonb, ${at}::timestamptz from cancelled where status in ('running', 'waiting')
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
      opts.parent ? eq(task.parent, opts.parent) : undefined,
      opts.runnerId ? eq(task.runnerId, opts.runnerId) : undefined,
      opts.archived === undefined
        ? undefined
        : opts.archived
          ? isNotNull(task.archivedAt)
          : isNull(task.archivedAt),
      opts.viewer === undefined
        ? undefined
        : or(
            eq(task.audience, ''),
            eq(task.requestedBy, opts.viewer.id),
            opts.viewer.spaces
              ? opts.viewer.spaces.length
                ? inArray(task.audience, opts.viewer.spaces)
                : undefined
              : sql`${task.audience} = any(${memberAudiences(organizationId, opts.viewer.id)})`,
          ),
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
          access: task.access,
          requestedBy: task.requestedBy,
          event:
            sql`case when ${task.event} is not null then jsonb_strip_nulls(jsonb_build_object('integration', ${task.event}->>'integration', 'type', ${task.event}->>'type', 'text', ${task.event}->>'text', 'actor', ${task.event}->'actor')) end`.as(
              'event',
            ),
          // Who asked, the open approvals the queue answers, and the first turn's prompt that titles the task.
          context:
            sql`jsonb_strip_nulls(jsonb_build_object('user', ${task.context}->'user', 'approvals', ${task.context}->'approvals', 'turns', case when ${task.context}->'turns'->0 is not null then jsonb_build_array(jsonb_build_object('prompt', ${task.context}->'turns'->0->'prompt')) end))`.as(
              'context',
            ),
          // The engine, model and effort the list shows, from what ran or else the agent's model spec, and the model its turn recorded.
          usage:
            sql`jsonb_strip_nulls(case when coalesce(${task.engineSettings}->>'engine', ${task.engineSettings}->>'model') is not null then jsonb_build_object('engine', ${task.engineSettings}->>'engine', 'model', ${task.engineSettings}->>'model', 'effort', ${task.engineSettings}->>'effort') else jsonb_build_object('model', ${task.definition}->>'model') end || jsonb_build_object('resolvedModel', ${task.engineSettings}->>'resolvedModel'))`.as(
              'usage',
            ),
          status: task.status,
          attempts: task.attempts,
          approval: task.approval,
          archivedAt: task.archivedAt,
          createdAt: task.createdAt,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          lastSeenAt: task.lastSeenAt,
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
        access: row.access,
        requestedBy: row.requestedBy,
        event: row.event,
        context: Object.keys((row.context as object | null) ?? {}).length ? row.context : undefined,
        usage: Object.keys((row.usage as object | null) ?? {}).length ? row.usage : undefined,
      }),
      status: row.status,
      attempts: row.attempts,
      approval: row.approval,
      archivedAt: row.archivedAt ? ms(row.archivedAt as Date) : undefined,
      createdAt: ms(row.createdAt as Date),
      startedAt: row.startedAt ? ms(row.startedAt as Date) : undefined,
      finishedAt: row.finishedAt ? ms(row.finishedAt as Date) : undefined,
      lastSeenAt: row.lastSeenAt ? ms(row.lastSeenAt as Date) : undefined,
      updatedAt: ms(row.updatedAt as Date),
    }) as TaskStatus;
  }

  async list(organizationId: string, opts: TaskListOptions = {}): Promise<TaskStatus[]> {
    const records = await readQuery(this.db, () => this.pageQuery(organizationId, opts));
    return records.map(row => this.record(row, opts.summary));
  }

  async memberSpaces(organizationId: string, user: string, audiences: string[]): Promise<string[]> {
    if (!audiences.length) return [];
    const rows = await readQuery(this.db, () =>
      this.db
        .selectDistinct({ audience: spaceAudienceOf })
        .from(privateSpace)
        .innerJoin(spaceMember, eq(spaceMember.spaceId, privateSpace.id))
        .innerJoin(
          platformLink,
          and(
            eq(platformLink.platform, privateSpace.integration),
            eq(platformLink.platformUserId, spaceMember.member),
          ),
        )
        .where(
          and(
            eq(privateSpace.organizationId, organizationId),
            eq(platformLink.userId, user),
            inArray(spaceAudienceOf, audiences),
          ),
        ),
    );

    return rows.map(row => row.audience);
  }

  async listedSpaces(organizationId: string, event: SpaceEvent): Promise<SpaceEvent[]> {
    const rows = await readQuery(this.db, () =>
      this.db
        .select({
          integration: privateSpace.integration,
          appId: privateSpace.app,
          installationId: privateSpace.installation,
          account: privateSpace.account,
          kind: privateSpace.kind,
          id: privateSpace.space,
        })
        .from(privateSpace)
        .where(
          and(
            eq(privateSpace.organizationId, organizationId),
            eq(privateSpace.integration, event.integration),
            eq(privateSpace.account, event.account ?? event.installationId),
            sql`exists (select 1 from ${task} where ${task.organizationId} = ${privateSpace.organizationId} and ${task.audience} = ${spaceAudienceOf})`,
          ),
        ),
    );

    return rows.map(({ account, kind, id, ...listed }) => ({
      ...listed,
      ...(account === listed.installationId ? {} : { account }),
      space: { kind, id },
    }));
  }

  async linkedMembers(organizationId: string, platform: string): Promise<LinkedMember[]> {
    const rows = await readQuery(this.db, () =>
      this.db
        .select({ id: platformLink.platformUserId, login: platformLink.login })
        .from(platformLink)
        .where(
          and(
            eq(platformLink.platform, platform),
            sql`${platformLink.organizations} @> ${JSON.stringify([organizationId])}::jsonb`,
          ),
        ),
    );

    return rows.map(row => defined(row));
  }

  async spaceSynced(organizationId: string, event: SpaceEvent): Promise<number | undefined> {
    const [row] = await readQuery(this.db, () =>
      this.db
        .select({ syncedAt: privateSpace.syncedAt })
        .from(privateSpace)
        .where(this.space(organizationId, event)),
    );

    return row?.syncedAt ? ms(row.syncedAt) : undefined;
  }

  async claimSpace(
    organizationId: string,
    event: SpaceEvent,
    now: number,
    force = false,
  ): Promise<boolean> {
    const at = new Date(now).toISOString();
    const [row] = await rows<{ id: number }>(
      this.db,
      sql`insert into ${privateSpace} (organization_id, integration, app, installation, account, kind, space, claimed_at)
        values (${organizationId}, ${event.integration}, ${event.appId}, ${event.installationId}, ${event.account ?? event.installationId}, ${event.space?.kind ?? 'channel'}, ${event.space?.id ?? ''}, ${at}::timestamptz)
        on conflict (organization_id, integration, account, space) do update set claimed_at = excluded.claimed_at
          where ${force} or ${privateSpace.claimedAt} is null or ${privateSpace.claimedAt} < ${new Date(now - MEMBERS_CLAIM_MS).toISOString()}::timestamptz
        returning id`,
    );

    return Boolean(row);
  }

  async saveSpaceMembers(
    organizationId: string,
    event: SpaceEvent,
    members: string[] | undefined,
    now: number,
  ): Promise<void> {
    // Only the claim this fetch took: a membership change since then voids it.
    const claimed = and(
      this.space(organizationId, event),
      eq(privateSpace.claimedAt, new Date(now)),
    );
    if (!members) {
      await this.db.update(privateSpace).set({ claimedAt: null }).where(claimed);
      return;
    }
    await pipeline(
      this.db,
      [],
      sql`
      with saved as (
        update ${privateSpace} set synced_at = ${new Date(now).toISOString()}::timestamptz, claimed_at = null
        where ${claimed} returning id
      ), gone as (
        delete from ${spaceMember} where space_id = (select id from saved) and member <> all(${sql.param(members)}::text[])
      )
      insert into ${spaceMember} (space_id, member)
      select saved.id, member from saved, unnest(${sql.param(members)}::text[]) as member
      on conflict do nothing`,
    );
  }

  async spaceChanged(
    organizationId: string,
    event: SpaceEvent,
    change: { joined?: string; left?: string; private?: boolean },
    now: number,
  ): Promise<void> {
    const found = sql`select id from ${privateSpace} where ${this.space(organizationId, event)}`;
    if (change.joined || change.left)
      await this.db
        .update(privateSpace)
        .set({ claimedAt: null })
        .where(this.space(organizationId, event));
    if (change.joined)
      await this.db.execute(
        sql`insert into ${spaceMember} (space_id, member) select id, ${change.joined} from (${found}) as saved on conflict do nothing`,
      );
    if (change.left)
      await this.db.execute(
        sql`delete from ${spaceMember} where space_id in (${found}) and member = ${change.left}`,
      );
    if (change.private === undefined) return;
    const flag = sql`to_jsonb(${change.private}::boolean)`;
    // Open streams hear the change through the bumped `updated_at`.
    await this.db
      .update(task)
      .set({
        audience: change.private ? spaceAudience(event) : '',
        event: sql`case when ${task.event}->'space' is not null then jsonb_set(${task.event}, '{space,private}', ${flag}) else ${task.event} end`,
        updatedAt: new Date(now),
      })
      .where(
        and(
          eq(task.organizationId, organizationId),
          eq(task.space, spaceKey(event)),
          sql`${task.audience} not like 'dm:%'`,
        ),
      );
    // A public space needs no list; a private one is fetched again on its next event.
    await this.db.delete(privateSpace).where(this.space(organizationId, event));
  }

  private space(organizationId: string, event: SpaceEvent) {
    return and(
      eq(privateSpace.organizationId, organizationId),
      eq(privateSpace.integration, event.integration),
      eq(privateSpace.account, event.account ?? event.installationId),
      eq(privateSpace.space, event.space?.id ?? ''),
    );
  }

  async changes(
    scopes: Array<{ organizationId: string; ids: string[]; fresh: string[] }>,
    since: number,
  ) {
    if (!scopes.length) return { rows: [], deleted: [] };
    const organizationIds = scopes.map(scope => scope.organizationId);
    // Two array parameters however many tasks are asked.
    const named = (key: 'ids' | 'fresh') => {
      const organizations = scopes.flatMap(scope => scope[key].map(() => scope.organizationId));
      const ids = scopes.flatMap(scope => scope[key]);
      return ids.length
        ? sql`(${task.organizationId}, ${task.publicId}) in (select * from unnest(${sql.param(organizations)}::text[], ${sql.param(ids)}::text[]))`
        : undefined;
    };
    const asked = named('ids') ?? sql`false`;
    const fresh = named('fresh');
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
            requestedBy: task.requestedBy,
            audience: task.audience,
            parent: task.parent,
            status: task.status,
            approval: task.approval,
            approvals: sql<unknown>`case when ${asked} then ${task.context}->'approvals' end`,
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
              fresh,
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
        task: defined({
          id: row.publicId,
          source: row.source,
          agent: row.agent,
          flow: row.flow,
          requestedBy: row.requestedBy,
          audience: row.audience,
          parent: row.parent,
        }),
        status: row.status,
        approval: row.approval,
        approvals: Array.isArray(row.approvals) ? row.approvals : undefined,
        answer: Array.isArray(row.answer) ? row.answer : undefined,
        result: row.result,
        error: row.error,
        attempts: row.attempts,
        archivedAt: row.archivedAt && ms(row.archivedAt),
        createdAt: ms(row.createdAt),
        startedAt: row.startedAt && ms(row.startedAt),
        finishedAt: row.finishedAt && ms(row.finishedAt),
        updatedAt: ms(row.updatedAt),
      }) as unknown as TaskStatus,
    }));

    return {
      rows,
      deleted: tombstones.map(row => ({
        organizationId: row.organizationId,
        id: row.publicId,
        at: ms(row.deletedAt),
        ...(row.audience === null ? {} : { audience: row.audience }),
        ...(row.requestedBy === null ? {} : { requestedBy: row.requestedBy }),
        ...(row.parent === null ? {} : { parent: row.parent }),
      })),
    };
  }

  async logTails(
    tails: Array<{ organizationId: string; id: string; after: number }>,
    limit: number,
  ): Promise<Array<LogTail | undefined>> {
    if (!tails.length) return [];
    const seq = sql`(line->>'seq')::int`;
    // Three array parameters however many streams are open.
    const found = await readQuery(this.db, () =>
      rows<{
        n: number;
        status: TaskStatus['status'];
        approval: TaskStatus['approval'] | null;
        audience: string | null;
        requested_by: string | null;
        lines: TaskLogLine[];
      }>(
        this.db,
        sql`select tail.n::int as n, ${task.status} as status, ${task.approval} as approval,
          ${task.audience} as audience, ${task.requestedBy} as requested_by,
          (select coalesce(jsonb_agg(line order by ${seq}), '[]'::jsonb) from (
            select line from ${taskLog} cross join jsonb_array_elements(${taskLog.lines}) line
            where ${taskLog.taskId} = ${task.id} and ${taskLog.seqTo} > tail.after and ${seq} > tail.after
            order by ${seq} limit ${limit}) page) as lines
        from unnest(${sql.param(tails.map(tail => tail.organizationId))}::text[], ${sql.param(tails.map(tail => tail.id))}::text[], ${sql.param(tails.map(tail => tail.after))}::int[])
          with ordinality as tail(organization_id, public_id, after, n)
        join ${task} on ${task.organizationId} = tail.organization_id and ${task.publicId} = tail.public_id`,
      ),
    );
    const byIndex = new Map(found.map(row => [row.n - 1, row]));

    return tails.map((tail, index) => {
      const row = byIndex.get(index);
      return (
        row && {
          status: defined({
            status: row.status,
            approval: row.approval,
            task: defined({ id: tail.id, audience: row.audience, requestedBy: row.requested_by }),
          }),
          lines: row.lines.map(line => {
            const entry = logEntry(line.line);
            return entry ? { ...line, entry } : line;
          }),
        }
      );
    });
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

  async activeCounts(organizationId: string): Promise<AudienceCount[]> {
    const rows = await readQuery(this.db, () =>
      this.db
        .select({
          audience: task.audience,
          requestedBy: task.requestedBy,
          active: sql<number>`count(*)::int`,
        })
        .from(task)
        .where(
          and(
            eq(task.organizationId, organizationId),
            inArray(task.status, ACTIVE_STATES),
            isNull(task.archivedAt),
          ),
        )
        .groupBy(task.audience, task.requestedBy),
    );

    return rows.map(row => defined(row));
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

  async running(): Promise<Array<{ organizationId: string; status: RunningTask }>> {
    const rows = await readQuery(this.db, () =>
      this.db
        .select({
          organizationId: task.organizationId,
          publicId: task.publicId,
          runner: task.runnerKind,
          runnerId: task.runnerId,
          vcpus: task.vcpus,
          status: task.status,
          attempts: task.attempts,
          generation: task.generation,
          handle: task.handle,
          tokenHash: task.tokenHash,
          lastSeenAt: task.lastSeenAt,
          logsComplete: task.logsComplete,
          startedAt: task.startedAt,
          cancelRequestedAt: task.cancelRequestedAt,
          updatedAt: task.updatedAt,
        })
        .from(task)
        .where(inArray(task.status, ['running', 'waiting'])),
    );
    return rows.map(({ organizationId, publicId, runner: kind, runnerId, vcpus, ...row }) => ({
      organizationId,
      status: defined({
        ...row,
        task: defined({
          id: publicId,
          runner: kind as RunningTask['task']['runner'],
          runnerId,
          vcpus,
        }),
        lastSeenAt: row.lastSeenAt && ms(row.lastSeenAt),
        startedAt: row.startedAt && ms(row.startedAt),
        cancelRequestedAt: row.cancelRequestedAt && ms(row.cancelRequestedAt),
        updatedAt: ms(row.updatedAt),
      }) as RunningTask,
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
      insert into ${taskLog} (task_id, seq_from, seq_to, lines)
      select accepted.id, ${lines[0]!.seq}, ${lines[lines.length - 1]!.seq}, ${JSON.stringify(lines)}::jsonb from accepted
      on conflict (task_id, seq_from) do update set seq_to = excluded.seq_to, lines = excluded.lines
    )`
      : sql``;
    const [row] = await rows<{ accepted: boolean }>(
      this.db,
      sql`
      with accepted as (
        update ${task} set log_cursor = ${progress.cursor}, log_seq = ${progress.seq}, log_bytes = ${progress.bytes}
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
        insert into ${taskInbox} (task_id, seq, generation, kind, value, at)
        select id, inbox_seq, generation, ${kind}, ${JSON.stringify(admissions ? { ...(value as object), admissions } : (value ?? null))}::jsonb, ${new Date(now).toISOString()}::timestamptz from next returning seq
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
    const now = Date.now();
    const at = new Date(now).toISOString();
    const [row] = await pipeline<{ accepted: boolean; status: TaskStatus['status'] | null }>(
      this.db,
      [this.connectionLock(organizationId, id)],
      sql`
    with ${priorAttempt(
      sql`${this.fence(organizationId, id, { ...fence, generation: ack.generation, statuses: undefined })}
        and inbox_seq >= ${ack.seq} and (status in ('running', 'waiting') or (status in ('completed', 'failed', 'cancelled') and inbox_ack >= ${ack.seq}))`,
      now,
    )}, applied as (
      delete from ${taskInbox} where task_id in (select id from prior) and generation = ${ack.generation} and seq <= ${ack.seq} returning seq, kind, value
    ), answers as (
      select jsonb_agg(a.value order by a.seq) as value from jsonb_to_recordset(${JSON.stringify(ack.answers ?? [])}::jsonb) a(seq int, value jsonb)
      where exists (select 1 from applied where applied.seq = a.seq and applied.kind = 'ask')
    ), updated as (
      update ${task} set inbox_ack = greatest(inbox_ack, ${ack.seq}), answer = coalesce(answer, '[]'::jsonb) || coalesce(answers.value, '[]'::jsonb),
        status = case when exists(select 1 from applied where kind = 'cancel') then 'cancelled'
          when exists(select 1 from applied where kind = 'approve' and value->>'approvalId' = ${task.approval}->>'id') then 'running' else status end,
        approval = case when exists(select 1 from applied where kind = 'approve' and value->>'approvalId' = ${task.approval}->>'id') then null else approval end,
        runner_ms = case when exists(select 1 from applied where kind = 'cancel') then ${runnerTime(now)} else runner_ms end,
        finished_at = case when exists(select 1 from applied where kind = 'cancel') then ${at}::timestamptz else finished_at end,
        error = case when exists(select 1 from applied where kind = 'cancel') then ${STOPPED_BY_USER} else error end,
        updated_at = ${at}::timestamptz
      from answers where id in (select id from prior) returning id, status
    ), finished as (
      select id from updated where status = 'cancelled' and exists(select 1 from applied where kind = 'cancel')
    ), ${chargeCpuUsage(now)}, ${dropTaskSecrets(sql`select id from updated where status = 'cancelled'`)}
    select exists (select 1 from prior) as accepted, (select status from updated) as status`,
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
