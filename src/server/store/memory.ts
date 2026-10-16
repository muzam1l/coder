import { randomUUID } from 'node:crypto';
import { watchChanges } from '../../utils/fsx';

import type { Batch, Unseen, Conversation, ConversationState } from '../tasks/conversation';
import { SINCE_LIMIT } from '../../core/prompts';
import type { SinceMessage } from '../../integrations/types';
import type {
  StoreListOptions,
  AgentRecord,
  AgentVersionRecord,
  AgentPublication,
  AgentPageOptions,
  DispatchInput,
  DispatchState,
  MetadataKind,
  UsageQuery,
} from './types';
import {
  dropKey,
  heldKey,
  type HeldToken,
  type HeldWrite,
  type TokenDrop,
  type TokenState,
} from './tokens';
import type { AgentApp, Installation } from '../../agent/types';
import type { StoredCredential } from '../settings/credentials';
import { BATCH_LEASE_MS, InstallationBoundError } from './types';
import type { CredentialScope, CredentialWork, DeliveryLease, TaskStatus } from './types';
import type { Store, StoreKind, StoreRecords, LoginPatch, LoginFence } from './types';
import { type EngineLogin } from '../settings/logins';

export function matchesStoreRow(
  id: string,
  value: unknown,
  options: StoreListOptions,
  agent?: string,
): boolean {
  const row = value as {
    agent?: string;
    owner?: string;
    deletedAt?: number;
    app?: string;
    installationId?: string;
    name?: string;
    default?: boolean;
  };
  return (
    (!options.runner || options.runner === id || options.runner === row.name) &&
    (!options.defaults || !!row.default) &&
    (!options.ids || options.ids.includes(id)) &&
    (!options.agent || (agent ?? row.agent) === options.agent) &&
    (!Object.hasOwn(options, 'visibleTo') || !row.owner || row.owner === options.visibleTo) &&
    (!options.active || row.deletedAt === undefined) &&
    (!options.installation || row.installationId === options.installation) &&
    (!options.apps || (!!row.app && options.apps.includes(row.app)))
  );
}

export interface Entry {
  value: unknown;
  expiresAt?: number;
}

/** The lock key of a sealed record's scope: an owner's credentials, one installation, or the runners. */
export const credentialLock = (scope: CredentialScope, id: string) =>
  scope === 'credential'
    ? `credential:${id.slice(0, Math.max(0, id.lastIndexOf('/')))}`
    : scope === 'runner'
      ? 'runners:'
      : `installation:${id}`;

/** Reread the scope, run `work` and write its changes through the store's own puts; the caller holds the lock. */
export async function writeCredentials<K extends CredentialScope>(
  store: Store,
  scope: K,
  id: string,
  work: CredentialWork<K>,
): Promise<boolean> {
  const { parseCredentialId } = await import('../settings/credentials');
  const owner = parseCredentialId(id).owner;
  const rows = (await store.list(scope)).filter(row =>
    scope === 'credential' ? parseCredentialId(row.id).owner === owner : row.id === id,
  );
  const changes = await work(rows.find(row => row.id === id)?.value, rows, store);
  for (const change of changes ?? []) {
    if (change.value === null) await store.delete(scope, change.id);
    else await store.put(scope, change.id, change.value);
  }

  return Boolean(changes?.length);
}

/** Refuse a live installation whose account, or an account it covers, another installation on the same platform client holds; `rows` are every installation. */
export function checkBinding(
  rows: Array<[string, unknown]>,
  id: string,
  value: Installation,
): void {
  if (value.deletedAt !== undefined) return;

  const client = value.app.split('/')[0]!;
  const held = (key: string, row: Installation) => [
    key.slice(row.app.length + 1),
    ...(row.covers ?? []),
  ];
  const accounts = new Set(held(id, value));
  const bound = rows.some(([key, row]) => {
    const other = row as Installation;

    return (
      key !== id &&
      !other.deletedAt &&
      (other.app === client || other.app.startsWith(`${client}/`)) &&
      held(key, other).some(account => accounts.has(account))
    );
  });

  if (bound) throw new InstallationBoundError(`Installation "${id}" is bound through another app.`);
}

export function batchValue(
  current: Batch | undefined,
  owner: string,
  items: unknown[],
  at: number,
): Batch {
  const count = current?.sending?.count ?? 0;
  const pending = [...(current?.items.slice(count) ?? []), ...items];
  const dropped = pending.slice(0, Math.max(0, pending.length - 50));

  return {
    ...current,
    owner,
    at,
    items: [...(current?.items.slice(0, count) ?? []), ...pending.slice(-50)],
    more: (current?.more ?? 0) + dropped.length,
    mustReply:
      current?.mustReply ||
      dropped.some(
        item => (item as { event?: { mustReply?: boolean } })?.event?.mustReply === true,
      ),
  };
}

/** How many reserved items an acknowledgement through `admission` covers; the whole reservation without one. */
function admittedCount(current: Batch, through?: string): number {
  const count = current.sending?.count ?? 0;
  if (through === undefined) return count;
  const index = current.items.findIndex(
    (item, n) => n < count && (item as { admission?: string }).admission === through,
  );

  return index + 1;
}

/** The batch after its sender finished: the admitted prefix gone, the rest released or still reserved. */
export function finishedBatch(
  current: Batch,
  accepted: boolean,
  through: string | undefined,
  now: number,
): Batch {
  const { sending, ...rest } = current;
  const count = accepted ? admittedCount(current, through) : 0;
  if (accepted && sending && count < sending.count)
    return {
      ...current,
      items: current.items.slice(count),
      sending: { ...sending, count: sending.count - count, until: now + BATCH_LEASE_MS },
    };
  const pending = {
    ...rest,
    items: accepted ? current.items.slice(sending?.count ?? 0) : current.items,
    more: (current.more ?? 0) + (accepted ? 0 : (sending?.more ?? 0)),
    mustReply: current.mustReply || (!accepted && sending?.mustReply),
  };

  return accepted ? pending : batchValue(pending, pending.owner, [], pending.at);
}

export function unseenValue(
  current: Unseen | undefined,
  message?: SinceMessage,
  through = 0,
  epoch?: string,
): Unseen {
  const value = current ?? { messages: [], more: 0, epoch: randomUUID() };
  const version = value.version ?? value.messages.length + value.more;
  const messages = value.messages.map((item, index) => ({ sequence: index + 1, ...item }));
  if (message)
    return {
      ...value,
      version: version + 1,
      messages:
        messages.length < SINCE_LIMIT
          ? [...messages, { ...message, sequence: version + 1 }]
          : messages,
      more: value.more + (messages.length < SINCE_LIMIT ? 0 : 1),
    };
  if (value.epoch !== epoch) return value;
  const acknowledged = Math.max(value.acknowledged ?? 0, Math.min(through, version));
  const remaining = messages.filter(item => item.sequence > acknowledged);

  return {
    ...value,
    version,
    acknowledged,
    messages: remaining,
    more: version - acknowledged - remaining.length,
  };
}

export function availableBatch(current: Batch): Batch {
  const { sending, ...rest } = current;

  return batchValue(
    {
      ...rest,
      more: (current.more ?? 0) + (sending?.more ?? 0),
      mustReply: current.mustReply || sending?.mustReply,
    },
    current.owner,
    [],
    current.at,
  );
}

export class MemoryStore implements Store {
  private readonly recordEvents = new EventTarget();

  async watch(kind: 'login' | 'delivery', id: string) {
    const key = `${kind}:${id}`;
    const changes = watchChanges();
    this.recordEvents.addEventListener(key, changes.notify);
    return {
      ...changes,
      close: () => {
        this.recordEvents.removeEventListener(key, changes.notify);
        changes.close();
      },
    };
  }

  private readonly appUpdates = new Map<string, Promise<unknown>>();
  private readonly values = new Map<StoreKind, Map<string, Entry>>();
  private configUpdate?: Promise<unknown>;

  constructor(protected readonly now: () => number = Date.now) {}

  async withAppLock<T>(id: string, work: (store: Store) => Promise<T>): Promise<T> {
    // Memory and local stores share one runner namespace.
    if (id.startsWith('runners:')) id = 'runners:';

    const next = (this.appUpdates.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() => work(this));
    this.appUpdates.set(id, next);
    try {
      return await next;
    } finally {
      if (this.appUpdates.get(id) === next) this.appUpdates.delete(id);
    }
  }

  async withConfigLock<T>(work: (store: Store) => Promise<T>): Promise<T> {
    const pending = (this.configUpdate ?? Promise.resolve()).catch(() => {}).then(() => work(this));
    this.configUpdate = pending;
    try {
      return await pending;
    } finally {
      if (this.configUpdate === pending) delete this.configUpdate;
    }
  }

  withCredential<K extends CredentialScope>(
    scope: K,
    id: string,
    work: CredentialWork<K>,
  ): Promise<boolean> {
    return this.withAppLock(credentialLock(scope, id), () =>
      writeCredentials(this, scope, id, work),
    );
  }

  async listAgentsWithVersions(slug?: string | string[]) {
    const records = Array.isArray(slug)
      ? await this.list('agent', { ids: slug })
      : slug
        ? [{ value: await this.get('agent', slug) }]
        : await this.list('agent');
    return Promise.all(
      records.flatMap(({ value: record }) =>
        record
          ? [
              this.get(
                'agentversion',
                `${record.id}:${String(record.currentVersion).padStart(6, '0')}`,
              ).then(version => ({ record, version })),
            ]
          : [],
      ),
    );
  }

  async listAgentSummaries(options: AgentPageOptions = {}) {
    return (await this.listAgentsWithVersions(options.slug))
      .filter(
        ({ record, version }) =>
          (!options.after || record.id > options.after) &&
          (!options.source || record.source === options.source) &&
          (!options.platform || Boolean(version?.definition.integrations?.[options.platform])) &&
          (!options.q ||
            [record.id, record.name, record.description, record.repo].some(value =>
              value?.toLowerCase().includes(options.q!.toLowerCase()),
            )),
      )
      .slice(0, options.limit)
      .map(({ record, version }) => {
        if (!version) return { record };
        const { systemPrompt, files, ...summary } = version;
        return { record, version: summary };
      });
  }

  async listVersions(slug: string, count?: number, below?: number) {
    const record = await this.get('agent', slug);
    const upper = below ?? (count === undefined ? Infinity : (record?.currentVersion ?? 0) + 1);
    return (await this.list('agentversion', { prefix: `${slug}:` }))
      .filter(
        ({ value }) =>
          value.version < upper && (count === undefined || value.version >= upper - count),
      )
      .map(({ id, value: { systemPrompt, files, ...value } }) => ({ id, value }));
  }

  async publishAgent(record: AgentRecord, version: AgentVersionRecord): Promise<AgentPublication> {
    const { publishVersion } = await import('../agents/records');
    return this.withAppLock(`agent:${record.id}`, async () => {
      const loaded: { record?: AgentRecord; version?: AgentVersionRecord } =
        (await this.listAgentsWithVersions(record.id))[0] ?? {};
      const next = await publishVersion(
        this,
        {
          ...record,
          definition: version.definition,
          systemPrompt: version.systemPrompt,
          files: version.files,
          commit: version.commit,
          origin: version.source,
          importedFrom: version.importedFrom,
        },
        record.updatedAt,
        loaded,
      );
      return {
        record: (await this.get('agent', record.id))!,
        version: next,
        unchanged: next.version === loaded.record?.currentVersion,
      };
    });
  }

  async taskInputs(slug: string, requester?: string, engine?: string) {
    const loaded: { record?: AgentRecord; version?: AgentVersionRecord } =
      (await this.listAgentsWithVersions(slug))[0] ?? {};
    const { resolveCredential } = await import('../settings/credentials');
    const credential = await resolveCredential(
      this,
      engine ?? loaded.record?.settings?.engine ?? loaded.version?.definition.engine,
      requester,
    );
    return { ...loaded, ...(credential ? { credential: credential.id } : {}) };
  }

  async listCredentials(options: { owner?: string; engine?: string; limit?: number }) {
    return (await this.list('credential'))
      .filter(
        ({ value }) =>
          (!value.owner || value.owner === options.owner) &&
          (!options.engine || value.engine === options.engine),
      )
      .slice(0, options.limit);
  }

  async installationApp(id: string) {
    const installation = await this.get('installation', id);
    if (!installation || installation.deletedAt) return;
    const app = await this.get('app', installation.app);
    return app ? { installation, app } : undefined;
  }

  async getApps(keys: string[]) {
    const rows = await Promise.all(
      [...new Set(keys)].map(async id => ({ id, value: await this.get('app', id) })),
    );
    return rows.filter((row): row is { id: string; value: AgentApp } => !!row.value);
  }

  async updateMetadata(kind: MetadataKind, id: string, fields: Record<string, unknown>) {
    const current = await this.get(kind, id);
    if (!current) return false;
    await this.put(kind, id, { ...current, ...fields });
    return true;
  }

  async listHistory(id: string) {
    return (await this.list('history', { prefix: `${id}:` }))
      .map(({ value: { engine, conversation, savedAt } }) => ({ engine, conversation, savedAt }))
      .sort((a, b) => a.savedAt - b.savedAt);
  }

  async conversationState(key: string): Promise<ConversationState> {
    const [record, unseen, batch] = await Promise.all([
      this.get<Conversation>('delivery', key),
      this.get<Unseen>('delivery', `since:${key}`),
      this.get<Batch>('delivery', `batch:${key}`),
    ]);
    const status = record && (await this.get('task', record.taskId));
    return { record, unseen, batch, ...(status?.task.flow === 'default' ? { status } : {}) };
  }

  async markConversation(key: string, taskId: string, seen: string, at: number, ttlMs: number) {
    const record = await this.get<Conversation>('delivery', key);
    if (record?.taskId === taskId)
      await this.put('delivery', key, { ...record, at, seen }, { ttlMs });
  }

  async heldTokens(installations: string[], apps: string[]): Promise<TokenState> {
    const state: TokenState = { held: new Map(), drops: new Map() };
    for (const id of installations)
      for (const row of await this.list<HeldToken>('snapshot', { prefix: heldKey(id) }))
        state.held.set(row.id, row.value);
    for (const id of [...installations, ...apps])
      state.drops.set(dropKey(id), (await this.get<TokenDrop>('snapshot', dropKey(id)))?.drop);

    return state;
  }

  async holdToken(write: HeldWrite): Promise<void> {
    const stands = await Promise.all(
      write.drops.map(
        async drop => (await this.get<TokenDrop>('snapshot', drop.key))?.drop === drop.drop,
      ),
    );
    if (stands.every(Boolean))
      await this.put('snapshot', write.key, write.value, { ttlMs: write.ttlMs });
  }

  saveTaskSecrets(
    taskId: string,
    rows: Array<{ id: string; value: string; expiresAt: number }>,
  ): Promise<boolean> {
    return this.withAppLock(`connections:${taskId}`, async store => {
      const status = await store.get('task', taskId);
      const active = Boolean(
        status && !['completed', 'failed', 'cancelled'].includes(status.status),
      );
      if (active)
        for (const row of rows)
          await store.put(
            'snapshot',
            row.id,
            { secret: row.value, expiresAt: row.expiresAt },
            { ttlMs: Math.max(1, row.expiresAt - this.now()) },
          );

      return active;
    });
  }

  /** Claims the delivery; the rest the dispatch reads itself, as reads cost nothing here. */
  async dispatchState(input: DispatchInput): Promise<DispatchState> {
    const { key, owner, at, ttlMs } = input.delivery;
    // A pending task left by a crash is claimable again once its lease ran out, and keeps its task.
    const existing = this.live('delivery').get(key)?.value as
      { at?: number; owner?: string; pending?: unknown } | undefined;
    const recoverable =
      existing?.pending !== undefined && (!existing.owner || (existing.at ?? 0) + ttlMs <= at);
    if (existing && !recoverable) return { claimed: false };
    await this.put(
      'delivery',
      key,
      { at, owner, pending: existing?.pending ?? true },
      existing?.pending && existing.pending !== true ? {} : { ttlMs },
    );

    return { claimed: true };
  }

  async usageTotals(query: UsageQuery) {
    const { sumUsageTotals } = await import('../tasks/usage');
    return sumUsageTotals(this, query);
  }

  async usageSummary(since: number, by?: import('../tasks/usage').UsageGroup) {
    const { usageSummary } = await import('../tasks/usage');
    return usageSummary(
      (await this.list('usage')).map(row => row.value),
      since,
      by,
    ).totals;
  }

  protected bucket(kind: StoreKind): Map<string, Entry> {
    let bucket = this.values.get(kind);
    if (!bucket) {
      bucket = new Map();
      this.values.set(kind, bucket);
    }
    return bucket;
  }

  protected changed(_kind: StoreKind): void {}

  /** An app on a shared app's credentials reads them from that app. */
  private read(kind: StoreKind, value: unknown): StoreRecords[StoreKind] {
    const app = value as AgentApp;
    if (kind !== 'app' || !app.shared) return value as StoreRecords[StoreKind];
    const shared = this.live('app').get(app.shared)?.value as AgentApp | undefined;

    return { ...app, credentials: shared?.credentials ?? '' };
  }

  private live(kind: StoreKind): Map<string, Entry> {
    const bucket = this.bucket(kind);
    const now = this.now();
    for (const [id, entry] of bucket) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) bucket.delete(id);
    }
    return bucket;
  }

  get<K extends StoreKind>(kind: K, id: string): Promise<StoreRecords[K] | undefined>;
  get<T extends StoreRecords['snapshot']>(kind: 'snapshot', id: string): Promise<T | undefined>;
  get<T extends StoreRecords['delivery']>(kind: 'delivery', id: string): Promise<T | undefined>;
  async get(kind: StoreKind, id: string): Promise<StoreRecords[StoreKind] | undefined> {
    const entry = this.live(kind).get(id);

    return entry && this.read(kind, entry.value);
  }

  async patchLogin(
    id: string,
    fields: LoginPatch,
    expected: LoginFence = {},
  ): Promise<EngineLogin | undefined> {
    const entry = this.live('login').get(id);
    const current = entry?.value as EngineLogin | undefined;
    if (
      !current ||
      !(current.expiresAt > this.now()) ||
      Object.entries(expected).some(([key, value]) =>
        Array.isArray(value)
          ? !value.includes(current[key as keyof EngineLogin] as EngineLogin['state'])
          : current[key as keyof EngineLogin] !== value,
      )
    )
      return undefined;
    const next = { ...current, ...fields };
    if (next.input === null) delete next.input;
    entry!.value = next;
    this.recordEvents.dispatchEvent(new Event(`login:${id}`));
    return next as EngineLogin;
  }

  async completeLogin(
    id: string,
    tokenHash: string,
    label: string,
    credential: StoredCredential,
  ): Promise<boolean> {
    const { completeLogin } = await import('../settings/credentials');
    return completeLogin(this, id, tokenHash, label, credential);
  }

  async put<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    options: { ttlMs?: number; unarchive?: boolean } = {},
  ): Promise<void> {
    if (kind === 'installation')
      checkBinding(
        [...this.live(kind)].map(([key, entry]) => [key, entry.value]),
        id,
        value as Installation,
      );

    const expiresAt = options.ttlMs === undefined ? undefined : this.now() + options.ttlMs;
    const bucket = this.bucket(kind);
    const archivedAt =
      kind === 'task' && !options.unarchive
        ? (bucket.get(id)?.value as TaskStatus | undefined)?.archivedAt
        : undefined;

    bucket.set(id, {
      value:
        archivedAt !== undefined
          ? Object.assign({}, value, { archivedAt })
          : kind === 'app' && (value as AgentApp).shared
            ? { ...(value as AgentApp), credentials: '' }
            : value,
      expiresAt,
    });
    if (kind === 'delivery' || kind === 'login')
      this.recordEvents.dispatchEvent(new Event(`${kind}:${id}`));
    this.changed(kind);
  }

  async putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
    opts: { ttlMs?: number } = {},
  ): Promise<void> {
    if (kind === 'task') {
      await Promise.all(entries.map(entry => this.put(kind, entry.id, entry.value, opts)));
      return;
    }

    const bucket = this.bucket(kind);

    for (const entry of entries)
      bucket.set(entry.id, {
        value: entry.value,
        ...(opts.ttlMs === undefined ? {} : { expiresAt: this.now() + opts.ttlMs }),
      });
    this.changed(kind);
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
  async list(
    kind: StoreKind,
    options: StoreListOptions = {},
  ): Promise<Array<{ id: string; value: StoreRecords[StoreKind] }>> {
    const apps = kind === 'installation' && options.agent ? this.live('app') : undefined;

    return [...this.live(kind).entries()]
      .filter(([id]) => !options.prefix || id.startsWith(options.prefix))
      .filter(([id]) => !options.after || id > options.after)
      .filter(([id, entry]) =>
        matchesStoreRow(
          id,
          entry.value,
          options,
          kind === 'agent'
            ? id
            : (apps?.get((entry.value as Installation).app)?.value as AgentApp | undefined)?.agent,
        ),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit)
      .map(([id, entry]) => ({ id, value: this.read(kind, entry.value) }));
  }

  async delete(kind: StoreKind, id: string): Promise<void> {
    this.bucket(kind).delete(id);
    if (kind === 'login') this.recordEvents.dispatchEvent(new Event(`login:${id}`));
    this.changed(kind);
    for (const child of kind === 'task'
      ? (['history', 'tasklog'] as const)
      : kind === 'agent'
        ? (['agentversion'] as const)
        : []) {
      for (const key of this.bucket(child).keys())
        if (key.startsWith(`${id}:`)) this.bucket(child).delete(key);
      this.changed(child);
    }
  }

  async create<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    options: { ttlMs?: number } = {},
  ): Promise<boolean> {
    const bucket = this.live(kind);
    if (bucket.has(id)) return false;

    const expiresAt = options.ttlMs === undefined ? undefined : this.now() + options.ttlMs;

    bucket.set(id, { value, expiresAt });
    this.changed(kind);

    return true;
  }

  async claimDeliveryLease(id: string, owner: string, ttlMs: number): Promise<number | undefined> {
    const bucket = this.live('delivery');
    if (bucket.has(id)) return undefined;
    const failures =
      (this.live('snapshot').get(`delivery:${id}`)?.value as DeliveryLease | undefined)?.failures ??
      0;
    bucket.set(id, { value: { owner, failures }, expiresAt: this.now() + ttlMs });
    this.changed('delivery');
    return failures;
  }

  async updateDeliveryLease(
    id: string,
    owner: string,
    value?: DeliveryLease,
    opts = { ttlMs: 30_000 },
  ): Promise<boolean> {
    const bucket = this.live('delivery');
    if ((bucket.get(id)?.value as DeliveryLease | undefined)?.owner !== owner) return false;
    if (!value) {
      bucket.delete(id);
      this.bucket('snapshot').delete(`delivery:${id}`);
    } else {
      const next = value.next === undefined ? value : { ...value, next: this.now() + opts.ttlMs };
      bucket.set(id, { value: next, expiresAt: this.now() + opts.ttlMs });
      if (value.next !== undefined)
        this.bucket('snapshot').set(`delivery:${id}`, {
          value: next,
          expiresAt: this.now() + 86_400_000,
        });
    }
    this.changed('delivery');
    this.changed('snapshot');
    return true;
  }

  async updateDelivery<T>(
    id: string,
    owner: string,
    value: T | undefined,
    opts: { ttlMs?: number } = {},
  ): Promise<boolean> {
    const bucket = this.live('delivery');
    if ((bucket.get(id)?.value as { owner?: string } | undefined)?.owner !== owner) return false;
    if (value === undefined) bucket.delete(id);
    else
      bucket.set(id, {
        value,
        ...(opts.ttlMs === undefined ? {} : { expiresAt: this.now() + opts.ttlMs }),
      });
    this.changed('delivery');
    return true;
  }

  async appendUnseen(key: string, message: SinceMessage, ttlMs: number): Promise<void> {
    const bucket = this.live('delivery');
    if (!bucket.has(key)) return;
    const id = `since:${key}`;
    const current = bucket.get(id)?.value as Unseen | undefined;
    bucket.set(id, { value: unseenValue(current, message), expiresAt: this.now() + ttlMs });
    this.changed('delivery');
  }

  async acknowledgeUnseen(key: string, through: number, epoch?: string): Promise<void> {
    const entry = this.live('delivery').get(`since:${key}`);
    if (!entry) return;
    entry.value = unseenValue(entry.value as Unseen, undefined, through, epoch);
    this.changed('delivery');
  }

  async appendBatch(
    id: string,
    owner: string,
    items: unknown[],
    at: number,
    ttlMs: number,
  ): Promise<void> {
    const entry = this.live('delivery').get(id);
    const current = entry?.value as Batch | undefined;
    const next = batchValue(current, owner, items, at);
    const expiresAt = this.now() + ttlMs;
    this.bucket('delivery').set(id, { value: next, expiresAt });
    this.changed('delivery');
  }

  async claimBatch(id: string, owner: string): Promise<Batch | null | undefined> {
    return this.withAppLock(`batch:${id}`, async () => {
      const entry = this.live('delivery').get(id);
      let current = entry?.value as Batch | undefined;
      if (current?.owner !== owner || !current.items.length) return undefined;
      if (current.sending && (current.sending.until ?? 0) > this.now()) return null;
      if (current.sending) current = availableBatch(current);
      const next = {
        ...current,
        more: 0,
        mustReply: false,
        sending: {
          owner,
          until: this.now() + BATCH_LEASE_MS,
          count: current.items.length,
          more: current.more,
          mustReply: current.mustReply,
        },
      };
      const expiresAt = entry!.expiresAt;
      this.bucket('delivery').set(id, { value: next, expiresAt });
      this.changed('delivery');

      return current;
    });
  }

  async finishBatch(
    id: string,
    owner: string,
    accepted: boolean,
    through?: string,
  ): Promise<boolean> {
    const entry = this.live('delivery').get(id);
    const current = entry?.value as Batch | undefined;
    if (current?.sending?.owner !== owner) return false;
    const next = finishedBatch(current, accepted, through, this.now());
    this.bucket('delivery').set(id, { value: next, expiresAt: entry!.expiresAt });
    this.changed('delivery');

    return true;
  }

  async take<K extends StoreKind>(
    kind: K,
    id: string,
    expected?: Partial<StoreRecords[K]>,
  ): Promise<StoreRecords[K] | undefined> {
    const bucket = this.live(kind);
    const entry = bucket.get(id);
    if (
      !entry ||
      Object.entries(expected ?? {}).some(
        ([key, value]) => (entry.value as Record<string, unknown>)[key] !== value,
      )
    )
      return undefined;
    bucket.delete(id);
    this.changed(kind);

    return this.read(kind, entry.value) as StoreRecords[K];
  }
}
