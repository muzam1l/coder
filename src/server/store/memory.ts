import { completeLogin, parseCredentialId, type StoredCredential } from '../settings/credentials';
import type { CredentialScope, CredentialWork, DeliveryLease, TaskStatus } from './types';
import type { Store, StoreKind, StoreRecords, LoginPatch, LoginFence } from './types';
import { type EngineLogin } from '../settings/logins';

interface Entry {
  value: unknown;
  expiresAt?: number;
}

/** The lock key of a sealed record's scope: an owner's credentials, one installation, or the runners. */
export const credentialLock = (scope: CredentialScope, id: string) =>
  scope === 'credential'
    ? `credential:${parseCredentialId(id).owner ?? ''}`
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

export class MemoryStore implements Store {
  private readonly appUpdates = new Map<string, Promise<unknown>>();
  private readonly values = new Map<StoreKind, Map<string, Entry>>();
  private configUpdate?: Promise<unknown>;

  constructor(private readonly now: () => number = Date.now) {}

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

  private bucket(kind: StoreKind): Map<string, Entry> {
    let bucket = this.values.get(kind);
    if (!bucket) {
      bucket = new Map();
      this.values.set(kind, bucket);
    }
    return bucket;
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
    return this.live(kind).get(id)?.value as StoreRecords[StoreKind] | undefined;
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
    return next as EngineLogin;
  }

  completeLogin(
    id: string,
    tokenHash: string,
    label: string,
    credential: StoredCredential,
  ): Promise<boolean> {
    return completeLogin(this, id, tokenHash, label, credential);
  }

  async put<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    options: { ttlMs?: number; unarchive?: boolean } = {},
  ): Promise<void> {
    const expiresAt = options.ttlMs === undefined ? undefined : this.now() + options.ttlMs;
    const bucket = this.bucket(kind);
    const archivedAt =
      kind === 'task' && !options.unarchive
        ? (bucket.get(id)?.value as TaskStatus | undefined)?.archivedAt
        : undefined;

    bucket.set(id, {
      value: archivedAt === undefined ? value : Object.assign({}, value, { archivedAt }),
      expiresAt,
    });
  }

  async putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
  ): Promise<void> {
    if (kind === 'task') {
      await Promise.all(entries.map(entry => this.put(kind, entry.id, entry.value)));
      return;
    }

    const bucket = this.bucket(kind);

    for (const entry of entries) bucket.set(entry.id, { value: entry.value });
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
    options: { prefix?: string; after?: string; limit?: number } = {},
  ): Promise<Array<{ id: string; value: StoreRecords[StoreKind] }>> {
    return [...this.live(kind).entries()]
      .filter(([id]) => !options.prefix || id.startsWith(options.prefix))
      .filter(([id]) => !options.after || id > options.after)
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit)
      .map(([id, entry]) => ({ id, value: entry.value as StoreRecords[StoreKind] }));
  }

  async delete(kind: StoreKind, id: string): Promise<void> {
    this.bucket(kind).delete(id);
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

    return true;
  }

  async claimDeliveryLease(id: string, owner: string, ttlMs: number): Promise<number | undefined> {
    const bucket = this.live('delivery');
    if (bucket.has(id)) return undefined;
    const failures =
      (this.live('snapshot').get(`delivery:${id}`)?.value as DeliveryLease | undefined)?.failures ??
      0;
    bucket.set(id, { value: { owner, failures }, expiresAt: this.now() + ttlMs });
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
    return true;
  }

  async take(kind: StoreKind, id: string): Promise<boolean> {
    const bucket = this.live(kind);
    const found = bucket.has(id);
    if (found) bucket.delete(id);
    return found;
  }
}
