import type { SerializedMessage, SerializedThread } from 'chat';
import type { TaskLogEntry } from '../core/task/log-view';

export type TaskState = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export interface TaskRow {
  task: {
    id: string;
    name?: string;
    source: 'dashboard' | 'cli' | 'schedule' | (string & {});
    agent: string;
    flow?: string;
    prompt?: string;
    cwd?: string;
    event?: {
      integration: string;
      type: string;
      text?: string;
      thread?: { number?: number };
    };
  };
  status: TaskState;
  statusReason?: string;
  attempts: number;
  credential?: string;
  result?: { ok?: boolean; output?: string; diff?: string } | string;
  error?: string;
  approval?: unknown;
  answer?: unknown[];
  archivedAt?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  /** A task the CLI runs on this machine, listed beside the server's. */
  local?: boolean;
  /** The first lines of its log, when read one task at a time. */
  logs?: TaskLog[];
  turns?: TaskTurn[];
  fallbacks?: Array<{ engine: string; detail: string; next: string }>;
}

export interface TaskLog {
  seq: number;
  at: number;
  level: 'out' | 'err' | 'sys';
  line: string;
  entry?: TaskLogEntry;
}

/** The parts of `agent.json` the dashboard shows or edits against. */
export interface AgentDefinition {
  name?: string;
  description?: string;
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  integrations?: Record<string, { triggers?: string[] | Record<string, unknown>; tools?: unknown }>;
}

/** Organization overrides for one agent (`AgentUsage` on the server). */
export interface AgentSettings {
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  /** A registered runner id; unset follows the requester's default. */
  runner?: string;
  integrations?: Record<string, { allowedTools?: string | string[]; allowedEvents?: string[] }>;
}

export interface AgentRow {
  id: string;
  name: string;
  description?: string;
  source: string;
  repo?: string;
  path?: string;
  /** Browser address of the tracked folder, for repository agents. */
  sourceUrl?: string;
  currentVersion: number;
  /** A local server's agent, which keeps no versions; `commit` is its folder's last commit. */
  local?: true;
  commit?: string;
  updatedAt?: number;
  definition?: AgentDefinition;
  systemPrompt?: string;
  files?: Record<string, string>;
  settings?: AgentSettings;
  versions?: VersionRow[];
}

/** What an agent can listen to and do on an integration. */
export interface IntegrationInfo {
  id: string;
  name: string;
  brand: { color: string; icon: string; dark?: string; svg?: string };
  description: string;
  installLabel: string;
  organizationApps: boolean;
  events: Record<string, { description: string; noisy?: true; addressed?: true }>;
  presets: Record<string, string[]>;
  repositories?: boolean;
}

export interface CredentialRow {
  label: string;
  engine: 'claude' | 'codex' | 'custom';
  scope: 'personal' | 'workspace';
  isDefault?: boolean;
  createdAt?: number;
  env: string[];
  masked: string;
  account?: { email?: string; plan?: string };
}

/** Each engine CLI's own login on this machine. */
export type EngineStatus = Partial<
  Record<'claude' | 'codex', { signedIn: boolean; command: string }>
>;

export interface VersionRow {
  version: number;
  createdAt: number;
  importedFrom?: string;
  commit?: string;
}

export interface UsageAmount {
  tasks: number;
  runnerMs: number;
  tokenCount: number;
}

export interface UsageTotal extends UsageAmount {
  key: string;
  deleted?: true;
  parts?: Record<string, UsageAmount>;
}

export interface UsagePage {
  items: UsageTotal[];
  next?: string;
  summary: UsageAmount & { agents: number };
}

export interface TaskCounts {
  all: number;
  active: number;
  waiting: number;
}

export interface TasksPage {
  items: TaskRow[];
  next?: string;
  counts?: TaskCounts;
}

export type Reach = 'installed' | 'created' | 'none';

export interface AgentCardRow extends AgentRow {
  platforms: Array<{ id: string; state: Reach }>;
}

export interface AppRow {
  id: string;
  integration: string;
  agent: string;
  name: string;
  builtin?: boolean;
  agentsRepo?: string;
  branch?: string;
  createdAt: number;
}

export interface InstallationRow {
  id: string;
  app: string;
  integration: string;
  account: { login: string; type?: string };
  deletedAt?: number;
  settings?: {
    configRepo?: string;
    model?: string;
    engine?: string;
    effort?: string;
  };
  createdAt: number;
}

export interface StoredRow<T> {
  id: string;
  value: T;
}

export interface Me {
  mode?: 'local' | 'memory' | 'cloud';
  user?: { id?: string; name: string; email: string };
  organization?: {
    id: string;
    name?: string;
    slug?: string;
    role?: string;
  };
  organizations?: Array<{
    id: string;
    name: string;
    slug: string;
    role: string;
  }>;
  manageMembersUrl?: string;
  server?: {
    name: string;
    store: 'memory' | 'postgres';
    url?: string;
    subscriptions?: { claude: boolean; codex: boolean };
  };
}

export interface Paged<T> {
  items: T[];
  next?: string;
}
export interface PageQuery {
  cursor?: string;
  limit?: number;
}
export interface AgentQuery extends PageQuery {
  q?: string;
  platform?: string;
  type?: string;
  connect?: boolean;
}
export interface TaskQuery extends PageQuery {
  status?: string;
  archived?: boolean;
  summary?: boolean;
  counts?: boolean;
  agent?: string;
  source?: string;
  q?: string;
}
export type EngineEntry = {
  model?: string;
  effort?: string;
  permissions?: string;
};
export type ModelEntry = {
  provider?: string;
  baseUrl?: string;
  model?: string;
  envKey?: string;
  effort?: string;
  disabled?: boolean;
};
export type McpEntry = {
  command?: string;
  args?: string[];
  url?: string;
  type?: string;
  description?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
};
export type Config = {
  chain?: string[];
  engines?: Record<string, EngineEntry | undefined>;
  models?: Record<string, ModelEntry>;
  mcp?: Record<string, McpEntry>;
  approvals?: { escalationTimeoutMs?: number; allowedNetworkHosts?: string[] };
};
export type RunnerKind = 'local' | 'local-docker' | 'vercel-sandbox' | 'github-actions' | 'http';
export interface RunnerSpec {
  kind: RunnerKind;
  name: string;
  description: string;
  connect: 'pair' | 'fields';
  /** One or two sentences on what this kind needs and where to get it. */
  help?: string;
  fields: Array<{
    key: string;
    label: string;
    secret?: boolean;
    placeholder?: string;
    optional?: boolean;
    hint?: string;
  }>;
  available: boolean;
  reason?: string;
}
export interface RunnerRow {
  id: string;
  kind: RunnerKind;
  name: string;
  scope: 'personal' | 'workspace';
  default: boolean;
  online: boolean;
  lastSeen?: number;
  config: Record<string, string>;
  createdAt: number;
}
export interface RunnerPairing {
  token: string;
  expiresAt: number;
  command: string;
}
export interface RunnerInput {
  kind: RunnerKind;
  name: string;
  scope: RunnerRow['scope'];
  config: Record<string, string>;
}
export interface RunnerUpdate {
  name?: string;
  default?: true;
  config?: Record<string, string>;
}
export interface RunnerTest {
  ok: boolean;
  detail: string;
  ms: number;
}

export type ConfigShape = { config: Config; effective: Config };
export type MergePatch<T> = T extends unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: MergePatch<NonNullable<T[K]>> | null }
    : T;
export type ConfigPatch = MergePatch<Config>;
export type ModelsShape = {
  builtin: Record<string, Record<string, string>>;
  models: Record<string, ModelEntry>;
};
export interface ProbeResult {
  reachable: boolean;
  modelListed: boolean | null;
  /** Model ids the endpoint lists, or null when it has no list. */
  models: string[] | null;
  detail: string;
}
export type McpRows = Record<string, McpEntry>;
export type RegistryInput = {
  name: string;
  label?: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  secret: boolean;
};
export type Found = {
  name: string;
  title: string;
  description: string;
  type: string;
  command?: string;
  args?: string[];
  argumentInputs?: RegistryInput[];
  url?: string;
  env: RegistryInput[];
  headers: RegistryInput[];
};
export type UsageQuery = PageQuery & {
  since?: number;
  until?: number;
  by?: 'agent' | 'installation' | 'engine' | 'day';
  agent?: string;
  tz?: string;
  parts?: string[];
  top?: number;
  sort?: string;
  q?: string;
};
export type UsageReport = {
  since: number;
  until?: number;
  totals: UsageTotal[];
  top?: string[];
};

export interface LocalFolder {
  path: string;
  name: string;
  recent?: number;
  /** The git URL a cloned checkout came from. */
  url?: string;
}

export interface LocalFolders {
  current: LocalFolder;
  recent: LocalFolder[];
  /** The machine can open its own folder dialog. */
  picker: boolean;
}

export type TaskInput = {
  cwd?: string;
  outputSchema?: object;
  source?: 'cli' | 'dashboard';
  prompt?: string;
  repo?: string;
  pr?: number;
  agent?: string;
  flow?: string;
  args?: Record<string, unknown>;
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  runner?: string;
  mcp?: string[];
};
export type ImportAgent = {
  id: string;
  name: string;
  description?: string;
  version?: number;
  commit?: string;
  taken?: boolean;
};

export interface AgentEvent {
  integration: string;
  /** Catalog name, e.g. `pull_request` or `mention`. */
  type: string;
  /** `AgentApp.id` the webhook was addressed to. */
  appId: string;
  installationId: string;
  deliveryId: string;
  actor: { id: string; login?: string; role?: string; agent?: boolean };
  /** Human text attached to the event: mention body, comment, PR title + body. */
  text: string;
  /** What the platform tells an agent about where the event happened, such as a Linear issue; bounded. */
  promptContext?: string;
  /** The Chat SDK thread and message it happened in, without raw platform payloads; replies go to this thread. */
  chat?: { thread: SerializedThread; message?: SerializedMessage };
  repo?: {
    owner: string;
    name: string;
    cloneUrl: string;
    ref: string;
    defaultBranch: string;
  };
}

export interface ClientTypes {
  agent: AgentRow;
  detail: AgentRow;
  version: VersionRow & {
    definition: AgentDefinition;
    systemPrompt: string;
    files?: Record<string, string>;
  };
  record: AgentRow;
  task: TaskRow;
  credential: CredentialRow;
  login: {
    id: string;
    engine: 'claude' | 'codex';
    state: 'starting' | 'open' | 'verifying' | 'done' | 'failed';
    expiresAt: number;
    url?: string;
    code?: string;
    error?: string;
    label?: string;
  };
  runner: RunnerRow;
  usage: {
    since: number;
    totals:
      | Array<{
          key: string;
          tasks: number;
          runnerMs: number;
          tokens?: unknown;
        }>
      | Record<
          'agent' | 'installation' | 'engine',
          Array<{
            key: string;
            tasks: number;
            runnerMs: number;
            tokens?: unknown;
          }>
        >;
  };
  event: AgentEvent;
  usageRow: {
    agent: string;
    installationId?: string;
    engine?: string;
    runnerElapsedMs: number;
    tokens?: unknown;
  };
}
export type PushResult = { id: string; version: number; unchanged: boolean };

export interface TaskTurn {
  prompt: string;
  result?: { ok?: boolean; output?: string; diff?: string } | string;
  error?: string;
  finishedAt?: number;
  /** First log sequence after this turn. */
  logSeq?: number;
}
