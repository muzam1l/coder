/** Workspace-level kinds: `config`, `connection`, `login`, `runner`, `snapshot` and the `delivery` rows, with approval posts and a task's secrets in their own tables. */
import { and, asc, eq, gt, like, sql, type SQL } from 'drizzle-orm';

import type { Connection } from '../../../../agent/types';
import type { RunnerRecord, StoreRecords } from '../../types';
import {
  approvalPost,
  chatState,
  connection,
  engineCredential,
  runner,
  secret,
  task,
  taskSecret,
  workspace,
} from '../schema';
import type { DrizzleStore } from '../store';
import { credentialId } from '../../../settings/credentials';
import type { ApprovalPost } from '../../../tasks/approvals';
import { dropKey, heldKey, type HeldToken, type TokenDrop, type TokenState } from '../../types';
import { appValue, credentialValue, installationValue } from './apps';
import {
  addSecret,
  app,
  date,
  defined,
  dropSecrets,
  escapeLike,
  fromJson,
  install,
  ms,
  setSecret,
  statePrefix,
  stateKey,
  type Kind,
} from './shared';

/** A row as `to_jsonb` renders it, with its secret row's value under `secret` (see `withSecret`). */
export type JsonRow = Record<string, unknown>;
const sealed = (row: JsonRow) => row.secret as string;
export const sealedCredential = (row: JsonRow) => {
  const r = fromJson(engineCredential, row);
  return {
    id: credentialId(r.owner ?? undefined, r.label),
    value: credentialValue(r, sealed(row)),
  };
};
export const sealedRunner = (row: JsonRow) => {
  const r = fromJson(runner, row);
  return { id: r.publicId, value: runnerValue(r, sealed(row)) };
};
/** An installation with its token, its app and the app's credentials. */
export const sealedInstallation = (value: {
  row: JsonRow;
  app: JsonRow;
  credentials: string;
  token: string | null;
}) => {
  const owner = fromJson(app, value.app);
  return {
    installation: installationValue(fromJson(install, value.row), owner, value.token),
    app: appValue(owner, value.credentials),
  };
};

/** Live `token:` rows under these installations and the drops of these ids, as one JSON object by key. */
export function heldTokensQuery(
  organizationId: string,
  installations: string[],
  apps: string[],
  moreDrops?: SQL,
) {
  const t = chatState;
  const prefixes = installations.map(
    id => `${escapeLike(stateKey(organizationId, 'snapshot', heldKey(id)))}%`,
  );
  const drops = [...installations, ...apps].map(id =>
    stateKey(organizationId, 'snapshot', dropKey(id)),
  );

  return sql`(select coalesce(jsonb_object_agg(${t.key}, ${t.value}), '{}'::jsonb) from ${t}
    where (${t.expiresAt} is null or ${t.expiresAt} > clock_timestamp()) and (${t.key} like any(${sql.param(prefixes)}::text[])
      or ${t.key} in (select unnest(${sql.param(drops)}::text[])${moreDrops ? sql` union all ${moreDrops}` : sql``})))`;
}

export function tokenState(organizationId: string, found: Record<string, unknown>): TokenState {
  const prefix = statePrefix(organizationId, 'snapshot');
  const state: TokenState = { held: new Map(), drops: new Map() };
  for (const [key, value] of Object.entries(found)) {
    const id = key.slice(prefix.length);
    if (id.startsWith('token-drop:')) state.drops.set(id, (value as TokenDrop).drop);
    else state.held.set(id, value as HeldToken);
  }

  return state;
}

/** The unseen record with everything through `through` acknowledged and dropped. */
export function unseenAcknowledged(through: number): SQL {
  const version = sql`coalesce((${chatState.value}->>'version')::bigint, jsonb_array_length(${chatState.value}->'messages') + (${chatState.value}->>'more')::bigint)`;
  const acknowledged = sql`greatest(coalesce((${chatState.value}->>'acknowledged')::bigint, 0), least(${through}, ${version}))`;

  return sql`(select ${chatState.value} || jsonb_build_object('version', ${version}, 'acknowledged', ${acknowledged},
        'messages', remaining, 'more', ${version} - ${acknowledged} - jsonb_array_length(remaining))
        from (select coalesce(jsonb_agg(item order by n) filter (where coalesce((item->>'sequence')::bigint, n) > ${acknowledged}), '[]'::jsonb) as remaining
          from jsonb_array_elements(${chatState.value}->'messages') with ordinality e(item,n)) as pending)`;
}

export function stateRows<K extends 'delivery' | 'login' | 'snapshot'>(
  s: DrizzleStore,
  kind: K,
): Kind<StoreRecords[K]> {
  const t = chatState;
  const prefix = statePrefix(s.organizationId, kind);
  const key = t.key;

  return {
    key,
    where: opts =>
      and(
        opts.id === undefined
          ? sql`${t.key} like ${`${escapeLike(prefix + (opts.prefix ?? ''))}%`}`
          : eq(t.key, prefix + opts.id),
        opts.after === undefined ? undefined : gt(t.key, prefix + opts.after),
      )!,
    rows: async (where, limit) => {
      const q = s.db
        .select({ id: key, value: sql<StoreRecords[K]>`${t.value}` })
        .from(t)
        .where(and(sql`${t.key} like ${`${escapeLike(prefix)}%`}`, s.live(t.expiresAt), where))
        .orderBy(asc(t.key));

      return (await (limit === undefined ? q : q.limit(limit))).map(row => ({
        id: row.id.slice(prefix.length),
        value: row.value,
      }));
    },
    put: async (id, value, expiresAt) => {
      const expiry = kind === 'login' ? (expiresAt ?? s.at()) : expiresAt;
      await s.db
        .insert(t)
        .values({ key: prefix + id, value, expiresAt: expiry })
        .onConflictDoUpdate({
          target: t.key,
          set: { value, expiresAt: kind === 'login' && !expiresAt ? sql`${t.expiresAt}` : expiry },
        });
    },
    delete: async id => {
      await s.db.delete(t).where(eq(t.key, prefix + id));
    },
  };
}

/** The `delivery` kind's `approval:` rows, in `approval_post` with their due times as columns; the store routes them here. */
export function approvalPosts(s: DrizzleStore): Kind<ApprovalPost> {
  const t = approvalPost;
  const optional = (value: number | undefined) => (value === undefined ? null : date(value));
  return {
    key: t.key,
    where: opts =>
      and(
        opts.id === undefined
          ? like(t.key, `${escapeLike(opts.prefix ?? '')}%`)
          : eq(t.key, opts.id),
        opts.after === undefined ? undefined : gt(t.key, opts.after),
      )!,
    rows: async (where, limit) => {
      const q = s.db
        .select({ id: t.key, value: t.value })
        .from(t)
        .where(and(s.mine(t.organizationId), s.live(t.expiresAt), where))
        .orderBy(asc(t.key));

      return await (limit === undefined ? q : q.limit(limit));
    },
    put: async (id, value, expiresAt) => {
      const row = {
        value,
        at: date(value.at),
        shownAt: value.shownAt ? date(value.shownAt) : null,
        retryAt: optional(value.retryAt),
        expiresAt,
      };
      await s.db
        .insert(t)
        .values({ organizationId: s.organizationId, key: id, ...row })
        .onConflictDoUpdate({ target: [t.organizationId, t.key], set: row });
    },
    delete: async id => {
      await s.db.delete(t).where(and(s.mine(t.organizationId), eq(t.key, id)));
    },
  };
}

/** The `config` kind: one row per workspace, under the id `workspace`. */
export function configs(s: DrizzleStore): Kind<StoreRecords['config']> {
  const t = workspace;
  return {
    key: t.organizationId,
    where: () => sql`${t.config} is not null`,
    rows: async () => {
      const [row] = await s.db
        .select({ value: t.config })
        .from(t)
        .where(and(s.mine(t.organizationId), sql`${t.config} is not null`));
      return row ? [{ id: 'workspace', value: row.value! }] : [];
    },
    put: async (_id, value) => {
      await s.db
        .insert(t)
        .values({ organizationId: s.organizationId, config: value })
        .onConflictDoUpdate({ target: t.organizationId, set: { config: value } });
    },
    delete: async () => {
      await s.db.update(t).set({ config: null }).where(s.mine(t.organizationId));
    },
  };
}

const connectionValue = (
  record: Omit<Connection, 'secret'>,
  sealed: string | null,
): Connection => (sealed === null ? record : { ...record, secret: sealed });

/** The lock `withAppLock('connection:<id>')` takes, so a put inside it nests. */
export const connectionLock = (s: DrizzleStore, id: string) =>
  `app:${s.organizationId}:connection:${id}`;

export function connections(s: DrizzleStore): Kind<Connection> {
  const t = connection;
  return {
    key: t.key,
    rows: async (where, limit) => {
      const q = s.db
        .select({ id: t.key, record: t.record, sealed: secret.value })
        .from(t)
        .leftJoin(secret, eq(secret.id, t.secretId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.key));
      const rows = await (limit === undefined ? q : q.limit(limit));

      return rows.map(row => ({ id: row.id, value: connectionValue(row.record, row.sealed) }));
    },
    put: (id, value) =>
      s.transaction(connectionLock(s, id), async s => {
        const { secret: sealed, ...record } = value;
        const [existing] = await s.db
          .select({ secretId: t.secretId, sealed: secret.value })
          .from(t)
          .leftJoin(secret, eq(secret.id, t.secretId))
          .where(and(s.mine(t.organizationId), eq(t.key, id)));
        let secretId = existing?.secretId ?? null;
        if (sealed) {
          if (secretId) {
            if (existing!.sealed !== sealed) await setSecret(s.db, secretId, sealed);
          } else secretId = await addSecret(s.db, sealed);
        }
        const row = { owner: value.owner ?? null, record, secretId: sealed ? secretId : null };
        await s.db
          .insert(t)
          .values({ organizationId: s.organizationId, key: id, ...row })
          .onConflictDoUpdate({ target: [t.organizationId, t.key], set: row });
        if (!sealed) await dropSecrets(s.db, [existing?.secretId]);
      }),
    delete: id =>
      s.transaction(connectionLock(s, id), async s => {
        const gone = await s.db
          .delete(t)
          .where(and(s.mine(t.organizationId), eq(t.key, id)))
          .returning({ secretId: t.secretId });
        await dropSecrets(
          s.db,
          gone.map(row => row.secretId),
        );
      }),
  };
}

const runnerValue = (r: typeof runner.$inferSelect, sealed: string): RunnerRecord =>
  defined({
    name: r.name,
    owner: r.owner,
    kind: r.kind,
    scope: r.owner ? 'personal' : 'workspace',
    config: r.config,
    createdBy: r.createdBy,
    default: r.isDefault,
    lastSeen: r.lastSeen ? ms(r.lastSeen) : undefined,
    secret: sealed,
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  }) as RunnerRecord;

export function runners(s: DrizzleStore): Kind<RunnerRecord> {
  const t = runner;
  return {
    key: t.publicId,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, sealed: secret.value })
        .from(t)
        .innerJoin(secret, eq(secret.id, t.secretId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.publicId));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row, sealed }) => ({ id: row.publicId, value: runnerValue(row, sealed) }));
    },
    put: (id, value) =>
      s.transaction(`app:runners:${s.organizationId}`, async s => {
        const [existing] = await s.db
          .select({ secretId: t.secretId, sealed: secret.value })
          .from(t)
          .innerJoin(secret, eq(secret.id, t.secretId))
          .where(and(s.mine(t.organizationId), eq(t.publicId, id)));
        if (existing && existing.sealed !== value.secret)
          await setSecret(s.db, existing.secretId, value.secret);
        const row = {
          owner: value.owner ?? null,
          name: value.name,
          kind: value.kind,
          config: value.config,
          createdBy: value.createdBy ?? null,
          isDefault: value.default,
          lastSeen: value.lastSeen === undefined ? null : date(value.lastSeen),
          updatedAt: date(value.updatedAt),
        };
        await s.db
          .insert(t)
          .values({
            organizationId: s.organizationId,
            publicId: id,
            secretId: existing?.secretId ?? (await addSecret(s.db, value.secret)),
            createdAt: date(value.createdAt),
            ...row,
          })
          .onConflictDoUpdate({ target: [t.organizationId, t.publicId], set: row });
      }),
    delete: id =>
      s.transaction(`app:runners:${s.organizationId}`, async s => {
        const gone = await s.db
          .delete(t)
          .where(and(s.mine(t.organizationId), eq(t.publicId, id)))
          .returning({ secretId: t.secretId });
        await dropSecrets(
          s.db,
          gone.map(row => row.secretId),
        );
      }),
  };
}

/** The task a `connection-secrets:<task>:<hash>` or `connections:<task>:<generation>:<attempt>:<id>` row belongs to. */
const taskSecretOwner = (id: string) => id.split(':')[1] ?? '';
export const isTaskSecret = (id: string) => /^connection(s|-secrets):/.test(id);

const taskSecretValue = (
  id: string,
  sealed: string,
  expiresAt: Date | null,
): StoreRecords['snapshot'] =>
  defined(
    id.startsWith('connections:')
      ? { resolvedConnections: sealed, expiresAt: expiresAt && ms(expiresAt) }
      : { secret: sealed, expiresAt: expiresAt && ms(expiresAt) },
  );

/** The `snapshot` kind's task secret rows, in `task_secret` under the task's row; the store routes them here. */
export function taskSecrets(s: DrizzleStore): Kind<StoreRecords['snapshot']> {
  const t = taskSecret;
  const owner = (id: string) =>
    and(s.mine(task.organizationId), eq(task.publicId, taskSecretOwner(id)));
  return {
    key: t.key,
    rows: async (where, limit) => {
      const q = s.db
        .select({ id: t.key, sealed: secret.value, expiresAt: t.expiresAt })
        .from(t)
        .innerJoin(task, eq(task.id, t.taskId))
        .innerJoin(secret, eq(secret.id, t.secretId))
        .where(and(s.mine(task.organizationId), s.live(t.expiresAt), where))
        .orderBy(asc(t.key));
      const rows = await (limit === undefined ? q : q.limit(limit));

      return rows.map(row => ({
        id: row.id,
        value: taskSecretValue(row.id, row.sealed, row.expiresAt),
      }));
    },
    put: (id, value, expiresAt) =>
      s.transaction(`app:${s.organizationId}:connections:${taskSecretOwner(id)}`, async s => {
        const sealed =
          'secret' in value
            ? value.secret
            : 'resolvedConnections' in value
              ? value.resolvedConnections
              : undefined;
        const expiry =
          expiresAt ?? ('expiresAt' in value && value.expiresAt ? date(value.expiresAt) : null);
        if (sealed === undefined) throw new Error(`Not a task secret: ${id}`);
        const [found] = await s.db
          .select({ taskId: task.id, secretId: t.secretId })
          .from(task)
          .leftJoin(t, and(eq(t.taskId, task.id), eq(t.key, id)))
          .where(owner(id));
        if (!found) return;
        if (found.secretId) {
          await setSecret(s.db, found.secretId, sealed);
          await s.db.update(t).set({ expiresAt: expiry }).where(eq(t.secretId, found.secretId));
          return;
        }
        await s.db.insert(t).values({
          taskId: found.taskId,
          key: id,
          secretId: await addSecret(s.db, sealed),
          expiresAt: expiry,
        });
      }),
    delete: id =>
      s.transaction(`app:${s.organizationId}:connections:${taskSecretOwner(id)}`, async s => {
        const gone = await s.db
          .delete(t)
          .where(
            and(
              eq(t.key, id),
              sql`${t.taskId} in (select ${task.id} from ${task} where ${owner(id)})`,
            ),
          )
          .returning({ secretId: t.secretId });
        await dropSecrets(
          s.db,
          gone.map(row => row.secretId),
        );
      }),
  };
}
