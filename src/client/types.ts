import type { SerializedMessage, SerializedThread } from 'chat';
import type { TaskLogEntry } from '../core/task/view';
import type { Access, Approval } from '../core/types';
import type { AgentUsage } from '../agent/types';
import type {
  AppDrift,
  CreateStep,
  IntegrationErrorCode,
  PlatformPost,
} from '../integrations/types';

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
    access?: 'auto' | 'read-only';
    requestedBy?: string;
    /** The task that started this one. */
    parent?: string;
    /** The Coder account behind the event's actor, when they connected it. */
    context?: { user?: { name: string; email?: string } };
    event?: {
      integration: string;
      type: string;
      text?: string;
      actor?: { id: string; login?: string };
      mustReply?: boolean;
      thread?: { number?: number };
    };
    /** The agent's engine settings, and what this task ran with over them. */
    definition?: { model?: string };
    usage?: { engine?: string; model?: string; effort?: string };
  };
  status: TaskState;
  statusReason?: string;
  attempts: number;
  credential?: string;
  result?: { ok?: boolean; output?: string; diff?: string } | string;
  error?: string;
  approval?: Approval;
  /** Every escalation of the task, answers included. */
  approvals?: Approval[];
  answer?: unknown[];
  archivedAt?: number;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
  /** When it last did anything, its latest turn included. */
  lastActivityAt?: number;
  /** How long its latest turn ran. */
  lastTurnMs?: number;
  /** The model it runs with: its own pick, else its engine's default. */
  model?: string;
  /** A task the CLI runs on this machine, listed beside the server's. */
  local?: boolean;
  /** The first lines of its log, when read one task at a time. */
  logs?: TaskLog[];
  turns?: TaskTurn[];
  fallbacks?: Array<{ model: string; detail: string; next: string }>;
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
  model?: string;
  access?: Access;
  integrations?: Record<string, { events?: string[] | Record<string, unknown> }>;
}

/** Organization overrides for one agent (`AgentUsage` on the server). */
export interface AgentSettings extends Pick<
  AgentUsage,
  'runner' | 'appendSystem' | 'access' | 'integrations' | 'connections' | 'skills' | 'disabled'
> {
  engine?: string;
  model?: string;
  effort?: string;
}

export interface AgentRow {
  id: string;
  name: string;
  description?: string;
  source: string;
  /** The agent a task runs when it names none. */
  default?: true;
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
  /** The names it answers to, one per app that wakes on mentions, with the platform's display name. */
  handles?: Array<{ name: string; integration: string; platform: string }>;
  /** Where its apps are installed: the platform, the account and the app's name. */
  installations?: Array<{ integration: string; account: string; app: string }>;
  /** Platform events it failed to handle in the last day, with the newest; absent when none. */
  deliveries?: { failed: number; recent: FailedDeliveryRow[] };
  /** The model it runs first for the caller, by name, and where its list runs for them. */
  model?: string;
  runsOn?: string;
  /** Nothing can run any of its models for the caller: no credential of theirs or the workspace's, no sign-in on this machine. */
  needsModel?: true;
  /** Engines, and custom models as `custom/<name>`, that no workspace credential runs, so an agent on them answers only members whose own credential does. */
  unrunnable?: string[];
  /** Why its definition is invalid; it answers no events until fixed. */
  problems?: string[];
  /** Keys its definition has that Coder renamed, with their new name, or no longer reads. */
  stale?: { renamed?: Record<string, string>; unknown?: string[] };
}

/** A platform event Coder failed to handle. */
export interface FailedDeliveryRow {
  at: number;
  platform: string;
  type?: string;
  error: string;
  /** The thread or issue it came from. */
  url?: string;
}

/** What an agent can listen to and do on an integration. */
export interface IntegrationInfo {
  id: string;
  name: string;
  brand: { color: string; icon: string; dark?: string; svg?: string };
  description: string;
  installLabel: string;
  /** How people reach an installed agent there, `{handle}` standing for its handle. */
  use?: string;
  /** What one account an installation covers is called. */
  covered?: string;
  /** Listed first among an agent's handles. */
  featured?: true;
  /** Built-in agents install the server's shared app, or create their own like any agent. */
  builtinApp: 'shared' | 'own';
  /** Members can connect their own account here, for tasks that act as them. */
  personal?: true;
  /** A connection can sign in here with OAuth now: the integration has user OAuth and an app to sign in through. */
  connectable?: true;
  organizationApps: boolean;
  /** Apps may be public: installable by any account, not only the one that owns them. */
  publicApps: boolean;
  events: Record<string, { description: string; noisy?: true; addressed?: true }>;
  repositories?: boolean;
  /** The form that creates an app; absent where creation happens on the platform itself. */
  create?: CreateStep;
  /** PUBLIC_URL is loopback, so platforms cannot reach this server and `create` shows a placeholder address. */
  unreachable?: true;
  /** How apps are brought up to date: Coder pushes them, reads what to change on the platform, or lists values to confirm by hand. */
  appUpdate?: 'push' | 'drift' | 'confirm';
}

/** An app Coder cannot push, checked against what its agent needs now: every line, the changed ones marked. */
export type AppCheck = Omit<AppDrift, 'lines'> & {
  changed: boolean;
  lines: Array<AppDrift['lines'][number] & { changed?: true }>;
  /** The lines are Coder's values, confirmed by hand since the platform cannot be read. */
  confirm?: true;
};

/** What publishing did to one of the agent's apps: pushed it, failed to, or found it needs changes on the platform. */
export interface AppSync {
  id: string;
  integration: string;
  name: string;
  updated?: true;
  error?: string;
  drift?: true;
}

/** A started create: its transaction, where the browser goes when creation happens on the platform, and an operator link's form. */
export interface CreateStart {
  tx: string;
  /** The platform's own create form, which the browser posts. */
  post?: PlatformPost;
  create?: CreateStep;
}

/** How a create, install or link flow ended; the Platforms tab and `/dash/setup` word it. */
export interface SetupOutcome {
  status:
    | 'connected'
    | 'created'
    | 'linked'
    | 'cancelled'
    | 'install-expired'
    | 'create-expired'
    | 'link-expired'
    | 'unknown-integration'
    | 'no-public-url'
    | 'unknown-app'
    | 'installation-taken'
    | 'installation-bound'
    | 'account-taken'
    | 'other-workspace'
    | 'failed'
    | IntegrationErrorCode;
  /** Integration id. */
  platform?: string;
  /** The account it got connected to. */
  account?: string;
  /** The app it created. */
  app?: string;
  /** The app an install was for, by id. */
  appId?: string;
  /** The platform's own error code. */
  error?: string;
}

export interface CredentialRow {
  /** The variable of an API key, the engine of a subscription. */
  name: string;
  scope: 'personal' | 'workspace';
  subscription: boolean;
  createdAt?: number;
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

/** One task change on `/admin/events`; `result`, `error` and `answer` come, maybe null, for asked tasks only. */
export type TaskEvent =
  | (Pick<
      TaskRow,
      'status' | 'approval' | 'approvals' | 'archivedAt' | 'createdAt' | 'startedAt' | 'finishedAt'
    > & {
      id: string;
      agent: string;
      result?: TaskRow['result'] | null;
      error?: string | null;
      answer?: unknown[] | null;
      deleted?: never;
    })
  | { id: string; deleted: true };

export interface TaskCountEvent {
  active: number;
}

/** The runners the stream's requester sees, sent when one is added, changed, removed, or goes on or offline. */
export interface RunnersEvent {
  items: RunnerRow[];
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
  /** On the first page, when asked: the viewer's approval queue, tasks with an open approval they see. */
  pendingApprovals?: TaskRow[];
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
  /** The app's settings page on the platform. */
  settingsUrl?: string;
  /** The last sync or check found the app needing an update on its platform. */
  changed?: true;
}

export interface InstallationRow {
  id: string;
  app: string;
  integration: string;
  /** `url`: the account's page on the platform. */
  account: { login: string; type?: string; url?: string };
  covers?: string[];
  repos?: string[];
  deletedAt?: number;
  /** The app was removed or uninstalled on the platform. */
  uninstalled?: boolean;
  /** Where the app is managed on this installation, on its platform. */
  installationUrl?: string;
  settings?: {
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
    /** Where the dashboard sends bug reports. */
    issuesUrl?: string;
    subscriptions?: { claude: boolean; codex: boolean };
  };
  /** May enter operator mode. */
  operator?: boolean;
  /** One of the viewer's connections needs reconnecting. */
  reconnect?: boolean;
}

/** One platform in the operator area, with the built-in agent's shared app when this server has it. */
export interface OperatorAppRow {
  integration: string;
  name: string;
  brand: IntegrationInfo['brand'];
  organizationApps: boolean;
  /** How the built-in app comes up to date: Coder pushes it, or shows what to change on the platform. */
  appUpdate?: 'push' | 'drift' | 'confirm';
  /** `changed`: the app differs from what the built-in agent needs now. */
  app?: { id: string; name: string; createdAt: number; changed?: true };
}

export interface OperatorApps {
  /** The name a new shared app gets unless the operator picks one. */
  name: string;
  platforms: OperatorAppRow[];
  /** Platforms cannot reach this server yet, so creating an app would fail. */
  unreachable?: true;
}

export interface AuditRow {
  at: number;
  actor: { id: string; name?: string; email?: string };
  action: string;
  target: string;
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
  fields?: 'id' | 'id,name';
  q?: string;
  platform?: string;
  type?: string;
  /** A page also lists its agents' apps and their installs. */
  apps?: boolean;
}
export interface CredentialQuery extends PageQuery {
  fields?: 'id';
}

export interface TaskQuery extends PageQuery {
  since?: number;
  sinceId?: string;
  status?: string;
  archived?: boolean;
  summary?: boolean;
  counts?: boolean;
  /** On an admin's first page, also the changes waiting for an admin's approval. */
  approvals?: boolean;
  agent?: string;
  source?: string;
  q?: string;
}
/** An alias's model spec, false for a name turned off, or a custom endpoint. */
export type ModelEntry =
  | string
  | false
  | {
      baseUrl: string;
      model: string;
      envKey?: string;
      wireApi?: 'chat' | 'responses';
      contextWindow?: number;
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
  version?: number;
  chain?: string[];
  reviewModel?: string;
  models?: Record<string, ModelEntry>;
  network?: { allowedHosts?: string[]; readOnlyTasks?: boolean };
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
  /** Built-in aliases, name -> model spec. */
  builtin: Record<string, string>;
  models: Record<string, ModelEntry>;
  /** Where each chain model and the review model run for the caller, by spec. */
  runsOn?: Record<string, string>;
};
export interface ProbeResult {
  reachable: boolean;
  modelListed: boolean | null;
  /** Model ids the endpoint lists, or null when it has no list. */
  models: string[] | null;
  /** Context window in tokens per model id, where the provider reports one. */
  contextWindows?: Record<string, number>;
  detail: string;
}

/** One connection as the dashboard lists it; secrets never leave the server. */
export interface ConnectionRow {
  id: string;
  name: string;
  /** `mcp`, `env` for an API key tasks read from `env`, or the integration id whose API it reaches. */
  provider: string;
  scope: 'personal' | 'workspace';
  /** Set on a member's own connection; `asker` when that member is the one asking. */
  owner?: { id: string; name?: string };
  asker?: true;
  /** Set on an agent's app installation, managed on that agent's Platforms tab. */
  agent?: string;
  /** `read-only` exposes only its read-only tools; absent or `auto` follows the task. */
  access?: Access;
  auth: 'none' | 'key' | 'oauth';
  /** The remote server, or the stdio command, it is bound to. */
  url?: string;
  command?: string;
  /** The environment variable an `env` connection's key is in. */
  env?: string;
  account?: string;
  /** `needs-auth`: its sign-in is unfinished or its secret stopped working; `disabled`: not granted to the task listing it. */
  status: 'connected' | 'needs-auth' | 'disabled';
  /** The task's tool search name for it, when the task has it. */
  server?: string;
  createdAt: number;
}

/** What Add connection posts; `key` is write-only. */
export interface ConnectionInput {
  name: string;
  /** Slug; derived from `name` when absent. */
  id?: string;
  /** `mcp`, `env` with `keyIn.env`, or an integration id to connect a member's own account there. */
  provider?: string;
  /** MCP servers and task secrets default to workspace scope; platform accounts are personal. */
  scope?: 'personal' | 'workspace';
  access?: Access;
  endpoint?: McpEntry;
  auth?: 'none' | 'key' | 'oauth';
  /** For `env`, a new credential holding `key`; without `key` or `credential`, a visible credential with `keyIn.env`. */
  key?: string;
  keyIn?: { header: string } | { env: string };
  /** The credential id an `env` connection reads. */
  credential?: string;
}
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
  verified?: true;
  curated?: true;
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

/** What the New task composer offers: enabled agents with the default first, the workspace's defaults, models, runners, built-in flows, and on a local server its folders. */
export interface ComposerOptions {
  agents: Array<{ id: string; name: string; default?: true }>;
  /** The workspace's models in the order tasks try them, the first the default. */
  chain: string[];
  models: ModelsShape;
  runners: Array<Pick<RunnerRow, 'id' | 'name' | 'default'>>;
  flows: string[];
  folders?: LocalFolders;
  /** The install label of the platform that reaches repositories. */
  connectLabel?: string;
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
  model?: string;
  access?: Access;
  runner?: string;
  mcp?: string[];
  /** Narrows the connections the task is granted. */
  connections?: string[];
};
export type ImportAgent = {
  id: string;
  name: string;
  description?: string;
  version?: number;
  commit?: string;
  taken?: boolean;
  warnings?: string[];
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
  /** The Chat SDK thread and message it happened in, without raw platform payloads; replies go to this thread. */
  chat?: { thread: SerializedThread; message?: SerializedMessage };
  repo?: {
    owner: string;
    name: string;
    cloneUrl: string;
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
export type PushResult = {
  id: string;
  version: number;
  unchanged: boolean;
  /** The agent's apps publishing pushed, failed to push, or found needing changes on their platform. */
  apps?: AppSync[];
};

export interface TaskTurn {
  prompt: string;
  result?: { ok?: boolean; output?: string; diff?: string } | string;
  error?: string;
  finishedAt?: number;
  /** First log sequence after this turn. */
  logSeq?: number;
  /** The approval whose decision this turn's prompt is: it shows as that decision, not as a prompt. */
  approval?: string;
}
