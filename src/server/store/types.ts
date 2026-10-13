import type { UsageGroup, UsageTotals } from '../tasks/usage';
import type {
  AgentDefinition,
  AgentTask,
  AgentUsage,
  AgentApp,
  Connection,
  Installation,
} from '../../agent/types';
import type { AuditRow, TaskTurn } from '../../client/types';
import { type EngineLogin } from '../settings/logins';
import type { StoredCredential } from '../settings/credentials';
import type { StoredConfig } from '../settings/config';
import type { InboxEntry } from '../tasks/queue';
import type { LocalCompletion, LocalStart } from '../tasks/local';
import type { SessionBinding, PendingHandoff } from '../tasks/events';
import { type PairingRecord } from '../settings/runners';
import type { SnapshotState } from '../runners/vercel-sandbox';
import type { RepoFile, RepoPush } from '../agents/repo';
import type { HeldToken, TokenDrop } from '../tasks/context';

export interface StoreRecords {
  agent: AgentRecord;
  agentversion: AgentVersionRecord;
  app: AgentApp;
  installation: Installation;
  note: string;
  credential: StoredCredential;
  login: EngineLogin;
  runner: RunnerRecord;
  snapshot:
    | { connectionSecrets: string; expiresAt?: number }
    | { resolvedConnections: string; expiresAt?: number }
    | SnapshotState
    | PairingRecord
    | LocalStart
    | LocalCompletion
    | SessionBinding
    | DeliveryLease
    | AuditRow
    | RepoFile
    | RepoPush
    | HeldToken
    | TokenDrop;
  task: TaskStatus;
  tasklog: Omit<TaskLogLine, 'seq'>;
  inbox: InboxEntry;
  delivery: DeliveryRecord;
  usage: UsageRecord;
  config: StoredConfig;
  connection: Connection;
}

export type StoreKind = keyof StoreRecords;

export type DeliveryRecord =
  | (DeliveryLease & { pending?: never })
  | {
      at?: number;
      /** What a browser transaction is bound to. */
      target?: string;
      owner?: string;
      pid?: number;
      posted?: boolean;
      session?: SessionBinding;
      pending?:
        | boolean
        | PendingHandoff
        | { task?: AgentTask; inbox?: { taskId: string; id: string; entry: InboxEntry } };
    }
  | { version: number; definition: unknown; pending: boolean; error?: string };

export interface UsageQuery {
  by: 'agent' | 'installation' | 'engine' | 'day';
  since: number;
  /** Exclusive upper bound. */
  until?: number;
  agent?: string;
  /** IANA time zone the `day` keys are counted in. */
  tz?: string;
  /** Agents broken out of each row as `parts`. */
  parts?: string[];
  /** Instead of `parts`, the leading agents by this measure, broken out the same way. */
  top?: { count: number; by: keyof UsageAmount };
}

export interface UsageAmount {
  tasks: number;
  runnerMs: number;
  /** Every number in the recorded token usage, summed. */
  tokenCount: number;
}

export interface UsageTotalRow extends UsageAmount {
  key: string;
  deleted?: true;
  parts?: Record<string, UsageAmount>;
}

export type MetadataKind = 'app' | 'installation' | 'runner';

/** Another live app on the same platform client (`<app>` or `<app>/<id>`) already holds this installation's account. */
export class InstallationBoundError extends Error {}

export type AgentVersionSummary = Omit<AgentVersionRecord, 'systemPrompt' | 'files'>;
export type LoginPatch = Partial<
  Pick<EngineLogin, 'state' | 'handle' | 'url' | 'code' | 'error' | 'label'>
> & { input?: string | null };
export type LoginFence = Partial<Pick<EngineLogin, 'input' | 'tokenHash' | 'owner'>> & {
  state?: EngineLogin['state'] | EngineLogin['state'][];
};
/** Sealed records: credentials lock their owner's namespace, installations their row, runners their group. */
export type CredentialScope = 'credential' | 'installation' | 'runner';
export type CredentialChange<K extends CredentialScope> = {
  id: string;
  value: StoreRecords[K] | null;
};
export type CredentialWork<K extends CredentialScope> = (
  current: StoreRecords[K] | undefined,
  rows: Array<{ id: string; value: StoreRecords[K] }>,
  store: Store,
) => Promise<CredentialChange<K>[] | undefined>;
export interface AgentPageOptions {
  slug?: string;
  after?: string;
  source?: AgentRecord['source'];
  q?: string;
  platform?: string;
  limit?: number;
}
export interface DeliveryLease {
  owner: string;
  failures: number;
  next?: number;
}

export interface StoreListOptions {
  prefix?: string;
  after?: string;
  limit?: number;
  ids?: string[];
  agent?: string;
  visibleTo?: string;
  active?: boolean;
  apps?: string[];
  installation?: string;
  runner?: string;
  defaults?: boolean;
  secrets?: 'oauth' | 'all';
}

export interface Store {
  connectionContexts?: Map<
    string,
    Awaited<ReturnType<typeof import('../connections/resolve').resolveConnections>>
  >;
  connectionSecrets?: Map<string, string[]>;
  localFlows?: Map<string, { stop(): Promise<void>; work: Promise<void> }>;
  completionWatches?: Map<string, { stopped: boolean; work: Promise<void> }>;
  handoffs?: Map<string, Promise<unknown>>;
  withAppLock<T>(id: string, work: (store: Store) => Promise<T>): Promise<T>;
  withConfigLock<T>(work: (store: Store) => Promise<T>): Promise<T>;
  /** The one write path for sealed records: `work` sees the scope reread under its lock and its changes land atomically; true when anything was written. */
  withCredential<K extends CredentialScope>(
    scope: K,
    id: string,
    work: CredentialWork<K>,
  ): Promise<boolean>;
  publishAgent?(record: AgentRecord, version: AgentVersionRecord): Promise<AgentPublication>;
  completeLogin(
    id: string,
    tokenHash: string,
    label: string,
    credential: import('../settings/credentials').StoredCredential,
  ): Promise<boolean>;
  patchLogin(
    id: string,
    fields: LoginPatch,
    expected?: LoginFence,
  ): Promise<EngineLogin | undefined>;
  taskInputs?(
    slug: string,
    requester?: string,
    engine?: string,
  ): Promise<{ record?: AgentRecord; version?: AgentVersionRecord; credential?: string }>;
  getApps?(keys: string[]): Promise<Array<{ id: string; value: AgentApp }>>;
  listCredentials?(options: {
    owner?: string;
    engine?: string;
    limit?: number;
  }): Promise<Array<{ id: string; value: import('../settings/credentials').StoredCredential }>>;
  listAgentSummaries?(
    options?: AgentPageOptions,
  ): Promise<Array<{ record: AgentRecord; version?: AgentVersionSummary }>>;
  updateMetadata?(
    kind: MetadataKind,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<boolean>;
  get<K extends StoreKind>(kind: K, id: string): Promise<StoreRecords[K] | undefined>;
  // Snapshot and delivery keys hold distinct shapes; reads may select the key's shape.
  get<T extends StoreRecords['snapshot']>(kind: 'snapshot', id: string): Promise<T | undefined>;
  get<T extends StoreRecords['delivery']>(kind: 'delivery', id: string): Promise<T | undefined>;
  // The credential lane owns the remaining explicit read arguments.
  get<T extends StoredCredential>(
    kind: 'credential',
    id: string,
  ): Promise<StoredCredential | undefined>;
  get<T extends EngineLogin>(kind: 'login', id: string): Promise<EngineLogin | undefined>;
  /** A task's archivedAt survives a put unless `unarchive` replaces it. */
  put<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    opts?: { ttlMs?: number; unarchive?: boolean },
  ): Promise<void>;
  putMany<K extends StoreKind>(
    kind: K,
    entries: Array<{ id: string; value: StoreRecords[K] }>,
  ): Promise<void>;
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
  list<T extends StoredCredential>(
    kind: 'credential',
    options?: StoreListOptions,
  ): Promise<Array<{ id: string; value: StoredCredential }>>;
  list<T extends AgentApp>(
    kind: 'app',
    options?: StoreListOptions,
  ): Promise<Array<{ id: string; value: AgentApp }>>;
  list<T extends Installation>(
    kind: 'installation',
    options?: StoreListOptions,
  ): Promise<Array<{ id: string; value: Installation }>>;
  list<T extends RunnerRecord>(
    kind: 'runner',
    options?: StoreListOptions,
  ): Promise<Array<{ id: string; value: RunnerRecord }>>;
  delete(kind: StoreKind, id: string): Promise<void>;
  /** Atomically insert only when no live entry exists. */
  create<K extends StoreKind>(
    kind: K,
    id: string,
    value: StoreRecords[K],
    opts?: { ttlMs?: number },
  ): Promise<boolean>;
  /** Atomically remove a live entry, returning whether it existed. */
  take(kind: StoreKind, id: string): Promise<boolean>;
  claimDeliveryLease(id: string, owner: string, ttlMs: number): Promise<number | undefined>;
  updateDeliveryLease(
    id: string,
    owner: string,
    value?: DeliveryLease,
    opts?: { ttlMs: number },
  ): Promise<boolean>;
  /** Update or release a delivery only while its lease belongs to this owner. */
  updateDelivery<T>(
    id: string,
    owner: string,
    value: T | undefined,
    opts?: { ttlMs?: number },
  ): Promise<boolean>;
  /** Every agent, or one, with its current version in one read. */
  listAgentsWithVersions?(
    slug?: string,
  ): Promise<Array<{ record: AgentRecord; version?: AgentVersionRecord }>>;
  /** One agent's newest `count` versions below `below`, or below its next version, in one read. */
  listVersions?(
    slug: string,
    count?: number,
    below?: number,
  ): Promise<Array<{ id: string; value: AgentVersionSummary }>>;
  /** Usage summed in the database; stores without it are summed from `list("usage")`. */
  usageTotals?(query: UsageQuery): Promise<UsageTotalRow[]>;
  usageSummary?(since: number, by?: UsageGroup): Promise<UsageTotals['totals']>;
}

export interface AgentPublication {
  record: AgentRecord;
  version: AgentVersionRecord;
  unchanged: boolean;
}

export interface AgentRecord {
  id: string;
  name: string;
  description?: string;
  source: 'repo' | 'home' | 'upload' | 'builtin';
  repo?: string;
  path?: string;
  currentVersion: number;
  settings?: AgentUsage;
  /** A local server's agent: read from its folder, with no version history. */
  local?: true;
  /** The last commit of a local agent's folder. */
  commit?: string;
  createdAt: number;
  updatedAt: number;
}

export interface AgentVersionRecord {
  agent: string;
  version: number;
  definition: AgentDefinition;
  systemPrompt: string;
  files?: Record<string, string>;
  commit?: string;
  /** Where a repository import read this version. */
  source?: { repo: string; ref: string; commit: string };
  importedFrom: string;
  createdAt: number;
}

export type ServerAgent = AgentRecord & {
  definition?: AgentVersionRecord['definition'];
};

export type AgentDetail = AgentRecord & {
  versions: Array<Omit<AgentVersionRecord, 'systemPrompt' | 'files'>>;
};

export type PushResult = { id: string; version: number; unchanged: boolean };

export interface TaskOutcome {
  ok: boolean;
  exitCode: number | null;
  output: string;
  /** `git diff` of the checkout when the task ran on a repo. */
  diff?: string;
}

export type TaskState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

/** A task's record: the queue row while it waits, the outcome afterwards. */
export interface TaskStatus {
  task: AgentTask;
  status: TaskState;
  /** Times the worker picked it up; a runner crash earns one retry. */
  attempts: number;
  generation?: number;
  inboxSeq?: number;
  inboxAck?: { generation: number; seq: number };
  result?: TaskOutcome;
  error?: string;
  tokens?: unknown;
  /** Included by admin task responses; the secret remains in the runner context only. */
  credential?: string;
  /** Opaque runner-owned identifier. Never accepted from an HTTP caller. */
  handle?: string;
  /** SHA-256 of the current attempt's bearer token. */
  tokenHash?: string;
  /** Latest authenticated callback from the current attempt. */
  lastSeenAt?: number;
  /** Persisted runner/log cursors survive a warm-process or serverless restart. */
  logCursor?: number;
  logSeq?: number;
  logBytes?: number;
  logsPulledAt?: number;
  logsComplete?: boolean;
  archivedAt?: number;
  /** Archived by the auto-archive sweep, which lists take up on their next read rather than as an event. */
  autoArchived?: true;
  approval?: unknown;
  /** Ask-sidecar answers in arrival order. */
  answer?: unknown[];
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** Set by a cancel request while the task runs; the worker stops it at the next check. */
  cancelRequestedAt?: number;
  updatedAt: number;
  /** A read-only row for a task the CLI ran on this machine. */
  local?: true;
  turns?: TaskTurn[];
  fallbacks?: import('../../core/types').Task['fallbacks'];
}

/** One line of a task's output, streamed by the runner while it runs. */
export interface TaskLogLine {
  seq: number;
  at: number;
  /** `out` and `err` from the runner, `sys` from the worker (retries, timeouts). */
  level: 'out' | 'err' | 'sys';
  line: string;
  entry?: import('../../core/state').TaskLogEntry;
}

export interface EngineCredential {
  engine: 'claude' | 'codex' | 'custom';
  env: Record<string, string>;
}

export interface UsageRecord {
  installationId?: string;
  taskId: string;
  agent: string;
  target: string;
  engine?: string;
  model?: string;
  credential: string;
  runnerElapsedMs: number;
  tokens?: unknown;
  at: number;
}

export interface RunnerRecord {
  kind: import('../../client/types').RunnerKind;
  name: string;
  scope: 'personal' | 'workspace';
  owner?: string;
  config: Record<string, string>;
  secret: string;
  createdBy?: string;
  default: boolean;
  lastSeen?: number;
  createdAt: number;
  updatedAt: number;
}
