/** `Store` over the server tables: today's string ids live in key columns, the bodies in typed columns. */
import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  inArray,
  ilike,
  isNull,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { alias, type PgColumn } from 'drizzle-orm/pg-core';

import type { AgentApp } from '../../../agent/types';
import type { AgentVersionRecord, DeliveryLease, TaskLogLine } from '../types';
import type { ServerConfig } from '../../context';
import { type EngineLogin } from '../../settings/logins';
import {
  completeLogin,
  credentialId,
  parseCredentialId,
  type StoredCredential,
} from '../../settings/credentials';
import { readQuery, type Db } from './client';
import {
  agent,
  agentVersion,
  chatItem,
  chatState,
  engineCredential,
  secret,
  runner,
  task,
  taskLog,
  usage,
} from './schema';
import { addUsage, timeZone } from '../../tasks/usage';
import { agents, agentVersions, insertVersion, publishAgent } from './tables/agents';
import {
  apps,
  appValue,
  installationValue,
  credentials,
  credentialLock,
  credentialValue,
  installations,
  lockCredentials,
  lockInstallation,
  writeCredential,
} from './tables/apps';
import { state, runners } from './tables/resources';
import { writeCredentials } from '../memory';
import {
  agentValue,
  app,
  date,
  escapeLike,
  install,
  splitKey,
  UNSCOPED_ORGANIZATION,
  versionValue,
  versionColumns,
  versionSummary,
  stateKey,
  type Kind,
  type Rows,
} from './tables/shared';
import { inboxes, logs, tasks, usages } from './tables/tasks';
import type {
  Store,
  MetadataKind,
  AgentPageOptions,
  CredentialScope,
  CredentialWork,
  StoreKind,
  StoreRecords,
  LoginPatch,
  LoginFence,
  UsageAmount,
  UsageQuery,
  UsageTotalRow,
} from '../types';

export class DrizzleStore implements Store {
  publishAgent: NonNullable<Store['publishAgent']> = (record, version) =>
    publishAgent(this, record, version);
  private readonly kinds: { [K in StoreKind]: Kind<StoreRecords[K]> };

  constructor(
    readonly db: Db,
    readonly organizationId: string,
    readonly now: () => number = Date.now,
    readonly encryption: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'> = {},
  ) {
    this.kinds = {
      agent: agents(this),
      agentversion: agentVersions(this),
      app: apps(this),
      installation: installations(this),
      credential: credentials(this),
      task: tasks(this),
      tasklog: logs(this),
      inbox: inboxes(this),
      usage: usages(this),
      delivery: state(this, 'delivery'),
      note: state(this, 'note'),
      login: state(this, 'login'),
      config: state(this, 'config'),
      runner: runners(this),
      snapshot: state(this, 'snapshot'),
    };
  }

  /** An app and the organization owning it, across every organization, in one query. */
  static async webhookTarget(db: Db, key: string, installationKey?: string) {
    const token = alias(secret, 'installation_secret');
    const [row] = await readQuery(db, () =>
      db
        .select({ app, credentials: secret, installation: install, token })
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
        .leftJoin(token, eq(token.id, install.tokenSecretId))
        .where(
          and(
            eq(app.integration, key.slice(0, key.indexOf(':'))),
            eq(app.platformAppId, key.slice(key.indexOf(':') + 1)),
          ),
        ),
    );
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
        .select({ row: app, sealed: secret })
        .from(app)
        .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
        .where(
          and(
            eq(app.integration, key.slice(0, key.indexOf(':'))),
            eq(app.platformAppId, key.slice(key.indexOf(':') + 1)),
          ),
        ),
    );
    return row && { organizationId: row.row.organizationId, app: appValue(row.row, row.sealed) };
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
        .select({ row: app, sealed: secret })
        .from(app)
        .innerJoin(secret, eq(secret.id, app.credentialsSecretId))
        .where(
          and(
            inArray(app.organizationId, [this.organizationId, UNSCOPED_ORGANIZATION]),
            inArray(app.key, keys),
          ),
        ),
    );
    return rows.map(row => ({ id: row.row.key, value: appValue(row.row, row.sealed) }));
  }

  async listCredentials(opts: { owner?: string; engine?: string }) {
    const t = engineCredential;
    const rows = await readQuery(this.db, () =>
      this.db
        .select({ row: t, sealed: secret })
        .from(t)
        .innerJoin(secret, eq(secret.id, t.secretId))
        .where(
          and(
            this.mine(t.organizationId),
            opts.owner ? or(isNull(t.owner), eq(t.owner, opts.owner)) : isNull(t.owner),
            opts.engine ? eq(t.engine, opts.engine as StoredCredential['engine']) : undefined,
          ),
        )
        .orderBy(asc(t.owner), asc(t.label)),
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
    const table = kind === 'app' ? app : kind === 'installation' ? install : runner;
    const allowed =
      kind === 'app'
        ? ['name', 'agentsRepo', 'branch']
        : kind === 'installation'
          ? ['account', 'connections', 'settings', 'deletedAt']
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
    return this.transaction(`app:${id}`, work);
  }

  withConfigLock<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      const key = stateKey(this.organizationId, 'config', 'workspace');
      await tx.insert(chatState).values({ key, value: {}, expiresAt: null }).onConflictDoNothing();
      await tx
        .select({ key: chatState.key })
        .from(chatState)
        .where(eq(chatState.key, key))
        .for('update');

      return work(
        new DrizzleStore(tx as unknown as Db, this.organizationId, this.now, this.encryption),
      );
    });
  }

  transaction<T>(key: string, work: (store: DrizzleStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(3, hashtext(${key}))`);

      return work(
        new DrizzleStore(tx as unknown as Db, this.organizationId, this.now, this.encryption),
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
    const k = this.kinds[kind];
    const split = splitKey(id);
    const where = k.where
      ? k.where({ id })
      : k.split && split
        ? k.split(split[0], split[1], true)
        : sql`${k.key} = ${id}`;

    const found = (await readQuery(this.db, async () => await k.rows(where, 1)))[0]?.value;
    // Server-level apps are readable from every workspace.
    if (found || kind !== 'app' || this.organizationId === UNSCOPED_ORGANIZATION) return found;

    return new DrizzleStore(this.db, UNSCOPED_ORGANIZATION, this.now, this.encryption).get(
      kind,
      id,
    );
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
      .returning({ value: sql<EngineLogin>`${chatState.value}` });
    return row?.value;
  }

  completeLogin(
    id: string,
    tokenHash: string,
    label: string,
    credential: StoredCredential,
  ): Promise<boolean> {
    return completeLogin(this, id, tokenHash, label, credential);
  }

  async taskInputs(slug: string, requester?: string, engine?: string) {
    const effectiveEngine = sql`coalesce(${engine ?? null}, ${agent.settings}->>'engine', ${agentVersion.definition}->>'engine')`;
    const credential = this.db
      .select({ owner: engineCredential.owner, label: engineCredential.label })
      .from(engineCredential)
      .where(
        and(
          this.mine(engineCredential.organizationId),
          requester
            ? or(isNull(engineCredential.owner), eq(engineCredential.owner, requester))
            : isNull(engineCredential.owner),
          sql`(${effectiveEngine} is null or ${engineCredential.engine} = ${effectiveEngine})`,
        ),
      )
      .orderBy(
        sql`${engineCredential.owner} is not null desc`,
        desc(engineCredential.isDefault),
        asc(engineCredential.label),
      )
      .limit(1)
      .as('selected_credential');
    const [row] = await readQuery(this.db, () =>
      this.db
        .select({
          record: agent,
          version: agentVersion,
          credentialLabel: credential.label,
          credentialOwner: credential.owner,
        })
        .from(agent)
        .leftJoin(
          agentVersion,
          and(eq(agentVersion.agentId, agent.id), eq(agentVersion.version, agent.currentVersion)),
        )
        .leftJoinLateral(credential, sql`true`)
        .where(and(this.mine(agent.organizationId), eq(agent.slug, slug))),
    );
    return row
      ? {
          record: agentValue(row.record),
          ...(row.version ? { version: versionValue(row.version, row.record.slug) } : {}),
          ...(row.credentialLabel
            ? { credential: credentialId(row.credentialOwner ?? undefined, row.credentialLabel) }
            : {}),
        }
      : {};
  }

  async listAgentsWithVersions(slug?: string) {
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
            slug === undefined ? undefined : eq(agent.slug, slug),
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
          opts.after ? gt(agent.slug, opts.after) : undefined,
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
      .orderBy(asc(agent.slug));
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

    await this.kinds[kind].put(id, value, expiresAt, opts);
  }

  async putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
  ): Promise<void> {
    if (!entries.length) return;
    if (kind !== 'tasklog') {
      await Promise.all(entries.map(entry => this.put(kind, entry.id, entry.value)));
      return;
    }

    const firstSplit = entries[0]!.id.lastIndexOf(':');
    const publicId = entries[0]!.id.slice(0, firstSplit);
    const values = entries.map(entry => {
      const split = entry.id.lastIndexOf(':');
      const value = entry.value as Omit<TaskLogLine, 'seq'>;
      if (entry.id.slice(0, split) !== publicId)
        throw new Error('A log batch must belong to one task');
      return {
        organizationId: this.organizationId,
        taskId: sql`(select ${task.id} from ${task} where ${task.organizationId} = ${this.organizationId} and ${task.publicId} = ${publicId})`,
        seq: Number(entry.id.slice(split + 1)),
        at: date(value.at),
        level: value.level,
        line: value.line,
      };
    });

    await this.db
      .insert(taskLog)
      .values(values)
      .onConflictDoUpdate({
        target: [taskLog.taskId, taskLog.seq],
        set: {
          at: sql`excluded.at`,
          level: sql`excluded.level`,
          line: sql`excluded.line`,
        },
      });
  }

  list<K extends StoreKind>(
    kind: K,
    options?: { prefix?: string; after?: string; limit?: number },
  ): Promise<Array<{ id: string; value: StoreRecords[K] }>>;
  list<T extends StoreRecords['snapshot']>(
    kind: 'snapshot',
    options?: { prefix?: string; after?: string; limit?: number },
  ): Promise<Array<{ id: string; value: T }>>;
  list<T extends StoreRecords['delivery']>(
    kind: 'delivery',
    options?: { prefix?: string; after?: string; limit?: number },
  ): Promise<Array<{ id: string; value: T }>>;
  async list(
    kind: StoreKind,
    opts: { prefix?: string; after?: string; limit?: number } = {},
  ): Promise<Rows<StoreRecords[StoreKind]>> {
    const k = this.kinds[kind];
    if (k.where) return readQuery(this.db, async () => await k.rows(k.where!(opts), opts.limit));

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
    const where = prefix && after ? and(prefix, after) : (prefix ?? after);

    return readQuery(this.db, async () => await k.rows(where, opts.limit));
  }

  async delete(kind: StoreKind, id: string): Promise<void> {
    await this.kinds[kind].delete(id);
  }

  async create<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    opts: { ttlMs?: number } = {},
  ): Promise<boolean> {
    if (kind === 'agentversion') return insertVersion(this, id, value as AgentVersionRecord);
    if (kind !== 'delivery') throw new Error(`Atomic create is not supported for ${kind}`);

    const expiresAt = opts.ttlMs === undefined ? null : date(this.now() + opts.ttlMs);

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

  async take(kind: StoreKind, id: string): Promise<boolean> {
    if (kind === 'delivery') {
      const rows = await this.db
        .delete(chatState)
        .where(
          and(
            eq(chatState.key, stateKey(this.organizationId, kind, id)),
            this.live(chatState.expiresAt),
          ),
        )
        .returning({ key: chatState.key });
      return rows.length > 0;
    }
    const found = await this.get(kind, id);
    if (found === undefined) return false;
    await this.delete(kind, id);
    return true;
  }

  async usageTotals(query: UsageQuery): Promise<UsageTotalRow[]> {
    const u = usage;
    const key =
      query.by === 'agent'
        ? sql`${u.agent}`
        : query.by === 'engine'
          ? sql`coalesce(${u.engine}, 'unknown')`
          : query.by === 'installation'
            ? sql`coalesce(${install.key}, 'none')`
            : sql`to_char(${u.at} at time zone ${timeZone(query.tz)}, 'YYYY-MM-DD')`;
    const range = and(
      this.mine(u.organizationId),
      gte(u.at, date(query.since)),
      query.until === undefined ? undefined : lt(u.at, date(query.until)),
      query.agent ? eq(u.agent, query.agent) : undefined,
    );
    // A row's token usage `total`, else every number in it, however it nests.
    const tokens = sql`coalesce(
      case when jsonb_typeof(${u.tokens} -> 'total') = 'number' then (${u.tokens} ->> 'total')::numeric end,
      (select sum((v #>> '{}')::numeric)
        from jsonb_path_query(coalesce(${u.tokens}, 'null'::jsonb), 'strict $.**') v
        where jsonb_typeof(v) = 'number')
    )`;
    const measure = {
      tasks: sql`count(*)`,
      runnerMs: sql`coalesce(sum(${u.runnerMs}), 0)`,
      tokenCount: sql`coalesce(sum(${tokens}), 0)`,
    };
    // The leading agents come from the same statement, so the report stays one round trip.
    const part = query.top
      ? sql`case when ${u.agent} in (
          select ${u.agent} from ${u} where ${range} group by ${u.agent}
          order by ${measure[query.top.by]} desc, ${u.agent} limit ${query.top.count}
        ) then ${u.agent} end`
      : query.parts?.length
        ? sql`case when ${inArray(u.agent, query.parts)} then ${u.agent} end`
        : sql`null::text`;
    const joined =
      query.by === 'installation'
        ? sql`left join ${install} on ${install.id} = ${u.installationId}`
        : sql``;
    type Row = {
      key: string;
      part: string | null;
      tasks: number;
      runner_ms: number;
      token_count: number;
    };
    const result = (await readQuery(this.db, () =>
      this.db.execute(sql`
      select ${key} as key, ${part} as part, ${measure.tasks}::int as tasks,
        ${measure.runnerMs}::float8 as runner_ms,
        ${measure.tokenCount}::float8 as token_count
      from ${u} ${joined}
      where ${range}
      group by 1, 2
    `),
    )) as unknown as Row[] | { rows: Row[] };
    // postgres.js answers with the rows, PGlite with `{ rows }`.
    const rows = Array.isArray(result) ? result : result.rows;
    const totals = new Map<string, UsageTotalRow>();
    for (const row of rows) {
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
      with expired_state as (
        delete from ${chatState} where expires_at <= clock_timestamp() and key in (
          select key from ${chatState} where expires_at <= clock_timestamp() order by expires_at limit ${batch}
        )
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
