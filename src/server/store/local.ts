/** A local server's records in the CLI's own home: apps, installations and runners in `apps.json`, notes and deliveries under `state/global`. */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

import { coderHome, resolveStateDir, resolveRunnerUsageFile } from '../../core/state';
import { credentialLock, MemoryStore, writeCredentials } from './memory';
import type {
  CredentialScope,
  CredentialWork,
  DeliveryLease,
  Store,
  StoreKind,
  StoreRecords,
} from './types';
import { loadAgents } from '../../agent/load';
import type { Integration } from '../../integrations/types';
import type { AgentRecord, AgentVersionRecord } from './types';
import { agentWithVersion, diskFiles, listAgents, versionKey } from '../agents/records';

type Records = Partial<Record<'app' | 'installation' | 'runner', Record<string, unknown>>>;
type Deliveries = Record<string, { value: unknown; expiresAt?: number }>;

const APPS = new Set<StoreKind>(['app', 'installation', 'runner']);
const QUEUED = new Set<StoreKind>(['task', 'tasklog', 'inbox', 'usage']);
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
  private readonly derived = new MemoryStore();
  private writes: Promise<unknown> = Promise.resolve();

  constructor(private readonly now: () => number = Date.now) {}

  withAppLock<T>(id: string, work: (store: Store) => Promise<T>): Promise<T> {
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
    return this.derived.withAppLock(credentialLock(scope, id), () =>
      writeCredentials(this, scope, id, work),
    );
  }

  private get appsFile() {
    return coderHome('apps.json');
  }

  private get deliveriesFile() {
    return path.join(resolveStateDir(''), 'deliveries.json');
  }

  private get notesDir() {
    return path.join(resolveStateDir(''), 'notes');
  }

  private noteFile(id: string) {
    return path.join(this.notesDir, `${encodeURIComponent(id)}.md`);
  }

  /** One write at a time inside this process; the server is the only writer of these files. */
  private serial<T>(work: () => T): Promise<T> {
    const next = this.writes.then(work);
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
    if (APPS.has(kind)) return Object.entries(this.apps()[kind as keyof Records] ?? {});
    if (kind === 'delivery' || kind === 'snapshot' || QUEUED.has(kind))
      return Object.entries(this.deliveries(kind)).map(([id, entry]) => [id, entry.value]);
    if (kind === 'note') {
      let names: string[] = [];
      try {
        names = fs.readdirSync(this.notesDir).filter(name => name.endsWith('.md'));
      } catch {}
      return names.map(name => [
        decodeURIComponent(name.slice(0, -3)),
        fs.readFileSync(path.join(this.notesDir, name), 'utf8'),
      ]);
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
    if (DERIVED.has(kind)) return this.derived.get(kind, id);
    if (kind === 'note') {
      try {
        return fs.readFileSync(this.noteFile(id), 'utf8');
      } catch {
        return undefined;
      }
    }

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

    await this.serial(() => this.write(kind, id, value, options.ttlMs));
  }

  private write(kind: StoreKind, id: string, value: unknown, ttlMs?: number): void {
    if (APPS.has(kind)) {
      const records = this.apps();
      records[kind as keyof Records] = { ...records[kind as keyof Records], [id]: value };
      writeAtomic(this.appsFile, `${JSON.stringify(records, null, 2)}\n`);
    } else if (kind === 'delivery' || kind === 'snapshot' || QUEUED.has(kind)) {
      const deliveries = this.deliveries(kind);
      deliveries[id] = { value, ...(ttlMs === undefined ? {} : { expiresAt: this.now() + ttlMs }) };
      writeAtomic(this.recordsFile(kind), `${JSON.stringify(deliveries)}\n`);
    } else if (kind === 'note') writeAtomic(this.noteFile(id), String(value));
    else this.refuse(kind);
  }

  private remove(kind: StoreKind, id: string): boolean {
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
      return true;
    }
    if (kind === 'note') {
      const file = this.noteFile(id);
      const found = fs.existsSync(file);
      fs.rmSync(file, { force: true });
      return found;
    }
    return false;
  }

  async putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
  ): Promise<void> {
    for (const entry of entries) await this.put(kind, entry.id, entry.value);
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
    if (DERIVED.has(kind)) return this.derived.list(kind, options);

    return this.entries(kind)
      .filter(
        ([id]) =>
          (!options.prefix || id.startsWith(options.prefix)) &&
          (!options.after || id > options.after),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, options.limit)
      .map(([id, value]) => ({ id, value: value as StoreRecords[StoreKind] }));
  }

  async delete(kind: StoreKind, id: string): Promise<void> {
    if (DERIVED.has(kind)) return this.derived.delete(kind, id);
    await this.serial(() => this.remove(kind, id));
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
    });
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

  async take(kind: StoreKind, id: string): Promise<boolean> {
    if (DERIVED.has(kind)) return this.derived.take(kind, id);
    return this.serial(() => this.remove(kind, id));
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
  const agents = await loadAgents(cwd, integrations);
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
  const existing = (await loadAgents(cwd, integrations)).find(
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
  const existing = (await loadAgents(cwd, integrations)).find(
    agent => agent.id === id && !agent.builtin,
  );
  if (!existing?.dir) throw new Error(`No local agent named "${id}".`);
  if (path.resolve(existing.dir) !== coderHome('agents', id)) return false;
  fs.rmSync(existing.dir, { recursive: true });
  return true;
}
