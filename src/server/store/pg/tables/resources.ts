/** Workspace-level kinds: `config`, `login`, `runner` and `snapshot`. */
import { and, asc, eq, gt, sql } from 'drizzle-orm';

import type { RunnerRecord, StoreRecords } from '../../types';
import { chatState, runner, secret } from '../schema';
import type { DrizzleStore } from '../store';
import {
  addSecret,
  date,
  defined,
  escapeLike,
  ms,
  opaque,
  setSecret,
  statePrefix,
  type Kind,
} from './shared';

export function state<K extends 'delivery' | 'note' | 'login' | 'snapshot' | 'config'>(
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
    },
    delete: async id => {
      await s.db.delete(t).where(eq(t.key, prefix + (kind === 'config' ? 'workspace' : id)));
    },
  };
}

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
      return rows.map(({ row: r, sealed }) => ({
        id: r.publicId,
        value: defined({
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
        }),
      }));
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
