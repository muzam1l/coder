/** The `app`, `installation` and `credential` kinds, whose secrets live sealed in the `secret` table. */
import { and, asc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';

import type { AgentApp, Installation } from '../../../../agent/types';
import { InstallationBoundError } from '../../types';
import {
  credentialId,
  parseCredentialId,
  type StoredCredential,
} from '../../../settings/credentials';
import { engineCredential, secret } from '../schema';
import type { DrizzleStore } from '../store';
import {
  addSecret,
  app,
  date,
  defined,
  install,
  ms,
  opaque,
  setSecret,
  UNSCOPED_ORGANIZATION,
  type Kind,
} from './shared';

/** An app row with its sealed credentials, as the store returns it. */
export const appValue = (
  r: typeof app.$inferSelect,
  sealed: typeof secret.$inferSelect,
): AgentApp =>
  defined({
    id: r.key,
    integration: r.integration,
    agent: r.agent,
    name: r.name,
    agentsRepo: r.agentsRepo,
    branch: r.branch,
    builtin: r.organizationId === UNSCOPED_ORGANIZATION || undefined,
    credentials: opaque(sealed),
    createdAt: ms(r.createdAt),
  });

export function apps(s: DrizzleStore): Kind<AgentApp> {
  const t = app;
  return {
    key: t.key,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, sealed: secret })
        .from(t)
        .innerJoin(secret, eq(secret.id, t.credentialsSecretId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.key));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row: r, sealed }) => ({ id: r.key, value: appValue(r, sealed) }));
    },
    put: (id, value) =>
      s.transaction(`app:${id}`, async s => {
        const [existing] = await s.db
          .select({ secretId: t.credentialsSecretId, sealed: secret })
          .from(t)
          .innerJoin(secret, eq(secret.id, t.credentialsSecretId))
          .where(and(s.mine(t.organizationId), eq(t.key, id)));
        // An app on a shared app's credentials points at that app's secret.
        const [shared] = value.shared
          ? await s.db
              .select({ secretId: t.credentialsSecretId })
              .from(t)
              .where(and(eq(t.organizationId, UNSCOPED_ORGANIZATION), eq(t.key, value.shared)))
          : [];
        if (value.shared && !shared) throw new Error(`No shared app ${value.shared}`);
        const credentialsSecretId =
          existing?.secretId ?? shared?.secretId ?? (await addSecret(s, 'app', value.credentials));
        if (existing && !value.shared && opaque(existing.sealed) !== value.credentials)
          await setSecret(s, credentialsSecretId, value.credentials);
        const row = {
          integration: value.integration,
          platformAppId: id.slice(id.indexOf(':') + 1),
          agent: value.agent,
          name: value.name,
          agentsRepo: value.agentsRepo ?? null,
          branch: value.branch ?? null,
          credentialsSecretId,
          createdAt: date(value.createdAt),
          updatedAt: s.at(),
        };
        await s.db
          .insert(t)
          .values({ organizationId: s.organizationId, key: id, ...row })
          .onConflictDoUpdate({ target: [t.organizationId, t.key], set: row });
      }),
    delete: id =>
      s.transaction(`app:${id}`, async s => {
        const [existing] = await s.db
          .delete(t)
          .where(and(s.mine(t.organizationId), eq(t.key, id)))
          .returning({ secretId: t.credentialsSecretId });
        if (existing)
          await s.db
            .delete(secret)
            .where(and(eq(secret.id, existing.secretId), s.mine(secret.organizationId)));
      }),
  };
}

export function installationValue(
  r: typeof install.$inferSelect,
  a: Pick<typeof app.$inferSelect, 'key' | 'integration'>,
  sealed: typeof secret.$inferSelect | null,
): Installation {
  return defined({
    id: r.key,
    app: a.key,
    integration: a.integration,
    account: r.account,
    token: sealed ? opaque(sealed) : undefined,
    installer: r.installer,
    self: r.self,
    covers: r.covers,
    repos: r.repos,
    connections: r.connections,
    settings: r.settings,
    createdAt: ms(r.createdAt),
    deletedAt: r.deletedAt ? ms(r.deletedAt) : undefined,
  });
}

/** Refuse an installation whose account, or an account it covers, another live installation on the same platform client holds, in any workspace. */
export function checkBinding(s: DrizzleStore, id: string, value: Installation): Promise<void> {
  const client = value.app.split('/')[0]!;
  const accounts = [id.slice(value.app.length + 1), ...(value.covers ?? [])];
  const list = sql`array[${sql.join(
    accounts.map(account => sql`${account}`),
    sql`, `,
  )}]::text[]`;

  return s.transaction(`binding:${client}`, async s => {
    const [bound] = await s.db
      .select({ id: install.id })
      .from(install)
      .innerJoin(app, eq(app.id, install.appId))
      .where(
        and(
          or(inArray(install.platformInstallId, accounts), sql`${install.covers} ?| ${list}`),
          isNull(install.deletedAt),
          ne(install.key, id),
          or(eq(app.key, client), sql`left(${app.key}, ${client.length + 1}) = ${`${client}/`}`),
        ),
      )
      .limit(1);
    if (bound)
      throw new InstallationBoundError(`Installation "${id}" is bound through another app.`);
  });
}

export function installations(s: DrizzleStore): Kind<Installation> {
  const t = install;
  return {
    key: t.key,
    rows: async (where, limit) => {
      const q = s.db
        .select({
          row: t,
          app: { key: app.key, integration: app.integration },
          sealed: secret,
        })
        .from(t)
        .innerJoin(app, eq(app.id, t.appId))
        .leftJoin(secret, eq(secret.id, t.tokenSecretId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.key));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row: r, app: a, sealed }) => ({
        id: r.key,
        value: installationValue(r, a, sealed),
      }));
    },
    put: (id, value) =>
      s.transaction(`installation:${id}`, async s => {
        const [found] = await s.db
          .select({
            row: t,
            sealed: secret,
            appKey: app.key,
            parent: sql<
              number | null
            >`(select id from ${app} where organization_id in (${s.organizationId}, ${UNSCOPED_ORGANIZATION}) and key = ${value.app} order by organization_id desc limit 1)`,
          })
          .from(sql`(select 1) as anchor`)
          .leftJoin(t, eq(t.key, id))
          .leftJoin(app, eq(app.id, t.appId))
          .leftJoin(secret, eq(secret.id, t.tokenSecretId));
        const existing = found?.row
          ? {
              secretId: found.row.tokenSecretId,
              organizationId: found.row.organizationId,
              covers: found.row.covers,
              deletedAt: found.row.deletedAt,
              appKey: found.appKey,
              sealed: found.sealed,
            }
          : undefined;
        const taken = () => new Error(`Installation "${id}" belongs to another workspace.`);
        if (existing && existing.organizationId !== s.organizationId) throw taken();
        if (!found?.parent) throw new Error(`Unknown app "${value.app}".`);
        if (
          value.deletedAt === undefined &&
          (!existing ||
            existing.appKey !== value.app ||
            existing.deletedAt !== null ||
            JSON.stringify(existing.covers ?? []) !== JSON.stringify(value.covers ?? []))
        )
          await checkBinding(s, id, value);
        let tokenSecretId = existing?.secretId ?? null;
        if (value.token) {
          if (tokenSecretId) {
            if (!existing?.sealed || opaque(existing.sealed) !== value.token)
              await setSecret(s, tokenSecretId, value.token);
          } else tokenSecretId = await addSecret(s, 'installation', value.token);
        }
        const row = {
          appId: found.parent,
          platformInstallId: id.slice(value.app.length + 1),
          account: value.account,
          tokenSecretId: value.token ? tokenSecretId : null,
          installer: value.installer ?? null,
          self: value.self ?? null,
          covers: value.covers ?? null,
          repos: value.repos ?? null,
          connections: value.connections ?? null,
          settings: value.settings ?? null,
          createdAt: date(value.createdAt),
          updatedAt: s.at(),
          deletedAt: value.deletedAt === undefined ? null : date(value.deletedAt),
        };
        const [bound] = await s.db
          .insert(t)
          .values({ organizationId: s.organizationId, key: id, ...row })
          .onConflictDoUpdate({
            target: t.key,
            set: row,
            setWhere: s.mine(t.organizationId),
          })
          .returning({ id: t.id });
        if (!bound) throw taken();
        if (!value.token && existing?.secretId)
          await s.db.delete(secret).where(eq(secret.id, existing.secretId));
      }),
    delete: id =>
      s.transaction(`installation:${id}`, async s => {
        const [existing] = await s.db
          .delete(t)
          .where(and(s.mine(t.organizationId), eq(t.key, id)))
          .returning({ secretId: t.tokenSecretId });
        if (existing?.secretId) await s.db.delete(secret).where(eq(secret.id, existing.secretId));
      }),
  };
}

/** One installation row, locked for the transaction. */
export async function lockInstallation(
  s: DrizzleStore,
  id: string,
): Promise<Installation | undefined> {
  // `for update of` needs an unqualified name, so the schema-qualified table is aliased.
  const t = alias(install, 'locked');
  const [row] = await s.db
    .select({ row: t, app: { key: app.key, integration: app.integration }, sealed: secret })
    .from(t)
    .innerJoin(app, eq(app.id, t.appId))
    .leftJoin(secret, eq(secret.id, t.tokenSecretId))
    .where(and(s.mine(t.organizationId), eq(t.key, id)))
    .for('update', { of: t });
  return row && installationValue(row.row, row.app, row.sealed);
}

export const credentialValue = (
  r: typeof engineCredential.$inferSelect,
  sealed: typeof secret.$inferSelect,
): StoredCredential =>
  defined({
    iv: sealed.iv,
    tag: sealed.tag,
    ciphertext: sealed.ciphertext,
    owner: r.owner,
    account: r.account,
    createdAt: ms(r.createdAt),
  });

/** The advisory lock of one owner's credential namespace in this organization. */
export const credentialLock = (s: DrizzleStore, owner: string | undefined) =>
  `credential:${JSON.stringify([s.organizationId, owner ?? null])}`;

export type LockedCredential = {
  id: string;
  value: StoredCredential;
  row: typeof engineCredential.$inferSelect;
  sealed: typeof secret.$inferSelect;
};

/** One owner's credential rows, locked for the transaction. */
export async function lockCredentials(
  s: DrizzleStore,
  owner: string | undefined,
): Promise<LockedCredential[]> {
  const t = engineCredential;
  const rows = await s.db
    .select({ row: t, sealed: secret })
    .from(t)
    .innerJoin(secret, eq(secret.id, t.secretId))
    .where(and(s.mine(t.organizationId), owner ? eq(t.owner, owner) : isNull(t.owner)))
    .orderBy(asc(t.label))
    .for('update');
  return rows.map(({ row, sealed }) => ({
    id: credentialId(row.owner ?? undefined, row.label),
    value: credentialValue(row, sealed),
    row,
    sealed,
  }));
}

/** Insert, update or delete one credential row from its locked state, without rereading. */
export async function writeCredential(
  s: DrizzleStore,
  locked: LockedCredential | undefined,
  id: string,
  value: StoredCredential | null,
): Promise<void> {
  const t = engineCredential;
  if (!value) {
    if (!locked) return;
    await s.db.delete(t).where(eq(t.id, locked.row.id));
    await s.db.delete(secret).where(eq(secret.id, locked.row.secretId));
    return;
  }
  const sealed = opaque(value);
  const fields = {
    account: value.account ?? null,
    createdAt:
      value.createdAt === undefined ? (locked?.row.createdAt ?? s.at()) : date(value.createdAt),
    updatedAt: s.at(),
  };
  if (locked) {
    if (opaque(locked.sealed) !== sealed) await setSecret(s, locked.row.secretId, sealed);
    await s.db.update(t).set(fields).where(eq(t.id, locked.row.id));
    return;
  }
  const { owner, name } = parseCredentialId(id);
  await s.db.insert(t).values({
    organizationId: s.organizationId,
    owner: owner ?? null,
    label: name,
    secretId: await addSecret(s, 'engine', sealed),
    ...fields,
  });
}

export function credentials(s: DrizzleStore): Kind<StoredCredential> {
  const t = engineCredential;
  const write = (id: string, value: StoredCredential | null) => {
    const { owner } = parseCredentialId(id);
    return s.transaction(credentialLock(s, owner), async s =>
      writeCredential(
        s,
        (await lockCredentials(s, owner)).find(row => row.id === id),
        id,
        value,
      ),
    );
  };
  return {
    key: sql`coalesce(${t.owner} || '/', '') || ${t.label}`,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, sealed: secret })
        .from(t)
        .innerJoin(secret, eq(secret.id, t.secretId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(sql`coalesce(${t.owner} || '/', '') || ${t.label}`));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row, sealed }) => ({
        id: credentialId(row.owner ?? undefined, row.label),
        value: credentialValue(row, sealed),
      }));
    },
    put: (id, value) => write(id, value),
    delete: id => write(id, null),
  };
}
