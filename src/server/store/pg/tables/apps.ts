/** The `app`, `installation` and `credential` kinds, each row pointing at its `secret` row. */
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
  dropSecrets,
  install,
  ms,
  opaque,
  sealedParts,
  setSecret,
  UNSCOPED_ORGANIZATION,
  type Kind,
} from './shared';

/** The shared app an app row runs on, for its key. */
export const shared = alias(app, 'shared_app');
/** An installation's token row, beside its app's credentials row. */
export const installationSecret = alias(secret, 'installation_secret');

/** An app row with its credentials, as the store returns it. */
export const appValue = (
  r: typeof app.$inferSelect,
  credentials: string,
  sharedKey?: string | null,
): AgentApp =>
  defined({
    id: r.key,
    integration: r.integration,
    agent: r.agent,
    name: r.name,
    agentsRepo: r.agentsRepo,
    branch: r.branch,
    botId: r.botId,
    builtin: r.organizationId === UNSCOPED_ORGANIZATION || undefined,
    shared: sharedKey,
    credentials,
    createdAt: ms(r.createdAt),
  });

export function apps(s: DrizzleStore): Kind<AgentApp> {
  const t = app;
  return {
    key: t.key,
    rows: async (where, limit) => {
      const q = s.db
        .select({ row: t, credentials: secret.value, sharedKey: shared.key })
        .from(t)
        .innerJoin(secret, eq(secret.id, t.credentialsSecretId))
        .leftJoin(shared, eq(shared.id, t.sharedAppId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.key));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row: r, credentials, sharedKey }) => ({
        id: r.key,
        value: appValue(r, credentials, sharedKey),
      }));
    },
    put: (id, value) =>
      s.transaction(`app:${id}`, async s => {
        const [existing] = await s.db
          .select({
            secretId: t.credentialsSecretId,
            sharedAppId: t.sharedAppId,
            credentials: secret.value,
          })
          .from(t)
          .innerJoin(secret, eq(secret.id, t.credentialsSecretId))
          .where(and(s.mine(t.organizationId), eq(t.key, id)));
        const [sharedApp] = value.shared
          ? await s.db
              .select({ id: t.id, secretId: t.credentialsSecretId })
              .from(t)
              .where(and(eq(t.organizationId, UNSCOPED_ORGANIZATION), eq(t.key, value.shared)))
          : [];
        if (value.shared && !sharedApp) throw new Error(`No shared app ${value.shared}`);
        // An app on a shared app's credentials points at that app's secret row.
        const own = existing && !existing.sharedAppId ? existing.secretId : undefined;
        const credentialsSecretId =
          sharedApp?.secretId ?? own ?? (await addSecret(s.db, value.credentials));
        if (own !== undefined && existing?.credentials !== value.credentials)
          await setSecret(s.db, own, value.credentials);
        const row = {
          integration: value.integration,
          agent: value.agent,
          name: value.name,
          agentsRepo: value.agentsRepo ?? null,
          branch: value.branch ?? null,
          botId: value.botId ?? null,
          credentialsSecretId,
          sharedAppId: sharedApp?.id ?? null,
          createdAt: date(value.createdAt),
          updatedAt: s.at(),
        };
        await s.db
          .insert(t)
          .values({ organizationId: s.organizationId, key: id, ...row })
          .onConflictDoUpdate({ target: [t.organizationId, t.key], set: row });
        if (existing && existing.secretId !== credentialsSecretId)
          await dropSecrets(s.db, [existing.secretId]);
      }),
    delete: id =>
      s.transaction(`app:${id}`, async s => {
        const gone = await s.db
          .delete(t)
          .where(and(s.mine(t.organizationId), eq(t.key, id)))
          .returning({ secretId: t.credentialsSecretId });
        await dropSecrets(
          s.db,
          gone.map(row => row.secretId),
        );
      }),
  };
}

export function installationValue(
  r: typeof install.$inferSelect,
  a: Pick<typeof app.$inferSelect, 'key' | 'integration'>,
  token: string | null,
): Installation {
  return defined({
    id: r.key,
    app: a.key,
    integration: a.integration,
    account: r.account,
    token,
    installer: r.installer,
    self: r.self,
    covers: r.covers,
    repos: r.repos,
    createdAt: ms(r.createdAt),
    deletedAt: r.deletedAt ? ms(r.deletedAt) : undefined,
    uninstalled: r.uninstalled || undefined,
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
          token: secret.value,
        })
        .from(t)
        .innerJoin(app, eq(app.id, t.appId))
        .leftJoin(secret, eq(secret.id, t.tokenSecretId))
        .where(and(s.mine(t.organizationId), where))
        .orderBy(asc(t.key));
      const rows = await (limit === undefined ? q : q.limit(limit));
      return rows.map(({ row: r, app: a, token }) => ({
        id: r.key,
        value: installationValue(r, a, token),
      }));
    },
    put: (id, value) =>
      s.transaction(`installation:${id}`, async s => {
        const [found] = await s.db
          .select({
            row: t,
            token: secret.value,
            appKey: app.key,
            parent: sql<
              number | null
            >`(select id from ${app} where organization_id in (${s.organizationId}, ${UNSCOPED_ORGANIZATION}) and key = ${value.app} order by organization_id desc limit 1)`,
          })
          .from(sql`(select 1) as anchor`)
          .leftJoin(t, eq(t.key, id))
          .leftJoin(app, eq(app.id, t.appId))
          .leftJoin(secret, eq(secret.id, t.tokenSecretId));
        const existing = found?.row;
        const taken = () => new Error(`Installation "${id}" belongs to another workspace.`);
        if (existing && existing.organizationId !== s.organizationId) throw taken();
        if (!found?.parent) throw new Error(`Unknown app "${value.app}".`);
        if (
          value.deletedAt === undefined &&
          (!existing ||
            found.appKey !== value.app ||
            existing.deletedAt !== null ||
            JSON.stringify(existing.covers ?? []) !== JSON.stringify(value.covers ?? []))
        )
          await checkBinding(s, id, value);
        let tokenSecretId = existing?.tokenSecretId ?? null;
        if (value.token) {
          if (tokenSecretId) {
            if (found.token !== value.token) await setSecret(s.db, tokenSecretId, value.token);
          } else tokenSecretId = await addSecret(s.db, value.token);
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
          createdAt: date(value.createdAt),
          updatedAt: s.at(),
          deletedAt: value.deletedAt === undefined ? null : date(value.deletedAt),
          uninstalled: value.uninstalled ?? null,
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
        if (!value.token) await dropSecrets(s.db, [existing?.tokenSecretId]);
      }),
    delete: id =>
      s.transaction(`installation:${id}`, async s => {
        const gone = await s.db
          .delete(t)
          .where(and(s.mine(t.organizationId), eq(t.key, id)))
          .returning({ secretId: t.tokenSecretId });
        await dropSecrets(
          s.db,
          gone.map(row => row.secretId),
        );
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
    .select({ row: t, app: { key: app.key, integration: app.integration }, token: secret.value })
    .from(t)
    .innerJoin(app, eq(app.id, t.appId))
    .leftJoin(secret, eq(secret.id, t.tokenSecretId))
    .where(and(s.mine(t.organizationId), eq(t.key, id)))
    .for('update', { of: t });
  return row && installationValue(row.row, row.app, row.token);
}

export const credentialValue = (
  r: typeof engineCredential.$inferSelect,
  sealed: string,
): StoredCredential =>
  defined({
    ...sealedParts(sealed),
    owner: r.owner,
    account: r.account,
    createdAt: ms(r.createdAt),
  });

/** The advisory lock of one owner's credential namespace in this organization. */
export const credentialLock = (s: DrizzleStore, owner: string | undefined) =>
  `credential:${JSON.stringify([s.organizationId, owner ?? null])}`;

type LockedCredential = {
  id: string;
  value: StoredCredential;
  row: typeof engineCredential.$inferSelect;
};

/** One owner's credential rows, locked for the transaction. */
export async function lockCredentials(
  s: DrizzleStore,
  owner: string | undefined,
): Promise<LockedCredential[]> {
  const t = engineCredential;
  const rows = await s.db
    .select({ row: t, sealed: secret.value })
    .from(t)
    .innerJoin(secret, eq(secret.id, t.secretId))
    .where(and(s.mine(t.organizationId), owner ? eq(t.owner, owner) : isNull(t.owner)))
    .orderBy(asc(t.label))
    .for('update');
  return rows.map(({ row, sealed }) => ({
    id: credentialId(row.owner ?? undefined, row.label),
    value: credentialValue(row, sealed),
    row,
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
    if (locked) {
      await s.db.delete(t).where(eq(t.id, locked.row.id));
      await dropSecrets(s.db, [locked.row.secretId]);
    }
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
    if (opaque(locked.value) !== sealed) await setSecret(s.db, locked.row.secretId, sealed);
    await s.db.update(t).set(fields).where(eq(t.id, locked.row.id));
    return;
  }
  const { owner, name } = parseCredentialId(id);
  await s.db.insert(t).values({
    organizationId: s.organizationId,
    owner: owner ?? null,
    label: name,
    secretId: await addSecret(s.db, sealed),
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
        .select({ row: t, sealed: secret.value })
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
