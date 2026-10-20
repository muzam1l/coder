/** Workspace-level kinds: `config`, `login`, `runner` and `snapshot`. */
import { and, asc, eq, gt, sql, type SQL } from 'drizzle-orm';

import type { RunnerRecord, StoreRecords } from '../../types';
import { chatState, engineCredential, runner, secret } from '../schema';
import type { DrizzleStore } from '../store';
import { credentialId } from '../../../settings/credentials';
import { dropKey, heldKey, type HeldToken, type TokenDrop, type TokenState } from '../../tokens';
import { appValue, credentialValue, installationValue } from './apps';
import {
  addSecret,
  app,
  date,
  defined,
  escapeLike,
  fromJson,
  install,
  ms,
  opaque,
  setSecret,
  statePrefix,
  stateKey,
  type Kind,
} from './shared';

/** A row with its sealed secret, as `to_jsonb` renders them. */
export type Sealed = { row: Record<string, unknown>; sealed: Record<string, unknown> };
export const sealedRow = (row: SQL, sealed: SQL) =>
  sql`jsonb_build_object('row', to_jsonb(${row}), 'sealed', to_jsonb(${sealed}))`;
export const sealedCredential = (value: Sealed) => {
  const r = fromJson(engineCredential, value.row);
  return {
    id: credentialId(r.owner ?? undefined, r.label),
    value: credentialValue(r, fromJson(secret, value.sealed)),
  };
};
export const sealedRunner = (value: Sealed) => {
  const r = fromJson(runner, value.row);
  return { id: r.publicId, value: runnerValue(r, fromJson(secret, value.sealed)) };
};
/** An installation with its app and both secrets; the installation's own token may be unset. */
export const sealedInstallation = (
  value: Sealed & { app: Record<string, unknown>; credentials: Record<string, unknown> },
) => {
  const owner = fromJson(app, value.app);
  return {
    installation: installationValue(
      fromJson(install, value.row),
      owner,
      value.sealed ? fromJson(secret, value.sealed) : null,
    ),
    app: appValue(owner, fromJson(secret, value.credentials)),
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

export function state<K extends 'delivery' | 'login' | 'snapshot' | 'config' | 'connection'>(
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
      const query = s.db
        .insert(t)
        .values({
          key: prefix + (kind === 'config' ? 'workspace' : id),
          value,
          expiresAt: kind === 'config' ? null : expiry,
        })
        .onConflictDoUpdate({
          target: t.key,
          set: {
            value,
            expiresAt:
              kind === 'config'
                ? null
                : kind === 'login' && !expiresAt
                  ? sql`${t.expiresAt}`
                  : expiry,
          },
        });
      const notification =
        kind === 'delivery' && id.startsWith('connection-authorized:')
          ? s.notification(kind, id)
          : undefined;
      await (notification ? query.returning(notification) : query);
    },
    delete: async id => {
      await s.db.delete(t).where(eq(t.key, prefix + (kind === 'config' ? 'workspace' : id)));
    },
  };
}

export const runnerValue = (
  r: typeof runner.$inferSelect,
  sealed: typeof secret.$inferSelect,
): RunnerRecord =>
  defined({
    name: r.name,
    owner: r.owner,
    kind: r.kind,
    scope: r.scope,
    config: r.config,
    createdBy: r.createdBy,
    default: r.isDefault,
    lastSeen: r.lastSeen ? ms(r.lastSeen) : undefined,
    secret: opaque(sealed),
    createdAt: ms(r.createdAt),
    updatedAt: ms(r.updatedAt),
  }) as RunnerRecord;

export function runners(s: DrizzleStore): Kind<RunnerRecord> {
  const t = runner;
  const which = (id: string) => and(s.mine(t.organizationId), eq(t.publicId, id));
  return {
    key: t.publicId,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, sealed: secret })
        .from(t)
        .innerJoin(secret, eq(secret.id, t.secretId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.publicId));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row: r, sealed }) => ({ id: r.publicId, value: runnerValue(r, sealed) }));
    },
    put: (id, value) =>
      s.transaction(`runner:${s.organizationId}:${id}`, async s => {
        const [existing] = await s.db
          .select({ id: t.id, secretId: t.secretId, sealed: secret })
          .from(t)
          .innerJoin(secret, eq(secret.id, t.secretId))
          .where(which(id));
        const row = {
          owner: value.owner ?? null,
          name: value.name,
          kind: value.kind,
          scope: value.scope,
          config: value.config,
          createdBy: value.createdBy ?? null,
          isDefault: value.default,
          lastSeen: value.lastSeen === undefined ? null : date(value.lastSeen),
          updatedAt: date(value.updatedAt),
        };
        if (existing) {
          if (opaque(existing.sealed) !== value.secret)
            await setSecret(s, existing.secretId, value.secret);
          await s.db.update(t).set(row).where(eq(t.id, existing.id));
          return;
        }
        await s.db.insert(t).values({
          organizationId: s.organizationId,
          publicId: id,
          secretId: await addSecret(s, 'runner', value.secret),
          createdAt: date(value.createdAt),
          ...row,
        });
      }),
    delete: id =>
      s.transaction(`runner:${s.organizationId}:${id}`, async s => {
        const [existing] = await s.db
          .delete(t)
          .where(which(id))
          .returning({ secretId: t.secretId });
        if (existing) await s.db.delete(secret).where(eq(secret.id, existing.secretId));
      }),
  };
}

/** A task's secret rows, its resolved connections and a secrets row in the old single-row layout. */
export function connectionSnapshots(organizationId: string, taskId: string) {
  const key = stateKey(organizationId, 'snapshot', `connection-secrets:${taskId}`);
  const like = (prefix: string) =>
    sql`${chatState.key} like ${`${escapeLike(stateKey(organizationId, 'snapshot', prefix))}%`}`;

  return sql`(${chatState.key} = ${key} or ${like(`connection-secrets:${taskId}:`)} or ${like(`connections:${taskId}:`)})`;
}
