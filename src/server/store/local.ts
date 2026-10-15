/** A local server's records in the CLI's own home: apps, installations and runners in `apps.json`, connections and API key credentials with their secrets in the keychain, deliveries under `state/global`. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { LocalConnections } from '../../core/connections';
import { coderHome, resolveStateDir, resolveRunnerUsageFile } from '../../core/state';
import {
  checkBinding,
  batchValue,
  availableBatch,
  finishedBatch,
  unseenValue,
  credentialLock,
  matchesStoreRow,
  MemoryStore,
  writeCredentials,
} from './memory';
import { BATCH_LEASE_MS, type Batch, type Unseen } from '../tasks/conversation';
import type {
  CredentialScope,
  CredentialWork,
  DeliveryLease,
  Store,
  StoreKind,
  StoreRecords,
  StoreListOptions,
} from './types';
import { loadAgents } from '../../agent/load';
import type { AgentApp, Installation } from '../../agent/types';
import type { Integration, SinceMessage } from '../../integrations/types';
import type { AgentRecord, AgentVersionRecord } from './types';
import { agentWithVersion, diskFiles, listAgents, versionKey } from '../agents/records';

type Records = Partial<Record<'app' | 'installation' | 'runner', Record<string, unknown>>>;
type Deliveries = Record<string, { value: unknown; expiresAt?: number }>;

const APPS = new Set<StoreKind>(['app', 'installation', 'runner']);
const QUEUED = new Set<StoreKind>(['task', 'history', 'tasklog', 'inbox', 'usage']);
const KEYCHAIN = new Set<StoreKind>(['connection', 'credential']);
// Rebuilt from agent folders and CLI tasks on each request, never the only copy.
const DERIVED = new Set<StoreKind>(['agent', 'agentversion']);

function readJson<T>(file: string, empty: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw error;
  }
}

function writeAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temp, content, { mode: 0o600 });
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

export class LocalStore implements Store {
  connectionContexts?: Store['connectionContexts'];
  connectionSecrets?: Store['connectionSecrets'];
  private readonly derived = new MemoryStore();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly connections = () => new LocalConnections(),
  ) {}

  withAppLock<T>(id: string, work: (store: Store) => Promise<T>): Promise<T> {
    if (id.startsWith('connection:') || id.startsWith('connection-import:'))
      return this.connections().withLock(() => work(this), id.replace(/^connection:/, ''));
    return this.derived.withAppLock(id, () => work(this));
  }

  withConfigLock<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return this.derived.withConfigLock(() => work(this));
  }

  withCredential<K extends CredentialScope>(
    scope: K,
    id: string,
    work: CredentialWork<K>,
  ): Promise<boolean> {
    const write = () => writeCredentials(this, scope, id, work);

    return scope === 'credential'
      ? this.connections().withLock(write, credentialLock(scope, id))
      : this.derived.withAppLock(credentialLock(scope, id), write);
  }

  private get appsFile() {
    return coderHome('apps.json');
  }

  private get deliveriesFile() {
    return path.join(resolveStateDir(''), 'deliveries.json');
  }

  /** One write at a time inside this process; the server is the only writer of these files. */
  private serial<T>(work: () => T, connection = false): Promise<T> {
    const next = this.writes.then(() =>
      connection ? this.connections().withLock(async () => work()) : work(),
    );
    this.writes = next.catch(() => {});
    return next;
  }

  private apps(): Records {
    return readJson<Records>(this.appsFile, {});
  }

  private recordsFile(kind: StoreKind): string {
    if (kind === 'delivery') return this.deliveriesFile;
    if (kind === 'usage') return resolveRunnerUsageFile();
    if (kind === 'snapshot') return path.join(resolveStateDir(''), 'snapshots.json');
    return path.join(resolveStateDir(''), 'runner', `${kind}.json`);
  }

  private deliveries(kind: StoreKind = 'delivery'): Deliveries {
    const now = this.now();
    return Object.fromEntries(
      Object.entries(readJson<Deliveries>(this.recordsFile(kind), {})).filter(
        ([, entry]) => entry.expiresAt === undefined || entry.expiresAt > now,
      ),
    );
  }

  private entries(kind: StoreKind): Array<[string, unknown]> {
    if (kind === 'connection') {
      const local = this.connections();
      return local.list().map(record => [record.id, record]);
    }
    if (kind === 'credential')
      return this.connections()
        .credentials()
        .map(row => [row.id, row.value]);
    if (APPS.has(kind)) {
      const records = this.apps();
      const rows = Object.entries(records[kind as keyof Records] ?? {});
      if (kind !== 'app') return rows;

      // An app on a shared app's credentials reads them from that app.
      return rows.map(([id, value]) => {
        const app = value as AgentApp;
        const shared = app.shared ? (records.app?.[app.shared] as AgentApp | undefined) : undefined;

        return [id, app.shared ? { ...app, credentials: shared?.credentials ?? '' } : app];
      });
    }
    if (kind === 'delivery' || kind === 'snapshot' || QUEUED.has(kind))
      return Object.entries(this.deliveries(kind)).map(([id, entry]) => [id, entry.value]);
    return [];
  }

  private refuse(kind: StoreKind): never {
    throw new Error(`A local server keeps no ${kind} records`);
  }

  get<K extends StoreKind>(kind: K, id: string): Promise<StoreRecords[K] | undefined>;
  get<T extends StoreRecords['snapshot']>(kind: 'snapshot', id: string): Promise<T | undefined>;
  get<T extends StoreRecords['delivery']>(kind: 'delivery', id: string): Promise<T | undefined>;
  async get(kind: StoreKind, id: string): Promise<StoreRecords[StoreKind] | undefined> {
    if (kind === 'connection') return this.connections().get(id);
    if (DERIVED.has(kind)) return this.derived.get(kind, id);

    return this.entries(kind).find(([key]) => key === id)?.[1] as
      StoreRecords[StoreKind] | undefined;
  }

  async completeLogin(): Promise<boolean> {
    return this.refuse('login');
  }

  async patchLogin(): Promise<undefined> {
    return this.refuse('login');
  }

  async put<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    options: { ttlMs?: number } = {},
  ): Promise<void> {
    if (DERIVED.has(kind)) return this.derived.put(kind, id, value, options);

    await this.serial(() => this.write(kind, id, value, options.ttlMs), KEYCHAIN.has(kind));
  }

  private write(kind: StoreKind, id: string, value: unknown, ttlMs?: number): void {
    if (kind === 'connection') {
      this.connections().put(value as StoreRecords['connection']);
      return;
    }
    // Only API key connections keep credentials here; engines use this machine's own sign-in.
    if (kind === 'credential' && (value as StoreRecords['credential']).engine === 'custom') {
      this.connections().putCredential(id, value as StoreRecords['credential']);
      return;
    }
    if (APPS.has(kind)) {
      const records = this.apps();
      if (kind === 'installation')
        checkBinding(Object.entries(records.installation ?? {}), id, value as Installation);
      // An app on a shared app's credentials keeps no copy of them.
      if (kind === 'app' && (value as AgentApp).shared)
        value = { ...(value as AgentApp), credentials: '' };
      records[kind as keyof Records] = { ...records[kind as keyof Records], [id]: value };
      writeAtomic(this.appsFile, `${JSON.stringify(records, null, 2)}\n`);
    } else if (kind === 'delivery' || kind === 'snapshot' || QUEUED.has(kind)) {
      const deliveries = this.deliveries(kind);
      deliveries[id] = { value, ...(ttlMs === undefined ? {} : { expiresAt: this.now() + ttlMs }) };
      writeAtomic(this.recordsFile(kind), `${JSON.stringify(deliveries)}\n`);
    } else this.refuse(kind);
  }

  private remove(kind: StoreKind, id: string): boolean {
    if (kind === 'connection') {
      const local = this.connections();
      const found = !!local.get(id);
      local.delete(id);
      return found;
    }
    if (kind === 'credential') {
      const local = this.connections();
      const found = local.credentials().some(row => row.id === id);
      local.deleteCredential(id);
      return found;
    }
    if (APPS.has(kind)) {
      const records = this.apps();
      const bucket = records[kind as keyof Records];
      if (!bucket || !(id in bucket)) return false;
      delete bucket[id];
      writeAtomic(this.appsFile, `${JSON.stringify(records, null, 2)}\n`);
      return true;
    }
    if (kind === 'delivery' || kind === 'snapshot' || QUEUED.has(kind)) {
      const deliveries = this.deliveries(kind);
      if (!(id in deliveries)) return false;
      delete deliveries[id];
      writeAtomic(this.recordsFile(kind), `${JSON.stringify(deliveries)}\n`);
      if (kind === 'task') {
        const histories = this.deliveries('history');
        for (const key of Object.keys(histories))
          if (key.startsWith(`${id}:`)) delete histories[key];
        writeAtomic(this.recordsFile('history'), `${JSON.stringify(histories)}\n`);
      }
      return true;
    }
    return false;
  }

  async putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
    opts: { ttlMs?: number } = {},
  ): Promise<void> {
    for (const entry of entries) await this.put(kind, entry.id, entry.value, opts);
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
    if (DERIVED.has(kind)) return this.derived.list(kind, options);

    const apps = kind === 'installation' && options.agent ? this.apps().app : undefined;

    return this.entries(kind)
      .filter(
        ([id]) =>
          (!options.prefix || id.startsWith(options.prefix)) &&
          (!options.after || id > options.after),
      )
      .filter(([id, value]) =>
        matchesStoreRow(
          id,
          value,
          options,
          (apps?.[(value as Installation).app] as AgentApp | undefined)?.agent,
        ),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit)
      .map(([id, value]) => {
        const connection = value as StoreRecords['connection'];
        const full =
          kind === 'connection' &&
          options.secrets &&
          (options.secrets === 'all' ||
            (connection.provider === 'mcp' && connection.auth === 'oauth'))
            ? this.connections().get(id)
            : undefined;
        return { id, value: (full ?? value) as StoreRecords[StoreKind] };
      });
  }

  async delete(kind: StoreKind, id: string): Promise<void> {
    if (DERIVED.has(kind)) return this.derived.delete(kind, id);
    await this.serial(() => this.remove(kind, id), KEYCHAIN.has(kind));
  }

  async create<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    options: { ttlMs?: number } = {},
  ): Promise<boolean> {
    if (DERIVED.has(kind)) return this.derived.create(kind, id, value, options);

    return this.serial(() => {
      if (this.entries(kind).some(([key]) => key === id)) return false;
      this.write(kind, id, value, options.ttlMs);
      return true;
    }, KEYCHAIN.has(kind));
  }

  claimDeliveryLease(id: string, owner: string, ttlMs: number): Promise<number | undefined> {
    return this.serial(() => {
      if (this.deliveries()[id]) return undefined;
      const failures =
        (this.deliveries('snapshot')[`delivery:${id}`]?.value as DeliveryLease | undefined)
          ?.failures ?? 0;
      this.write('delivery', id, { owner, failures }, ttlMs);
      return failures;
    });
  }

  updateDeliveryLease(
    id: string,
    owner: string,
    value?: DeliveryLease,
    opts = { ttlMs: 30_000 },
  ): Promise<boolean> {
    return this.serial(() => {
      if ((this.deliveries()[id]?.value as DeliveryLease | undefined)?.owner !== owner)
        return false;
      if (!value) {
        this.remove('delivery', id);
        this.remove('snapshot', `delivery:${id}`);
      } else {
        const next = value.next === undefined ? value : { ...value, next: this.now() + opts.ttlMs };
        this.write('delivery', id, next, opts.ttlMs);
        if (value.next !== undefined) this.write('snapshot', `delivery:${id}`, next, 86_400_000);
      }
      return true;
    });
  }

  async updateDelivery<T>(
    id: string,
    owner: string,
    value: T | undefined,
    opts: { ttlMs?: number } = {},
  ): Promise<boolean> {
    return this.serial(() => {
      const receipt = this.entries('delivery').find(([key]) => key === id)?.[1] as
        { owner?: string } | undefined;
      if (receipt?.owner !== owner) return false;
      if (value === undefined) this.remove('delivery', id);
      else this.write('delivery', id, value, opts.ttlMs);
      return true;
    });
  }

  async appendUnseen(key: string, message: SinceMessage, ttlMs: number): Promise<void> {
    return this.serial(() => {
      const entries = this.deliveries();
      if (!entries[key]) return;
      const id = `since:${key}`;
      this.write(
        'delivery',
        id,
        unseenValue(entries[id]?.value as Unseen | undefined, message),
        ttlMs,
      );
    });
  }

  async acknowledgeUnseen(key: string, through: number, epoch?: string): Promise<void> {
    return this.serial(() => {
      const id = `since:${key}`;
      const entry = this.deliveries()[id];
      if (!entry) return;
      this.write(
        'delivery',
        id,
        unseenValue(entry.value as Unseen, undefined, through, epoch),
        entry.expiresAt === undefined ? undefined : entry.expiresAt - this.now(),
      );
    });
  }

  async appendBatch(
    id: string,
    owner: string,
    items: unknown[],
    at: number,
    ttlMs: number,
  ): Promise<void> {
    return this.serial(() => {
      const entry = this.deliveries()[id];
      const current = entry?.value as Batch | undefined;
      const next = batchValue(current, owner, items, at);
      const expiresAt = this.now() + ttlMs;
      this.write(
        'delivery',
        id,
        next,
        expiresAt === undefined ? undefined : expiresAt - this.now(),
      );
    });
  }

  async claimBatch(id: string, owner: string): Promise<Batch | null | undefined> {
    return this.withAppLock(`batch:${id}`, () =>
      this.serial(() => {
        const entry = this.deliveries()[id];
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
        this.write(
          'delivery',
          id,
          next,
          expiresAt === undefined ? undefined : expiresAt - this.now(),
        );
        return current;
      }),
    );
  }

  async finishBatch(
    id: string,
    owner: string,
    accepted: boolean,
    through?: string,
  ): Promise<boolean> {
    return this.serial(() => {
      const entry = this.deliveries()[id];
      const current = entry?.value as Batch | undefined;
      if (current?.sending?.owner !== owner) return false;
      const next = finishedBatch(current, accepted, through, this.now());
      const expiresAt = entry!.expiresAt;
      this.write(
        'delivery',
        id,
        next,
        expiresAt === undefined ? undefined : expiresAt - this.now(),
      );

      return true;
    });
  }

  async take(kind: StoreKind, id: string): Promise<boolean> {
    if (DERIVED.has(kind)) return this.derived.take(kind, id);
    return this.serial(() => this.remove(kind, id), KEYCHAIN.has(kind));
  }
}

/** The last commit that touched `dir`, when it is tracked in a git repo. */
function folderCommit(dir: string): Promise<string | undefined> {
  let root = path.resolve(dir);
  while (!fs.existsSync(path.join(root, '.git'))) {
    const parent = path.dirname(root);
    if (parent === root) return Promise.resolve(undefined);
    root = parent;
  }
  return new Promise(resolve =>
    execFile('git', ['log', '-1', '--format=%H', '--', '.'], { cwd: dir }, (error, stdout) =>
      resolve(error ? undefined : stdout.trim() || undefined),
    ),
  );
}

/** A local server's agents are the CLI's folders with their `agents.<id>` settings, and keep no version history. */
export async function syncLocalAgents(
  store: Store,
  cwd: string,
  integrations: Record<string, Integration>,
  slug?: string,
): Promise<Array<{ record: AgentRecord; version?: AgentVersionRecord }>> {
  const agents = await loadAgents(cwd, integrations, { includeDisabled: true });
  const loaded = await Promise.all(
    agents
      .filter(agent => !slug || agent.id === slug)
      .map(async agent => {
        const settings = agent.usage ? { settings: agent.usage } : {};
        if (agent.builtin) {
          const { record: existing, version } = await agentWithVersion(store, agent.id);
          if (!existing) return undefined;
          const record: AgentRecord = {
            ...existing,
            settings: undefined,
            ...settings,
            local: true,
          };
          await store.put('agent', agent.id, record);
          return { record, version };
        }
        if (!agent.dir) return undefined;
        const commit = await folderCommit(agent.dir);
        const stat = fs.statSync(path.join(agent.dir, 'agent.json'));
        const systemFile = path.join(agent.dir, 'system.md');
        const version: AgentVersionRecord = {
          agent: agent.id,
          version: 1,
          definition: agent.definition,
          systemPrompt: fs.existsSync(systemFile) ? fs.readFileSync(systemFile, 'utf8') : '',
          files: diskFiles(agent.dir),
          ...(commit ? { commit } : {}),
          importedFrom: `local:${agent.dir}`,
          createdAt: stat.mtimeMs,
        };
        const record: AgentRecord = {
          id: agent.id,
          name: agent.name,
          ...(agent.definition.description ? { description: agent.definition.description } : {}),
          source: path.resolve(agent.dir) === coderHome('agents', agent.id) ? 'home' : 'repo',
          path: agent.dir,
          currentVersion: 1,
          ...settings,
          local: true,
          ...(commit ? { commit } : {}),
          createdAt: stat.birthtimeMs || stat.mtimeMs,
          updatedAt: stat.mtimeMs,
        };
        await store.put('agentversion', versionKey(agent.id, 1), version);
        await store.put('agent', agent.id, record);
        return { record, version };
      }),
  );
  if (!slug) {
    const present = new Set(agents.map(agent => agent.id));
    for (const record of await listAgents(store))
      if (record.local && record.path && !present.has(record.id))
        await store.delete('agent', record.id);
  }
  return loaded
    .filter(
      (entry): entry is { record: AgentRecord; version: AgentVersionRecord | undefined } => !!entry,
    )
    .sort((a, b) => (a.record.id < b.record.id ? -1 : a.record.id > b.record.id ? 1 : 0));
}

/** Save a dashboard edit where the CLI reads it: the agent's own folder, or `$CODER_HOME/agents/<id>` for a new one. */
export async function writeLocalAgent(
  cwd: string,
  integrations: Record<string, Integration>,
  id: string,
  body: { definition: unknown; systemPrompt: string; files?: Record<string, string> },
): Promise<void> {
  const existing = (await loadAgents(cwd, integrations, { includeDisabled: true })).find(
    agent => agent.id === id && !agent.builtin,
  );
  const dir = existing?.dir ?? coderHome('agents', id);
  const files = {
    ...body.files,
    'agent.json': `${JSON.stringify(body.definition, null, 2)}\n`,
    'system.md': body.systemPrompt,
  };
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), content);
  }
}

/** Remove an agent's `$CODER_HOME/agents/<id>` folder; false when it lives anywhere else, such as a repo. */
export async function deleteLocalAgent(
  cwd: string,
  integrations: Record<string, Integration>,
  id: string,
): Promise<boolean> {
  const existing = (await loadAgents(cwd, integrations, { includeDisabled: true })).find(
    agent => agent.id === id && !agent.builtin,
  );
  if (!existing?.dir) throw new Error(`No local agent named "${id}".`);
  if (path.resolve(existing.dir) !== coderHome('agents', id)) return false;
  fs.rmSync(existing.dir, { recursive: true });
  return true;
}
