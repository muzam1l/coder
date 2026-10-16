/** A local server's records in the CLI's own home: apps, installations and runners in `apps.json`, connections and API key credentials with their secrets in the keychain, deliveries under `state/global`. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { LocalConnections } from '../../core/connections';
import { coderHome, resolveStateDir, resolveRunnerUsageFile } from '../../core/state';
import {
  checkBinding,
  credentialLock,
  matchesStoreRow,
  MemoryStore,
  writeCredentials,
  type Entry,
} from './memory';
import type {
  CredentialScope,
  CredentialWork,
  Store,
  StoreKind,
  StoreRecords,
  StoreListOptions,
} from './types';
import { loadAgents } from '../../agent/load';
import type { AgentApp, Installation } from '../../agent/types';
import type { Integration } from '../../integrations/types';
import type { AgentRecord, AgentVersionRecord } from './types';
import { agentWithVersion, diskFiles, listAgents, versionKey } from '../agents/records';

type Records = Partial<Record<'app' | 'installation' | 'runner', Record<string, unknown>>>;
type Deliveries = Record<string, { value: unknown; expiresAt?: number }>;

const APPS = new Set<StoreKind>(['app', 'installation', 'runner']);
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

export class LocalStore extends MemoryStore {
  private readonly revisions = new Map<StoreKind, string>();
  private readonly logBuckets = new Map<string, Map<string, Entry>>();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(
    now: () => number = Date.now,
    private readonly connections = () => new LocalConnections(),
  ) {
    super(now);
  }

  withAppLock<T>(id: string, work: (store: Store) => Promise<T>): Promise<T> {
    if (id.startsWith('connection:') || id.startsWith('connection-import:'))
      return this.connections().withLock(() => work(this), id.replace(/^connection:/, ''));
    return super.withAppLock(id, work);
  }

  withConfigLock<T>(work: (store: Store) => Promise<T>): Promise<T> {
    return super.withConfigLock(work);
  }

  withCredential<K extends CredentialScope>(
    scope: K,
    id: string,
    work: CredentialWork<K>,
  ): Promise<boolean> {
    const write = () => writeCredentials(this, scope, id, work);

    return scope === 'credential'
      ? this.connections().withLock(write, credentialLock(scope, id))
      : super.withAppLock(credentialLock(scope, id), write);
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

  protected bucket(kind: StoreKind): Map<string, Entry> {
    const bucket = super.bucket(kind);
    if (APPS.has(kind) || KEYCHAIN.has(kind) || DERIVED.has(kind) || kind === 'tasklog')
      return bucket;
    const file = this.recordsFile(kind);
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    const revision = stat ? `${stat.ino}:${stat.mtimeMs}:${stat.size}` : '';
    if (this.revisions.get(kind) !== revision) {
      for (const id of bucket.keys())
        if (kind !== 'snapshot' || !id.startsWith('connection')) bucket.delete(id);
      for (const [id, entry] of Object.entries(readJson<Deliveries>(file, {})))
        bucket.set(id, entry);
      this.revisions.set(kind, revision);
    }
    return bucket;
  }

  protected changed(kind: StoreKind): void {
    if (!APPS.has(kind) && !KEYCHAIN.has(kind) && !DERIVED.has(kind) && kind !== 'tasklog')
      writeAtomic(
        this.recordsFile(kind),
        `${JSON.stringify(Object.fromEntries([...this.bucket(kind)].filter(([id]) => kind !== 'snapshot' || !id.startsWith('connection'))))}\n`,
      );
  }

  private logFile(id: string): string {
    return path.join(resolveStateDir(''), 'runner', 'logs', `${encodeURIComponent(id)}.jsonl`);
  }

  private loadLog(id: string): Map<string, Entry> {
    let bucket = this.logBuckets.get(id);
    if (bucket) return bucket;
    bucket = new Map();
    try {
      const text = fs.readFileSync(this.logFile(id), 'utf8');
      for (const line of text.split('\n').filter(Boolean)) {
        const { id, ...entry } = JSON.parse(line) as Entry & { id: string };
        bucket.set(id, entry);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.logBuckets.set(id, bucket);

    return bucket;
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
    if (kind === 'tasklog') {
      const entry = this.loadLog(id.slice(0, id.lastIndexOf(':'))).get(id);
      return entry && (entry.expiresAt === undefined || entry.expiresAt > this.now())
        ? (entry.value as StoreRecords['tasklog'])
        : undefined;
    }
    if (!APPS.has(kind) && !KEYCHAIN.has(kind)) return super.get(kind, id);

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
    options: { ttlMs?: number; unarchive?: boolean } = {},
  ): Promise<void> {
    if (kind === 'tasklog') return this.putMany(kind, [{ id, value }], options);
    if (!APPS.has(kind) && !KEYCHAIN.has(kind)) return super.put(kind, id, value, options);

    await this.serial(() => this.write(kind, id, value), KEYCHAIN.has(kind));
  }

  private write(kind: StoreKind, id: string, value: unknown): void {
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
    return false;
  }

  async putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
    opts: { ttlMs?: number } = {},
  ): Promise<void> {
    if (kind === 'tasklog') {
      const files = new Map<string, string[]>();
      for (const { id, value } of entries) {
        const task = id.slice(0, id.lastIndexOf(':'));
        const lines = files.get(task) ?? [];
        lines.push(
          JSON.stringify({
            id,
            value,
            ...(opts.ttlMs === undefined ? {} : { expiresAt: this.now() + opts.ttlMs }),
          }),
        );
        files.set(task, lines);
      }
      for (const [task, lines] of files) {
        const file = this.logFile(task);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.appendFileSync(file, `${lines.join('\n')}\n`, { mode: 0o600 });
      }
      for (const { id, value } of entries)
        this.loadLog(id.slice(0, id.lastIndexOf(':'))).set(id, {
          value,
          ...(opts.ttlMs === undefined ? {} : { expiresAt: this.now() + opts.ttlMs }),
        });
    } else if (!APPS.has(kind) && !KEYCHAIN.has(kind)) await super.putMany(kind, entries, opts);
    else for (const entry of entries) await this.put(kind, entry.id, entry.value, opts);
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
    if (kind === 'tasklog') {
      const task = options.prefix?.endsWith(':') ? options.prefix.slice(0, -1) : undefined;
      if (task !== undefined) this.loadLog(task);
      else {
        const dir = path.dirname(this.logFile(''));
        if (fs.existsSync(dir))
          for (const name of fs.readdirSync(dir))
            if (name.endsWith('.jsonl')) this.loadLog(decodeURIComponent(name.slice(0, -6)));
      }
      const buckets = task !== undefined ? [this.loadLog(task)] : [...this.logBuckets.values()];
      return buckets
        .flatMap(bucket => [...bucket])
        .filter(
          ([id, entry]) =>
            (!options.prefix || id.startsWith(options.prefix)) &&
            (!options.after || id > options.after) &&
            (entry.expiresAt === undefined || entry.expiresAt > this.now()),
        )
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(0, options.limit)
        .map(([id, entry]) => ({ id, value: entry.value as StoreRecords['tasklog'] }));
    }
    if (!APPS.has(kind) && !KEYCHAIN.has(kind)) return super.list(kind, options);

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
    if (kind === 'tasklog') {
      const task = id.slice(0, id.lastIndexOf(':'));
      const bucket = this.loadLog(task);
      bucket.delete(id);
      writeAtomic(
        this.logFile(task),
        [...bucket].map(([id, entry]) => JSON.stringify({ id, ...entry })).join('\n') + '\n',
      );
      return;
    }
    if (!APPS.has(kind) && !KEYCHAIN.has(kind)) {
      await super.delete(kind, id);
      if (kind === 'task') {
        fs.rmSync(this.logFile(id), { force: true });
        this.logBuckets.delete(id);
      }
      return;
    }
    await this.serial(() => this.remove(kind, id), KEYCHAIN.has(kind));
  }

  async create<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    options: { ttlMs?: number } = {},
  ): Promise<boolean> {
    if (kind === 'tasklog')
      return this.serial(async () => {
        if (await this.get(kind, id)) return false;
        await this.put(kind, id, value, options);
        return true;
      });
    if (!APPS.has(kind) && !KEYCHAIN.has(kind)) return super.create(kind, id, value, options);

    return this.serial(() => {
      if (this.entries(kind).some(([key]) => key === id)) return false;
      this.write(kind, id, value);
      return true;
    }, KEYCHAIN.has(kind));
  }

  async take<K extends StoreKind>(
    kind: K,
    id: string,
    expected?: Partial<StoreRecords[K]>,
  ): Promise<StoreRecords[K] | undefined> {
    if (!APPS.has(kind) && !KEYCHAIN.has(kind) && kind !== 'tasklog')
      return super.take(kind, id, expected);
    return this.serial(async () => {
      const value = await this.get(kind, id);
      if (
        value === undefined ||
        Object.entries(expected ?? {}).some(
          ([key, entry]) => (value as Record<string, unknown>)[key] !== entry,
        )
      )
        return;
      if (kind === 'tasklog') await this.delete(kind, id);
      else this.remove(kind, id);
      return value;
    }, KEYCHAIN.has(kind));
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
