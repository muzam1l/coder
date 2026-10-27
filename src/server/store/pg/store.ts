/** `Store` over the server tables: today's string ids live in key columns, the bodies in typed columns. */
import { createHash, randomUUID } from 'node:crypto';
import { watchChanges } from '../../../utils/fsx';
import type postgres from 'postgres';

import {
  and,
  asc,
  eq,
  gt,
  gte,
  inArray,
  ilike,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import {
  type Batch,
  type Conversation,
  type ConversationState,
  type Unseen,
} from '../../tasks/conversation';
import { SINCE_LIMIT } from '../../../agent/context/turn';
import type { SinceMessage } from '../../../integrations/types';
import type { AgentApp, Installation, Connection } from '../../../agent/types';
import type {
  AgentVersionRecord,
  DeliveryLease,
  TaskHistory,
  TaskLogLine,
  Store,
  StoreListOptions,
  MetadataKind,
  AgentPageOptions,
  CredentialScope,
  CredentialWork,
  DispatchInput,
  DispatchState,
  StoreKind,
  StoreRecords,
  LoginPatch,
  LoginFence,
  UsageAmount,
  UsageQuery,
  UsageTotalRow,
  HeldWrite,
  TokenState,
} from '../types';
import { APPROVAL_PREFIX } from '../../tasks/approvals';
import type { ServerConfig } from '../../context';
import type { ApprovalPost } from '../../tasks/approvals';
import { type EngineLogin } from '../../settings/logins';
import {
  completeLogin,
  credentialId,
  parseCredentialId,
  type StoredCredential,
} from '../../settings/credentials';
import { pipeline, readQuery, type Db } from './client';
import { DrizzleQueue } from './queue';
import type { TaskQueue } from '../../tasks/queue';
import {
  agent,
  agentVersion,
  approvalPost,
  chatItem,
  chatState,
  connection,
  engineCredential,
  platformLink,
  runner,
  secret,
  task,
  taskSecret,
  taskTombstone,
  workspace,
  workspaceUsage,
} from './schema';
import type { RepoFile } from '../../agents/repo';
import {
  addTokens,
  addUsage,
  timeZone,
  type UsageGroup,
  type UsageTotal,
  type UsageTotals,
} from '../../tasks/usage';
import { agents, agentVersions, insertVersion, publishAgent } from './tables/agents';
import {
  apps,
  appValue,
  installationSecret,
  installationValue,
  credentials,
  credentialLock,
  credentialValue,
  installations,
  checkBinding,
  lockCredentials,
  lockInstallation,
  shared,
  writeCredential,
} from './tables/apps';
import {
  approvalPosts,
  configs,
  connectionLock,
  connections,
  heldTokensQuery,
  isTaskSecret,
  runners,
  sealedCredential,
  sealedRunner,
  stateRows,
  taskSecrets,
  tokenState,
  type JsonRow,
  unseenAcknowledged,
} from './tables/resources';
import { batchValue, writeCredentials } from '../memory';
import {
  addSecret,
  agentValue,
  app,
  date,
  dropSecrets,
  escapeLike,
  fromJson,
  install,
  splitKey,
  UNSCOPED_ORGANIZATION,
  versionValue,
  versionColumns,
  versionSummary,
  statePrefix,
  stateKey,
  taskRecord,
  rows as queryRows,
  withSecret,
  type Kind,
  type Rows,
} from './tables/shared';
import {
  histories,
  historySummaries,
  inboxes,
  logs,
  tasks,
  usages,
  writeLogs,
} from './tables/tasks';
import { BATCH_LEASE_MS } from '../types';

export class DrizzleStore implements Store {
  private recordChannel(kind: string, id: string) {
    return `record_${createHash('sha256')
      .update(JSON.stringify([this.organizationId, kind, id]))
      .digest('hex')
      .slice(0, 48)}`;
  }

  notification(kind: string, id: string) {
    return this.notifications
      ? { notified: sql`pg_notify(${this.recordChannel(kind, id)}, '')` }
      : undefined;
  }

  async watch(kind: 'login' | 'delivery', id: string) {
    const changes = watchChanges();
    const client = (this.db as Db & { $client?: postgres.Sql }).$client;
    const listening = client?.listen
      ? await client
          .listen(this.recordChannel(kind, id), changes.notify, changes.notify)
          .catch(() => undefined)
      : undefined;
    return {
      ...changes,
      close() {
        void listening?.unlisten().catch(() => {});
        changes.close();
      },
    };
  }

  publishAgent: NonNullable<Store['publishAgent']> = (record, version, expected) =>
    publishAgent(this, record, version, expected);
  private readonly kinds: { [K in StoreKind]: Kind<StoreRecords[K]> };

  constructor(
    readonly db: Db,
    readonly organizationId: string,
    readonly now: () => number = Date.now,
    readonly encryption: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'> = {},
    /** The advisory locks the enclosing transaction holds; absent outside one. */
    private readonly locks?: Set<string>,
    private readonly notifications = Boolean(
      (db as Db & { $client?: postgres.Sql }).$client?.unsafe,
    ),
  ) {
    this.kinds = {
      agent: agents(this),
      agentversion: agentVersions(this),
      app: apps(this),
      installation: installations(this),
      credential: credentials(this),
      task: tasks(this),
      history: histories(this),
      tasklog: logs(this),
      inbox: inboxes(this),
      usage: usages(this),
      delivery: stateRows(this, 'delivery'),
      login: stateRows(this, 'login'),
      config: configs(this),
      runner: runners(this),
      snapshot: stateRows(this, 'snapshot'),
      connection: connections(this),
    };
    this.posts = approvalPosts(this);
    this.secrets = taskSecrets(this);
  }

  private readonly posts: Kind<ApprovalPost>;
  private readonly secrets: Kind<StoreRecords['snapshot']>;

  /** The `delivery` kind's approval posts and the `snapshot` kind's task secrets have their own tables. */
  private kind(kind: StoreKind, id?: string): Kind<StoreRecords[StoreKind]> {
    return kind === 'delivery' && id?.startsWith(APPROVAL_PREFIX)
      ? (this.posts as Kind<StoreRecords[StoreKind]>)
      : kind === 'snapshot' && id && isTaskSecret(id)
        ? (this.secrets as Kind<StoreRecords[StoreKind]>)
        : this.kinds[kind];
  }

  /** An app and the organization owning it, across every organization, in one query. */
  static async webhookTarget(db: Db, key: string, installationKey?: string) {
    const [row] = await readQuery(db, () =>
      db
        .select({
          app,
          credentials: secret.value,
          installation: install,
          token: installationSecret.value,
        })
        .from(app)
        .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
        .leftJoin(
          install,
          and(
            eq(install.appId, app.id),
            eq(install.key, installationKey ?? ''),
            isNull(install.deletedAt),
          ),
        )
        .leftJoin(installationSecret, eq(installationSecret.id, install.tokenSecretId))
        .where(eq(app.key, key)),
    );
    if (row && !row.installation && installationKey) {
      const prefix = `${key}/`;
      const [sharing] = await readQuery(db, () =>
        db
          .select({
            app,
            credentials: secret.value,
            installation: install,
            token: installationSecret.value,
          })
          .from(install)
          .innerJoin(app, eq(app.id, install.appId))
          .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
          .leftJoin(installationSecret, eq(installationSecret.id, install.tokenSecretId))
          .where(
            and(
              sql`left(${app.key}, ${prefix.length}) = ${prefix}`,
              eq(install.platformInstallId, installationKey.slice(key.length + 1)),
              isNull(install.deletedAt),
            ),
          )
          .limit(1),
      );
      if (sharing)
        return {
          organizationId: sharing.app.organizationId,
          app: appValue(sharing.app, sharing.credentials),
          bound: {
            organizationId: sharing.installation.organizationId,
            installation: installationValue(sharing.installation, sharing.app, sharing.token),
          },
        };
    }
    return (
      row && {
        organizationId: row.app.organizationId,
        app: appValue(row.app, row.credentials),
        ...(row.installation
          ? {
              bound: {
                organizationId: row.installation.organizationId,
                installation: installationValue(row.installation, row.app, row.token),
              },
            }
          : {}),
      }
    );
  }

  static async appRecord(
    db: Db,
    key: string,
  ): Promise<{ organizationId: string; app: AgentApp } | undefined> {
    const [row] = await readQuery(db, () =>
      db
        .select({ row: app, credentials: secret.value })
        .from(app)
        .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
        .where(eq(app.key, key)),
    );
    return (
      row && { organizationId: row.row.organizationId, app: appValue(row.row, row.credentials) }
    );
  }

  /** Every workspace's apps on one integration. */
  static async apps(
    db: Db,
    integration: string,
  ): Promise<Array<{ organizationId: string; app: AgentApp }>> {
    const rows = await readQuery(db, () =>
      db
        .select({ row: app, credentials: secret.value })
        .from(app)
        .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
        .where(eq(app.integration, integration)),
    );
    return rows.map(({ row, credentials }) => ({
      organizationId: row.organizationId,
      app: appValue(row, credentials),
    }));
  }

  /** The workspace an installation key is bound to, across every organization. */
  static async installationOrganization(db: Db, key: string): Promise<string | undefined> {
    const [row] = await readQuery(db, () =>
      db
        .select({ organizationId: install.organizationId })
        .from(install)
        .where(eq(install.key, key)),
    );
    return row?.organizationId;
  }

  /** Live installations of one integration in every workspace. */
  static async installations(
    db: Db,
    integration: string,
  ): Promise<Array<{ key: string; organizationId: string }>> {
    return readQuery(db, () =>
      db
        .select({ key: install.key, organizationId: install.organizationId })
        .from(install)
        .where(
          and(
            sql`${install.key} like ${`${escapeLike(integration)}:%`}`,
            isNull(install.deletedAt),
          ),
        ),
    );
  }

  /** Resolve a task tenant only when both the public id and current token match. */
  static async taskOrganization(
    db: Db,
    publicId: string,
    tokenHash: string,
  ): Promise<string | undefined> {
    const [row] = await readQuery(db, () =>
      db
        .select({ organizationId: task.organizationId })
        .from(task)
        .where(and(eq(task.publicId, publicId), eq(task.tokenHash, tokenHash))),
    );
    return row?.organizationId;
  }

  async getApps(keys: string[]) {
    if (!keys.length) return [];
    const rows = await readQuery(this.db, () =>
      this.db
        .select({ row: app, credentials: secret.value, sharedKey: shared.key })
        .from(app)
        .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
        .leftJoin(shared, eq(shared.id, app.sharedAppId))
        .where(
          and(
            inArray(app.organizationId, [this.organizationId, UNSCOPED_ORGANIZATION]),
            inArray(app.key, keys),
          ),
        ),
    );
    return rows.map(row => ({
      id: row.row.key,
      value: appValue(row.row, row.credentials, row.sharedKey),
    }));
  }

  async listCredentials(opts: { owner?: string; limit?: number }) {
    const t = engineCredential;
    const query = this.db
      .select({ row: t, sealed: secret.value })
      .from(t)
      .innerJoin(secret, eq(secret.id, t.secretId))
      .where(
        and(
          this.mine(t.organizationId),
          opts.owner ? or(isNull(t.owner), eq(t.owner, opts.owner)) : isNull(t.owner),
        ),
      )
      .orderBy(
        asc(sql`case when ${t.owner} is null then 'workspace' else 'personal' end`),
        asc(t.label),
      );
    const rows = await readQuery(this.db, () =>
      opts.limit === undefined ? query : query.limit(opts.limit),
    );
    return rows.map(({ row, sealed }) => ({
      id: credentialId(row.owner ?? undefined, row.label),
      value: credentialValue(row, sealed),
    }));
  }

  async updateMetadata(
    kind: MetadataKind,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    if (kind === 'installation' && ('covers' in fields || 'deletedAt' in fields))
      return this.transaction(`installation:${id}`, async store => {
        const current = await store.get('installation', id);
        if (!current) return false;
        const next = { ...current, ...fields };
        if (next.deletedAt === undefined) await checkBinding(store, id, next);

        return store.writeMetadata(kind, id, fields);
      });

    return this.writeMetadata(kind, id, fields);
  }

  private async writeMetadata(
    kind: MetadataKind,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<boolean> {
    const table = kind === 'app' ? app : kind === 'installation' ? install : runner;
    const allowed =
      kind === 'app'
        ? ['name', 'agentsRepo', 'branch', 'botId']
        : kind === 'installation'
          ? ['account', 'self', 'covers', 'repos', 'deletedAt', 'uninstalled']
          : ['name', 'config', 'lastSeen', 'updatedAt'];
    if (Object.keys(fields).some(key => !allowed.includes(key)))
      throw new Error('Invalid metadata fields');
    const values = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key,
        value === undefined
          ? null
          : ['deletedAt', 'updatedAt', 'lastSeen'].includes(key)
            ? date(value as number)
            : value,
      ]),
    );
    const key = kind === 'runner' ? runner.publicId : kind === 'app' ? app.key : install.key;
    const [row] = await this.db
      .update(table)
      .set({
        ...values,
        updatedAt: typeof fields.updatedAt === 'number' ? date(fields.updatedAt) : this.at(),
      })
      .where(and(this.mine(table.organizationId), eq(key, id)))
      .returning({ id: table.id });
    return Boolean(row);
  }

  withAppLock<T>(id: string, work: (store: Store) => Promise<T>): Promise<T> {
    const scoped = /^connections?[:-]/.test(id) ? `${this.organizationId}:${id}` : id;

    return this.transaction(`app:${scoped}`, work);
  }

  queue(): TaskQueue {
    return new DrizzleQueue(this.db);
  }

  withConfigLock<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return this.transaction(`config:${this.organizationId}`, work);
  }

  async transaction<T>(key: string, work: (store: DrizzleStore) => Promise<T>): Promise<T> {
    const lock = sql`select pg_advisory_xact_lock(3, hashtext(${key}))`;
    if (this.locks) {
      if (!this.locks.has(key)) await this.db.execute(lock);
      this.locks.add(key);
      return work(this);
    }
    return this.db.transaction(async tx => {
      await tx.execute(lock);

      return work(
        new DrizzleStore(
          tx as unknown as Db,
          this.organizationId,
          this.now,
          this.encryption,
          new Set([key]),
          this.notifications,
        ),
      );
    });
  }

  withCredential<K extends CredentialScope>(
    scope: K,
    id: string,
    work: CredentialWork<K>,
  ): Promise<boolean>;
  withCredential(
    scope: CredentialScope,
    id: string,
    work: CredentialWork<'credential'> | CredentialWork<'installation'> | CredentialWork<'runner'>,
  ): Promise<boolean> {
    if (scope === 'runner')
      return this.withAppLock(`runners:${this.organizationId}`, store =>
        writeCredentials(store, 'runner', id, work as CredentialWork<'runner'>),
      );
    if (scope === 'installation')
      return this.transaction(`installation:${id}`, async store => {
        const current = await lockInstallation(store, id);
        const changes = await (work as CredentialWork<'installation'>)(
          current,
          current ? [{ id, value: current }] : [],
          store,
        );
        for (const change of changes ?? []) {
          if (change.value === null) await store.delete('installation', change.id);
          else await store.put('installation', change.id, change.value);
        }

        return Boolean(changes?.length);
      });
    const { owner } = parseCredentialId(id);

    return this.transaction(credentialLock(this, owner), async store => {
      const locked = await lockCredentials(store, owner);
      const rows = locked.map(({ id, value }) => ({ id, value }));
      const changes = await (work as CredentialWork<'credential'>)(
        rows.find(row => row.id === id)?.value,
        rows,
        store,
      );
      for (const change of changes ?? [])
        await writeCredential(
          store,
          locked.find(row => row.id === change.id),
          change.id,
          change.value,
        );

      return Boolean(changes?.length);
    });
  }

  at(): Date {
    return date(this.now());
  }

  live(column: PgColumn): SQL {
    return or(isNull(column), gt(column, this.at()))!;
  }

  mine(column: PgColumn): SQL {
    return eq(column, this.organizationId);
  }

  get<K extends StoreKind>(kind: K, id: string): Promise<StoreRecords[K] | undefined>;
  get<T extends StoreRecords['snapshot']>(kind: 'snapshot', id: string): Promise<T | undefined>;
  get<T extends StoreRecords['delivery']>(kind: 'delivery', id: string): Promise<T | undefined>;
  async get(kind: StoreKind, id: string): Promise<StoreRecords[StoreKind] | undefined> {
    if (kind === 'app') return (await this.getApps([id]))[0]?.value;
    const k = this.kind(kind, id);
    const split = splitKey(id);
    const where = k.where
      ? k.where({ id })
      : k.split && split
        ? k.split(split[0], split[1], true)
        : sql`${k.key} = ${id}`;

    return (await readQuery(this.db, async () => await k.rows(where, 1)))[0]?.value;
  }

  async patchLogin(
    id: string,
    fields: LoginPatch,
    expected: LoginFence = {},
  ): Promise<EngineLogin | undefined> {
    const [row] = await this.db
      .update(chatState)
      .set({
        value: sql`jsonb_strip_nulls(${chatState.value} || ${JSON.stringify(fields)}::jsonb)`,
      })
      .where(
        and(
          eq(chatState.key, stateKey(this.organizationId, 'login', id)),
          this.live(chatState.expiresAt),
          sql`(${chatState.value}->>'expiresAt')::bigint > ${this.now()}`,
          ...Object.entries(expected).map(([key, value]) =>
            Array.isArray(value)
              ? inArray(sql`${chatState.value}->>${key}`, value)
              : sql`${chatState.value}->>${key} = ${value}`,
          ),
        ),
      )
      .returning({
        value: sql<EngineLogin>`${chatState.value}`,
        ...this.notification('login', id),
      });
    return row?.value;
  }

  completeLogin(id: string, tokenHash: string, credential: StoredCredential): Promise<boolean> {
    return completeLogin(this, id, tokenHash, credential);
  }

  async listAgentsWithVersions(slug?: string | string[]) {
    const rows = await readQuery(this.db, () =>
      this.db
        .select({ record: agent, version: agentVersion })
        .from(agent)
        .leftJoin(
          agentVersion,
          and(eq(agentVersion.agentId, agent.id), eq(agentVersion.version, agent.currentVersion)),
        )
        .where(
          and(
            this.mine(agent.organizationId),
            slug === undefined
              ? undefined
              : Array.isArray(slug)
                ? slug.length
                  ? inArray(agent.slug, slug)
                  : sql`false`
                : eq(agent.slug, slug),
          ),
        )
        .orderBy(asc(agent.slug)),
    );
    return rows.map(({ record, version }) => ({
      record: agentValue(record),
      ...(version ? { version: versionValue(version, record.slug) } : {}),
    }));
  }

  async listAgentSummaries(opts: AgentPageOptions = {}) {
    const pattern = opts.q ? `%${escapeLike(opts.q)}%` : undefined;
    const later = sql`${agent.source} <> 'builtin'`;
    const query = this.db
      .select({ record: agent, version: versionColumns })
      .from(agent)
      .leftJoin(
        agentVersion,
        and(eq(agentVersion.agentId, agent.id), eq(agentVersion.version, agent.currentVersion)),
      )
      .where(
        and(
          this.mine(agent.organizationId),
          opts.slug === undefined ? undefined : eq(agent.slug, opts.slug),
          opts.after
            ? sql`(${later}, ${agent.slug}) > (${opts.after[0] === '1'}, ${opts.after.slice(2)})`
            : undefined,
          opts.source ? eq(agent.source, opts.source) : undefined,
          pattern
            ? or(
                ilike(agent.slug, pattern),
                ilike(agent.name, pattern),
                ilike(agent.description, pattern),
                ilike(agent.repo, pattern),
              )
            : undefined,
          opts.platform
            ? sql`${agentVersion.definition}->'integrations' ? ${opts.platform}`
            : undefined,
        ),
      )
      .orderBy(later, asc(agent.slug));
    const rows = await readQuery(this.db, () =>
      opts.limit === undefined ? query : query.limit(opts.limit),
    );
    return rows.map(({ record, version }) => ({
      record: agentValue(record),
      ...(version ? { version: versionSummary(version, record.slug) } : {}),
    }));
  }

  async listVersions(slug: string, count?: number, below?: number) {
    const query = this.db
      .select({ version: versionColumns })
      .from(agentVersion)
      .innerJoin(agent, eq(agent.id, agentVersion.agentId))
      .where(
        and(
          this.mine(agent.organizationId),
          eq(agent.slug, slug),
          below === undefined
            ? count === undefined
              ? undefined
              : lte(agentVersion.version, agent.currentVersion)
            : lt(agentVersion.version, below),
          count === undefined
            ? undefined
            : gte(
                agentVersion.version,
                below === undefined ? sql`${agent.currentVersion} + 1 - ${count}` : below - count,
              ),
        ),
      )
      .orderBy(asc(agentVersion.version));
    const rows = await readQuery(this.db, () => query);
    return rows.map(({ version }) => ({
      id: `${slug}:${String(version.version).padStart(6, '0')}`,
      value: versionSummary(version, slug),
    }));
  }

  async put<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    opts: { ttlMs?: number; unarchive?: boolean } = {},
  ): Promise<void> {
    const expiresAt = opts.ttlMs === undefined ? null : date(this.now() + opts.ttlMs);

    await this.kind(kind, id).put(id, value, expiresAt, opts);
  }

  async putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
    opts: { ttlMs?: number } = {},
  ): Promise<void> {
    if (!entries.length) return;
    if (kind === 'delivery' && !entries.some(entry => entry.id.startsWith(APPROVAL_PREFIX))) {
      await this.db
        .insert(chatState)
        .values(
          entries.map(({ id, value }) => ({
            key: stateKey(this.organizationId, kind, id),
            value,
            expiresAt: opts.ttlMs === undefined ? null : date(this.now() + opts.ttlMs),
          })),
        )
        .onConflictDoUpdate({
          target: chatState.key,
          set: { value: sql`excluded.value`, expiresAt: sql`excluded.expires_at` },
        });
      return;
    }
    if (kind !== 'tasklog') {
      await Promise.all(entries.map(entry => this.put(kind, entry.id, entry.value, opts)));
      return;
    }

    const [publicId] = splitKey(entries[0]!.id)!;
    const lines = entries.map(entry => {
      const [parent, seq] = splitKey(entry.id)!;
      if (parent !== publicId) throw new Error('A log batch must belong to one task');
      return { seq, ...(entry.value as Omit<TaskLogLine, 'seq'>) };
    });

    await writeLogs(this, publicId, lines);
  }

  async approvalPostsDue(now: number, staleMs: number) {
    const t = approvalPost;
    return readQuery(this.db, () =>
      this.db
        .select({ organizationId: t.organizationId, id: t.key, value: t.value })
        .from(t)
        .where(
          and(
            this.live(t.expiresAt),
            or(lte(t.retryAt, date(now)), and(isNull(t.shownAt), lte(t.at, date(now - staleMs)))),
          ),
        ),
    );
  }

  list<K extends StoreKind>(
    kind: K,
    options?: StoreListOptions,
  ): Promise<Array<{ id: string; value: StoreRecords[K] }>>;
  list<T extends StoreRecords['snapshot']>(
    kind: 'snapshot',
    options?: StoreListOptions,
  ): Promise<Array<{ id: string; value: T }>>;
  list<T extends StoreRecords['delivery']>(
    kind: 'delivery',
    options?: StoreListOptions,
  ): Promise<Array<{ id: string; value: T }>>;
  async list(kind: StoreKind, opts: StoreListOptions = {}): Promise<Rows<StoreRecords[StoreKind]>> {
    // A snapshot list whose prefix names no family reads both the state rows and the task secrets.
    if (kind === 'snapshot' && !opts.ids && 'connections:'.startsWith(opts.prefix ?? ''))
      return [
        ...(await this.listRows(kind, opts, this.kinds.snapshot)),
        ...(await this.listRows(kind, opts, this.secrets as Kind<StoreRecords[StoreKind]>)),
      ]
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, opts.limit);

    return this.listRows(kind, opts, this.kind(kind, opts.prefix));
  }

  private async listRows(
    kind: StoreKind,
    opts: StoreListOptions,
    k: Kind<StoreRecords[StoreKind]>,
  ): Promise<Rows<StoreRecords[StoreKind]>> {
    const filters: Array<SQL | undefined> = [];
    if (opts.ids)
      filters.push(
        opts.ids.length
          ? inArray(
              sql`${k.key}`,
              opts.ids.map(id => (k.where ? stateKey(this.organizationId, kind, id) : id)),
            )
          : sql`false`,
      );
    if (opts.runner)
      filters.push(
        kind === 'runner'
          ? or(eq(runner.publicId, opts.runner), eq(runner.name, opts.runner))
          : sql`false`,
      );
    if (opts.defaults) filters.push(kind === 'runner' ? eq(runner.isDefault, true) : sql`false`);
    if (opts.installation)
      filters.push(kind === 'usage' ? eq(install.key, opts.installation) : sql`false`);
    if (opts.agent)
      filters.push(
        kind === 'app' || kind === 'installation'
          ? eq(app.agent, opts.agent)
          : kind === 'agent'
            ? eq(agent.slug, opts.agent)
            : sql`false`,
      );
    if (opts.active)
      filters.push(
        kind === 'installation'
          ? or(
              isNull(install.deletedAt),
              ...(opts.includeUninstalled ? [eq(install.uninstalled, true)] : []),
            )
          : undefined,
      );
    if (opts.apps)
      filters.push(
        kind === 'installation' && opts.apps.length ? inArray(app.key, opts.apps) : sql`false`,
      );
    if (Object.hasOwn(opts, 'visibleTo')) {
      const owner =
        kind === 'runner'
          ? runner.owner
          : kind === 'credential'
            ? engineCredential.owner
            : connection.owner;
      filters.push(
        or(isNull(owner), opts.visibleTo ? eq(sql`${owner}`, opts.visibleTo) : undefined),
      );
    }
    if (k.where)
      return readQuery(
        this.db,
        async () => await k.rows(and(k.where!(opts), ...filters), opts.limit),
      );

    const parent = opts.prefix?.endsWith(':') ? opts.prefix.slice(0, -1) : undefined;
    const from = opts.after === undefined ? undefined : splitKey(opts.after);
    if (
      k.split &&
      parent &&
      !parent.includes(':') &&
      (opts.after === undefined || from?.[0] === parent)
    )
      return readQuery(this.db, async () => await k.rows(k.split!(parent, from?.[1]), opts.limit));

    const prefix = opts.prefix ? sql`${k.key} like ${`${escapeLike(opts.prefix)}%`}` : undefined;
    const after = opts.after ? sql`${k.key} > ${opts.after}` : undefined;
    const where = and(prefix, after, ...filters);

    return readQuery(this.db, async () => await k.rows(where, opts.limit));
  }

  async delete(kind: StoreKind, id: string): Promise<void> {
    const notification = kind === 'login' ? this.notification(kind, id) : undefined;
    if (notification) {
      await this.db
        .delete(chatState)
        .where(eq(chatState.key, stateKey(this.organizationId, kind, id)))
        .returning(notification);
      return;
    }
    await this.kind(kind, id).delete(id);
  }

  async create<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    opts: { ttlMs?: number } = {},
  ): Promise<boolean> {
    if (kind === 'agentversion') return insertVersion(this, id, value as AgentVersionRecord);
    if (kind === 'connection')
      return this.transaction(connectionLock(this, id), async s => {
        const { secret: sealed, ...record } = value as Connection;
        const secretId = sealed ? await addSecret(s.db, sealed) : null;
        const rows = await s.db
          .insert(connection)
          .values({
            organizationId: s.organizationId,
            key: id,
            owner: record.owner,
            record,
            secretId,
          })
          .onConflictDoNothing()
          .returning({ id: connection.id });
        if (!rows.length) await dropSecrets(s.db, [secretId]);

        return rows.length > 0;
      });
    if (kind !== 'delivery') throw new Error(`Atomic create is not supported for ${kind}`);

    const expiresAt = opts.ttlMs === undefined ? null : date(this.now() + opts.ttlMs);
    if (id.startsWith(APPROVAL_PREFIX)) {
      const post = value as ApprovalPost;
      const row = {
        value: post,
        at: date(post.at),
        shownAt: post.shownAt ? date(post.shownAt) : null,
        retryAt: post.retryAt === undefined ? null : date(post.retryAt),
        expiresAt,
      };
      const rows = await this.db
        .insert(approvalPost)
        .values({ organizationId: this.organizationId, key: id, ...row })
        .onConflictDoUpdate({
          target: [approvalPost.organizationId, approvalPost.key],
          set: row,
          setWhere: lte(approvalPost.expiresAt, this.at()),
        })
        .returning({ id: approvalPost.id });

      return rows.length > 0;
    }

    const rows = await this.db
      .insert(chatState)
      .values({ key: stateKey(this.organizationId, kind, id), value, expiresAt })
      .onConflictDoUpdate({
        target: chatState.key,
        set: { value, expiresAt },
        setWhere: lte(chatState.expiresAt, this.at()),
      })
      .returning({ key: chatState.key });

    return rows.length > 0;
  }

  async claimDeliveryLease(id: string, owner: string, ttlMs: number): Promise<number | undefined> {
    const expiresAt = sql`clock_timestamp() + ${ttlMs}::int * interval '1 millisecond'`;
    const [row] = await this.db
      .insert(chatState)
      .values({
        key: stateKey(this.organizationId, 'delivery', id),
        value: { owner, failures: 0 },
        expiresAt,
      })
      .onConflictDoUpdate({
        target: chatState.key,
        set: { value: sql`${chatState.value} || ${JSON.stringify({ owner })}::jsonb`, expiresAt },
        setWhere: sql`${chatState.expiresAt} <= clock_timestamp()`,
      })
      .returning({ value: chatState.value });
    return row ? (row.value as DeliveryLease).failures : undefined;
  }

  async updateDeliveryLease(
    id: string,
    owner: string,
    value?: DeliveryLease,
    opts = { ttlMs: 30_000 },
  ): Promise<boolean> {
    const where = and(
      eq(chatState.key, stateKey(this.organizationId, 'delivery', id)),
      sql`${chatState.value}->>'owner' = ${owner} and ${chatState.expiresAt} > clock_timestamp()`,
    );
    const expiresAt = sql`clock_timestamp() + ${opts.ttlMs}::int * interval '1 millisecond'`;
    const rows =
      value === undefined
        ? await this.db.delete(chatState).where(where).returning({ key: chatState.key })
        : await this.db
            .update(chatState)
            .set({
              value:
                value.next === undefined
                  ? value
                  : sql`${JSON.stringify(value)}::jsonb || jsonb_build_object('next', floor(extract(epoch from (${expiresAt})) * 1000))`,
              expiresAt,
            })
            .where(where)
            .returning({ key: chatState.key });
    return rows.length > 0;
  }

  async updateDelivery<T>(
    id: string,
    owner: string,
    value: T | undefined,
    opts: { ttlMs?: number } = {},
  ): Promise<boolean> {
    const where = and(
      eq(chatState.key, stateKey(this.organizationId, 'delivery', id)),
      sql`${chatState.value}->>'owner' = ${owner}`,
      this.live(chatState.expiresAt),
    );
    const rows =
      value === undefined
        ? await this.db.delete(chatState).where(where).returning({ key: chatState.key })
        : await this.db
            .update(chatState)
            .set({
              value,
              expiresAt: opts.ttlMs === undefined ? null : date(this.now() + opts.ttlMs),
            })
            .where(where)
            .returning({ key: chatState.key });
    return rows.length > 0;
  }

  listHistory(id: string): Promise<Array<Omit<TaskHistory, 'data' | 'state'>>> {
    return historySummaries(this, id);
  }

  async installationApp(
    id: string,
  ): Promise<{ installation: Installation; app: AgentApp } | undefined> {
    const [row] = await readQuery(this.db, () =>
      this.db
        .select({
          installation: install,
          app,
          credentials: secret.value,
          token: installationSecret.value,
          sharedKey: shared.key,
        })
        .from(install)
        .innerJoin(
          app,
          and(
            eq(app.id, install.appId),
            inArray(app.organizationId, [this.organizationId, UNSCOPED_ORGANIZATION]),
          ),
        )
        .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
        .leftJoin(shared, eq(shared.id, app.sharedAppId))
        .leftJoin(installationSecret, eq(installationSecret.id, install.tokenSecretId))
        .where(
          and(this.mine(install.organizationId), eq(install.key, id), isNull(install.deletedAt)),
        ),
    );

    return (
      row && {
        installation: installationValue(row.installation, row.app, row.token),
        app: appValue(row.app, row.credentials, row.sharedKey),
      }
    );
  }

  async conversationState(key: string): Promise<ConversationState> {
    const unseen = alias(chatState, 'unseen');
    const batch = alias(chatState, 'batch');
    const [row] = await readQuery(this.db, () =>
      this.db
        .select({ record: chatState.value, unseen: unseen.value, batch: batch.value, task })
        .from(sql`(select 1) as anchor`)
        .leftJoin(
          chatState,
          and(
            eq(chatState.key, stateKey(this.organizationId, 'delivery', key)),
            this.live(chatState.expiresAt),
          ),
        )
        .leftJoin(
          unseen,
          and(
            eq(unseen.key, stateKey(this.organizationId, 'delivery', `since:${key}`)),
            this.live(unseen.expiresAt),
          ),
        )
        .leftJoin(
          batch,
          and(
            eq(batch.key, stateKey(this.organizationId, 'delivery', `batch:${key}`)),
            this.live(batch.expiresAt),
          ),
        )
        .leftJoin(
          task,
          and(
            this.mine(task.organizationId),
            eq(task.publicId, sql`${chatState.value}->>'taskId'`),
            eq(task.flow, 'default'),
          ),
        ),
    );

    return {
      ...(row?.record ? { record: row.record as Conversation } : {}),
      ...(row?.unseen ? { unseen: row.unseen as Unseen } : {}),
      ...(row?.batch ? { batch: row.batch as Batch } : {}),
      ...(row?.task ? { status: taskRecord(row.task) } : {}),
    };
  }

  async heldTokens(installations: string[], apps: string[]): Promise<TokenState> {
    const [row] = await readQuery(this.db, () =>
      queryRows<{ tokens: Record<string, unknown> }>(
        this.db,
        sql`select ${heldTokensQuery(this.organizationId, installations, apps)} as tokens`,
      ),
    );

    return tokenState(this.organizationId, row?.tokens ?? {});
  }

  async holdToken(write: HeldWrite): Promise<void> {
    const t = chatState;
    const snapshot = (id: string) => stateKey(this.organizationId, 'snapshot', id);
    await this.db.execute(sql`insert into ${t} (key, value, expires_at)
      select ${snapshot(write.key)}, ${JSON.stringify(write.value)}::jsonb, ${date(this.now() + write.ttlMs).toISOString()}::timestamptz
      where ${sql.join(
        write.drops.map(
          drop =>
            sql`coalesce((select ${t.value}->>'drop' from ${t} where ${t.key} = ${snapshot(drop.key)} and ${this.live(t.expiresAt)}), '') = ${drop.drop ?? ''}`,
        ),
        sql` and `,
      )}
      on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at`);
  }

  async saveTaskSecrets(
    taskId: string,
    rows: Array<{ id: string; value: string; expiresAt: number }>,
  ): Promise<boolean> {
    const [row] = await pipeline<{ active: boolean }>(
      this.db,
      [
        sql`select pg_advisory_xact_lock(3, hashtext(${`app:${this.organizationId}:connections:${taskId}`}))`,
      ],
      sql`with active as (select id from ${task} where ${this.mine(task.organizationId)} and ${task.publicId} = ${taskId} and ${task.status} in ('queued', 'running', 'waiting')),
        ${taskSecretRows(rows, sql`select id from active`)}
        select exists (select 1 from active) as active`,
    );

    return Boolean(row?.active);
  }

  /** Claims the delivery and reads the dispatch's state in the same statement: the agent, the conversation, the workspace's records with the linked member's own, and the installation's held tokens. */
  async dispatchState(input: DispatchInput): Promise<DispatchState> {
    const t = chatState;
    const key = (id: string) => stateKey(this.organizationId, 'delivery', id);
    const conversation = input.conversation ?? '';
    const live = (id: string) =>
      sql`(select ${t.value} from ${t} where ${t.key} = ${key(id)} and ${this.live(t.expiresAt)})`;
    const owned = (column: SQL | PgColumn) =>
      sql`(${column} is null or ${column} = (select requester from member))`;
    const mine = (column: SQL | PgColumn) => sql`${column} = ${this.organizationId}`;
    const sealedRows = (table: SQL, where: SQL) =>
      sql`(select coalesce(jsonb_agg(${withSecret(sql`to_jsonb(r)`, sql`s.value`)}), '[]'::jsonb)
          from ${table} r join ${secret} s on s.id = r.secret_id where ${where})`;
    const snapshots = statePrefix(this.organizationId, 'snapshot');
    const files = input.files.map(prefix => `${escapeLike(snapshots + prefix)}%`);
    const [row] = await queryRows<{
      claimed: boolean;
      record: Record<string, unknown> | null;
      version: Record<string, unknown> | null;
      conversation: Conversation | null;
      unseen: Unseen | null;
      batch: Batch | null;
      task: Record<string, unknown> | null;
      member: { id: string; name: string; email: string } | null;
      credentials: JsonRow[];
      runners: JsonRow[];
      connections: Connection[];
      workspace: { slug?: string; name?: string } | null;
      files: Record<string, RepoFile>;
      tokens: Record<string, unknown>;
    }>(
      this.db,
      sql`
      with claim as (
        insert into ${t} (key, value, expires_at)
        values (${key(input.delivery.key)}, ${JSON.stringify({ at: input.delivery.at, owner: input.delivery.owner, pending: true })}::jsonb, ${date(input.delivery.at + input.delivery.ttlMs).toISOString()}::timestamptz)
        on conflict (key) do update set value = excluded.value, expires_at = excluded.expires_at
          where ${t.expiresAt} <= ${this.at().toISOString()}::timestamptz
        returning key
      ), conversation as (select ${live(conversation)} as value),
      member as (select ${platformLink.userId} as requester, ${platformLink.name} as name, ${platformLink.email} as email from ${platformLink}
        where ${platformLink.platform} = ${input.actor?.platform ?? null}::text and ${platformLink.platformUserId} = ${input.actor?.id ?? null}::text
          and ${platformLink.organizations} ? ${this.organizationId} limit 1)
      select exists (select 1 from claim) as claimed,
        (select to_jsonb(a) from ${agent} a where ${mine(sql`a.organization_id`)} and a.slug = ${input.agent}) as record,
        (select to_jsonb(v) from ${agentVersion} v join ${agent} a on a.id = v.agent_id and v.version = a.current_version
          where ${mine(sql`a.organization_id`)} and a.slug = ${input.agent}) as version,
        (select value from conversation) as conversation,
        ${live(`since:${conversation}`)} as unseen,
        ${live(`batch:${conversation}`)} as batch,
        (select to_jsonb(t) from ${task} t, conversation c where ${mine(sql`t.organization_id`)} and t.public_id = c.value->>'taskId' and t.flow = 'default') as task,
        (select jsonb_build_object('id', requester, 'name', name, 'email', email) from member) as member,
        ${sealedRows(sql`${engineCredential}`, sql`${mine(sql`r.organization_id`)} and ${owned(sql`r.owner`)}`)} as credentials,
        ${sealedRows(sql`${runner}`, sql`${mine(sql`r.organization_id`)} and r.is_default and ${owned(sql`r.owner`)}`)} as runners,
        (select coalesce(jsonb_agg(${withSecret(sql`c.record`, sql`s.value`)} order by c.key), '[]'::jsonb) from ${connection} c left join ${secret} s on s.id = c.secret_id
          where ${mine(sql`c.organization_id`)} and ${owned(sql`c.owner`)}) as connections,
        coalesce((select jsonb_strip_nulls(jsonb_build_object('slug', ${workspace.slug}, 'name', ${workspace.name}))
          from ${workspace} where ${mine(workspace.organizationId)}), '{}'::jsonb) as workspace,
        (select coalesce(jsonb_object_agg(${t.key}, ${t.value}), '{}'::jsonb) from ${t}
          where ${this.live(t.expiresAt)} and ${t.key} like any(${sql.param(files)}::text[])) as files,
        ${heldTokensQuery(this.organizationId, [input.installation.id], [input.installation.app])} as tokens`,
    );
    if (!row?.claimed) return { claimed: false };
    const record = row.record ? agentValue(fromJson(agent, row.record)) : undefined;
    const version =
      row.version && record
        ? versionValue(fromJson(agentVersion, row.version), record.id)
        : undefined;

    return {
      claimed: true,
      loaded: {
        ...(record ? { record } : {}),
        ...(version ? { version } : {}),
        conversation: {
          ...(row.conversation ? { record: row.conversation } : {}),
          ...(row.unseen ? { unseen: row.unseen } : {}),
          ...(row.batch ? { batch: row.batch } : {}),
          ...(row.task ? { status: taskRecord(fromJson(task, row.task)) } : {}),
        },
        ...(row.member ? { member: row.member } : {}),
        credentials: row.credentials.map(sealedCredential),
        runners: row.runners.map(sealedRunner),
        connections: row.connections,
        ...(row.workspace ? { workspace: row.workspace } : {}),
        files: Object.fromEntries(
          Object.entries(row.files).map(([key, value]) => [key.slice(snapshots.length), value]),
        ),
        tokens: tokenState(this.organizationId, row.tokens),
      },
    };
  }

  async markConversation(
    key: string,
    taskId: string,
    seen: string,
    at: number,
    ttlMs: number,
  ): Promise<void> {
    await this.db
      .update(chatState)
      .set({
        value: sql`${chatState.value} || ${JSON.stringify({ at, seen })}::jsonb`,
        expiresAt: date(this.now() + ttlMs),
      })
      .where(
        and(
          eq(chatState.key, stateKey(this.organizationId, 'delivery', key)),
          sql`${chatState.value}->>'taskId' = ${taskId}`,
          this.live(chatState.expiresAt),
        ),
      );
  }

  async appendUnseen(key: string, message: SinceMessage, ttlMs: number): Promise<void> {
    const version = sql`coalesce((${chatState.value}->>'version')::bigint, jsonb_array_length(${chatState.value}->'messages') + (${chatState.value}->>'more')::bigint)`;
    const value = {
      messages: [{ ...message, sequence: 1 }],
      more: 0,
      version: 1,
      epoch: randomUUID(),
    };
    await this.db.execute(sql`
      insert into ${chatState} (key, value, expires_at)
      select ${stateKey(this.organizationId, 'delivery', `since:${key}`)}, ${JSON.stringify(value)}::jsonb, ${date(this.now() + ttlMs).toISOString()}::timestamptz
      where exists (select 1 from ${chatState} where key = ${stateKey(this.organizationId, 'delivery', key)} and ${this.live(chatState.expiresAt)})
      on conflict (key) do update set value = case when ${chatState.expiresAt} <= ${this.at().toISOString()}::timestamptz then excluded.value else
        ${chatState.value} || jsonb_build_object('version', ${version} + 1,
          'messages', case when jsonb_array_length(${chatState.value}->'messages') < ${SINCE_LIMIT} then
            (${chatState.value}->'messages') || jsonb_build_array(${JSON.stringify(message)}::jsonb || jsonb_build_object('sequence', ${version} + 1)) else ${chatState.value}->'messages' end,
          'more', (${chatState.value}->>'more')::int + case when jsonb_array_length(${chatState.value}->'messages') < ${SINCE_LIMIT} then 0 else 1 end) end,
        expires_at = excluded.expires_at
    `);
  }

  async acknowledgeUnseen(key: string, through: number, epoch?: string): Promise<void> {
    await this.db
      .update(chatState)
      .set({ value: unseenAcknowledged(through) })
      .where(
        and(
          eq(chatState.key, stateKey(this.organizationId, 'delivery', `since:${key}`)),
          sql`${chatState.value}->>'epoch' is not distinct from ${epoch ?? null}::text`,
          this.live(chatState.expiresAt),
        ),
      );
  }

  async appendBatch(
    id: string,
    owner: string,
    items: unknown[],
    at: number,
    ttlMs: number,
  ): Promise<void> {
    const value = batchValue(undefined, owner, items, at);
    const expiresAt = date(this.now() + ttlMs);
    await this.db
      .insert(chatState)
      .values({
        key: stateKey(this.organizationId, 'delivery', id),
        value,
        expiresAt,
      })
      .onConflictDoUpdate({
        target: chatState.key,
        set: {
          value: sql`case when ${chatState.expiresAt} <= ${this.at().toISOString()}::timestamptz then excluded.value else
          (select ${chatState.value} || excluded.value || jsonb_build_object(
            'items', prefix || coalesce((select jsonb_agg(item order by n) from jsonb_array_elements(pending) with ordinality e(item,n) where n > greatest(jsonb_array_length(pending) - 50, 0)), '[]'::jsonb),
            'more', coalesce((${chatState.value}->>'more')::int, 0) + coalesce((excluded.value->>'more')::int, 0) + greatest(jsonb_array_length(pending) - 50, 0),
            'mustReply', coalesce((${chatState.value}->>'mustReply')::boolean, false) or coalesce((excluded.value->>'mustReply')::boolean, false) or exists(select 1 from jsonb_array_elements(pending) with ordinality e(item,n) where n <= greatest(jsonb_array_length(pending) - 50, 0) and item->'event'->>'mustReply' = 'true'))
            from (select coalesce(jsonb_agg(item order by n) filter (where n <= coalesce((${chatState.value}->'sending'->>'count')::int, 0)), '[]'::jsonb) as prefix,
              coalesce(jsonb_agg(item order by n) filter (where n > coalesce((${chatState.value}->'sending'->>'count')::int, 0)), '[]'::jsonb) || (excluded.value->'items') as pending
              from jsonb_array_elements(${chatState.value}->'items') with ordinality e(item,n)) queued) end`,
          expiresAt,
        },
      });
  }

  async claimBatch(id: string, owner: string): Promise<Batch | null | undefined> {
    const key = stateKey(this.organizationId, 'delivery', id);
    const result = await queryRows<{ value: Batch; claimed: boolean }>(
      this.db,
      sql`
      with held as materialized (
        select key as batch_key, value as previous from ${chatState}
        where key = ${key} and value->>'owner' = ${owner} and ${this.live(chatState.expiresAt)} for update
      ), claimed as (
        update ${chatState} set value = (
          select ready || jsonb_build_object('more', 0, 'mustReply', false, 'sending', jsonb_build_object(
            'owner', ${owner}::text, 'until', ${this.now() + BATCH_LEASE_MS}::bigint,
            'count', jsonb_array_length(ready->'items'), 'more', ready->'more', 'mustReply', ready->'mustReply'))
          from (select (value - 'sending') || jsonb_build_object(
            'items', coalesce((select jsonb_agg(item order by n) from jsonb_array_elements(value->'items') with ordinality e(item,n)
              where n > greatest(jsonb_array_length(value->'items') - 50, 0)), '[]'::jsonb),
            'more', coalesce((value->>'more')::int, 0) + coalesce((value->'sending'->>'more')::int, 0) + greatest(jsonb_array_length(value->'items') - 50, 0),
            'mustReply', coalesce((value->>'mustReply')::boolean, false) or coalesce((value->'sending'->>'mustReply')::boolean, false) or exists(
              select 1 from jsonb_array_elements(value->'items') with ordinality e(item,n)
              where n <= greatest(jsonb_array_length(value->'items') - 50, 0) and item->'event'->>'mustReply' = 'true')) as ready) as available)
        from held where key = held.batch_key and coalesce((value->'sending'->>'until')::bigint, 0) <= ${this.now()}
          and jsonb_array_length(value->'items') > 0
        returning value
      ) select value, true as claimed from claimed
      union all select previous, false from held where not exists (select 1 from claimed)
    `,
    );
    const row = result[0];
    return row?.claimed
      ? { ...row.value, more: row.value.sending?.more, mustReply: row.value.sending?.mustReply }
      : row?.value.sending
        ? null
        : undefined;
  }

  async finishBatch(
    id: string,
    owner: string,
    accepted: boolean,
    through?: string,
  ): Promise<boolean> {
    const reserved = sql`(${chatState.value}->'sending'->>'count')::int`;
    const admitted =
      through === undefined
        ? reserved
        : sql`coalesce((select n from jsonb_array_elements(${chatState.value}->'items') with ordinality e(item,n)
          where n <= ${reserved} and item->>'admission' = ${through} limit 1), 0)`;
    const result = await this.db
      .update(chatState)
      .set({
        value: sql`case when ${accepted} and ${reserved} > ${admitted} then
          ${chatState.value} || jsonb_build_object('items',
            coalesce((select jsonb_agg(item order by n) from jsonb_array_elements(${chatState.value}->'items') with ordinality e(item,n)
              where n > ${admitted}), '[]'::jsonb),
            'sending', (${chatState.value}->'sending') || jsonb_build_object(
              'count', ${reserved} - ${admitted},
              'until', ${this.now() + BATCH_LEASE_MS}::bigint))
        else (${chatState.value} - 'sending') || jsonb_build_object('items',
        case when ${accepted} then coalesce((select jsonb_agg(item order by n) from jsonb_array_elements(${chatState.value}->'items') with ordinality as entries(item, n)
          where n > ${reserved}), '[]'::jsonb) else
          coalesce((select jsonb_agg(item order by n) from jsonb_array_elements(${chatState.value}->'items') with ordinality e(item,n)
            where n > greatest(jsonb_array_length(${chatState.value}->'items') - 50, 0)), '[]'::jsonb) end,
        'more', coalesce((${chatState.value}->>'more')::int, 0) + case when ${accepted} then 0 else coalesce((${chatState.value}->'sending'->>'more')::int, 0) + greatest(jsonb_array_length(${chatState.value}->'items') - 50, 0) end,
        'mustReply', coalesce((${chatState.value}->>'mustReply')::boolean, false) or (not ${accepted} and (coalesce((${chatState.value}->'sending'->>'mustReply')::boolean, false) or exists(select 1 from jsonb_array_elements(${chatState.value}->'items') with ordinality e(item,n)
          where n <= greatest(jsonb_array_length(${chatState.value}->'items') - 50, 0) and item->'event'->>'mustReply' = 'true')))) end`,
      })
      .where(
        and(
          eq(chatState.key, stateKey(this.organizationId, 'delivery', id)),
          sql`${chatState.value}->'sending'->>'owner' = ${owner}`,
          this.live(chatState.expiresAt),
        ),
      )
      .returning({ key: chatState.key });
    return result.length > 0;
  }

  async take<K extends StoreKind>(
    kind: K,
    id: string,
    expected?: Partial<StoreRecords[K]>,
  ): Promise<StoreRecords[K] | undefined> {
    if (kind === 'delivery' || kind === 'snapshot') {
      const [row] = await this.db
        .delete(chatState)
        .where(
          and(
            eq(chatState.key, stateKey(this.organizationId, kind, id)),
            this.live(chatState.expiresAt),
            expected ? sql`${chatState.value} @> ${JSON.stringify(expected)}::jsonb` : undefined,
          ),
        )
        .returning({ value: chatState.value });
      return row?.value as StoreRecords[K] | undefined;
    }
    const found = await this.get(kind, id);
    if (
      found === undefined ||
      Object.entries(expected ?? {}).some(
        ([key, value]) => (found as Record<string, unknown>)[key] !== value,
      )
    )
      return;
    await this.delete(kind, id);
    return found;
  }

  async usageSummary(since: number, by?: UsageGroup): Promise<UsageTotals['totals']> {
    const t = task;
    const group = sql`case groups.kind when 'agent' then ${t.agent} when 'engine' then coalesce(${t.engine}, 'unknown') else coalesce(${install.key}, 'none') end`;
    const key = by ? group : sql`groups.kind || ':' || (${group})`;
    const result = await readQuery(this.db, () =>
      queryRows<Row>(
        this.db,
        sql`
      select ${key} as key, count(*)::int as tasks, sum(${t.runnerMs})::float8 as runner_ms,
        jsonb_agg(${t.usageTokens} order by ${t.publicId}) filter (where ${t.usageTokens} is not null) as tokens
      from ${t} left join ${install} on ${install.id} = ${t.installationId}
      cross join unnest(${sql.param(by ? [by] : ['agent', 'installation', 'engine'])}::text[]) groups(kind)
      where ${this.mine(t.organizationId)} and ${t.runnerMs} is not null and ${t.finishedAt} >= ${new Date(since).toISOString()}::timestamptz
      group by 1 order by 1
    `,
      ),
    );
    type Row = { key: string; tasks: number; runner_ms: number; tokens: unknown[] | null };
    const totals = result.map(row => {
      const tokens = row.tokens?.reduce(addTokens, undefined);
      return {
        key: row.key,
        tasks: row.tasks,
        runnerMs: row.runner_ms,
        ...(tokens === undefined ? {} : { tokens }),
      };
    });
    if (by) return totals;
    const grouped: Record<UsageGroup, UsageTotal[]> = { agent: [], installation: [], engine: [] };
    for (const row of totals) {
      const colon = row.key.indexOf(':');
      grouped[row.key.slice(0, colon) as UsageGroup].push({
        ...row,
        key: row.key.slice(colon + 1),
      });
    }

    return grouped;
  }

  async serverRunnerUsage(now: number): Promise<{ cpuMs: number; running: number }> {
    const [row] = await readQuery(this.db, () =>
      queryRows<{ cpuMs: number; running: number }>(
        this.db,
        sql`
        with active as (
          select ${task.startedAt} as started_at, ${task.vcpus} as vcpus from ${task}
          where ${this.mine(task.organizationId)} and ${task.vcpus} is not null
            and ${task.status} in ('running', 'waiting')
        )
        select (
          coalesce((select sum(${workspaceUsage.amount}) from ${workspaceUsage}
            where ${this.mine(workspaceUsage.organizationId)}
              and ${workspaceUsage.month} = ${new Date(now).toISOString().slice(0, 7)}
              and ${workspaceUsage.meter} like 'cpu:%'), 0)
          + coalesce((select sum(greatest(0, ${now} - floor(extract(epoch from started_at) * 1000)) * vcpus)
            from active where started_at is not null), 0)
        )::float8 as "cpuMs", (select count(*) from active)::int as running
      `,
      ),
    );

    return { cpuMs: row?.cpuMs ?? 0, running: row?.running ?? 0 };
  }

  async usageTotals(query: UsageQuery): Promise<UsageTotalRow[]> {
    const t = task;
    const key =
      query.by === 'agent'
        ? sql`${t.agent}`
        : query.by === 'engine'
          ? sql`coalesce(${t.engine}, 'unknown')`
          : query.by === 'installation'
            ? sql`coalesce(${install.key}, 'none')`
            : sql`to_char(${t.finishedAt} at time zone ${timeZone(query.tz)}, 'YYYY-MM-DD')`;
    const range = and(
      this.mine(t.organizationId),
      isNotNull(t.runnerMs),
      gte(t.finishedAt, date(query.since)),
      query.until === undefined ? undefined : lt(t.finishedAt, date(query.until)),
      query.agent ? eq(t.agent, query.agent) : undefined,
    );
    const measure = {
      tasks: sql`count(*)`,
      runnerMs: sql`coalesce(sum(${t.runnerMs}), 0)`,
      tokenCount: sql`coalesce(sum(${t.tokenCount}), 0)`,
    };
    // The leading agents come from the same statement, so the report stays one round trip.
    const part = query.top
      ? sql`case when ${t.agent} in (
          select ${t.agent} from ${t} where ${range} group by ${t.agent}
          order by ${measure[query.top.by]} desc, ${t.agent} limit ${query.top.count}
        ) then ${t.agent} end`
      : query.parts?.length
        ? sql`case when ${inArray(t.agent, query.parts)} then ${t.agent} end`
        : sql`null::text`;
    const joined =
      query.by === 'installation'
        ? sql`left join ${install} on ${install.id} = ${t.installationId}`
        : sql``;
    type Row = {
      key: string;
      part: string | null;
      tasks: number;
      runner_ms: number;
      token_count: number;
    };
    const result = await readQuery(this.db, () =>
      queryRows<Row>(
        this.db,
        sql`
      select ${key} as key, ${part} as part, ${measure.tasks}::int as tasks,
        ${measure.runnerMs}::float8 as runner_ms,
        ${measure.tokenCount}::float8 as token_count
      from ${t} ${joined}
      where ${range}
      group by 1, 2
    `,
      ),
    );
    const totals = new Map<string, UsageTotalRow>();
    for (const row of result) {
      const amount: UsageAmount = {
        tasks: Number(row.tasks),
        runnerMs: Number(row.runner_ms),
        tokenCount: Number(row.token_count),
      };
      const total = totals.get(row.key) ?? {
        key: row.key,
        tasks: 0,
        runnerMs: 0,
        tokenCount: 0,
      };
      addUsage(total, amount);
      if (row.part) (total.parts ??= {})[row.part] = amount;
      totals.set(row.key, total);
    }
    return [...totals.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  /** Backend-wide maintenance, bounded per table; TTL state includes logins and every tenant. */
  async sweep(batch = 1000): Promise<void> {
    if (!Number.isInteger(batch) || batch < 1) throw new Error('Sweep batch must be positive');
    const now = this.at().toISOString();
    await this.db.execute(sql`
      with tombstones as (
        delete from ${taskTombstone} where (organization_id, public_id) in (
          select organization_id, public_id from ${taskTombstone}
          where deleted_at < ${new Date(this.now() - 10 * 60_000).toISOString()}::timestamptz
          order by deleted_at limit ${batch}
        )
      ), expired_state as (
        delete from ${chatState} where expires_at <= clock_timestamp() and key in (
          select key from ${chatState} where expires_at <= clock_timestamp() order by expires_at limit ${batch}
        )
      ), expired_posts as (
        delete from ${approvalPost} where id in (
          select id from ${approvalPost} where expires_at <= clock_timestamp() order by expires_at limit ${batch}
        )
      ), expired_task_secrets as (
        delete from ${taskSecret} where id in (
          select id from ${taskSecret} where expires_at <= clock_timestamp() order by expires_at limit ${batch}
        ) returning secret_id
      ), expired_secrets as (
        delete from ${secret} where id in (select secret_id from expired_task_secrets)
      ), lists as (
        select expired.key from ${chatItem} as expired
        where expired.key like 'k:%' and expired.expires_at <= ${now}::timestamptz
          and not exists (select 1 from ${chatItem} as newer where newer.key = expired.key and newer.seq > expired.seq)
        order by expired.expires_at limit ${batch}
      ), expired_items as (
        select key, seq from ${chatItem} where key in (select key from lists) order by seq limit ${batch}
      ), expired_queue as (
        select key, seq from ${chatItem} where key like 'q:%' and expires_at <= ${now}::timestamptz order by expires_at limit ${batch}
      )
      delete from ${chatItem} where (key, seq) in (
        select key, seq from expired_items union all select key, seq from expired_queue
      )`);
  }
}

/** CTEs sealing `rows` into `secret` and filing them under the task `owner` selects, skipping keys the task already has. */
export function taskSecretRows(
  rows: Array<{ id: string; value: string; expiresAt: number }>,
  owner: SQL,
): SQL {
  const values = sql.join(
    rows.map(
      row => sql`(${row.id}, ${row.value}, ${date(row.expiresAt).toISOString()}::timestamptz)`,
    ),
    sql`, `,
  );

  return sql`task_secret_rows as (select * from (values ${values}) as row(key, value, expires_at)
      where not exists (select 1 from ${taskSecret} where task_id in (${owner}) and key = row.key)),
    sealed as (insert into ${secret} (value) select value from task_secret_rows where exists (${owner}) returning id, value),
    kept as (insert into ${taskSecret} (task_id, key, secret_id, expires_at)
      select (${owner}), r.key, s.id, r.expires_at from task_secret_rows r join sealed s on s.value = r.value)`;
}
