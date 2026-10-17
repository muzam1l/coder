/** Coder server tables. Column names are snake_case via the drizzle `casing` option. */
import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

import type {
  AgentDefinition,
  AgentEvent,
  AgentUsage,
  InstallationSettings,
  TaskContext,
  TaskSource,
} from '../../../agent/types';
import type { AgentRecord, TaskHistory, TaskLogLine, TaskOutcome, TaskState } from '../types';

/** Everything Coder owns lives in its own Postgres schema, so a database can be shared. */
export const coder = pgSchema('coder');
const pgTable = coder.table;

const at = () => timestamp({ withTimezone: true });
const timestamps = {
  createdAt: at().notNull().defaultNow(),
  updatedAt: at().notNull().defaultNow(),
};
/** Rows belong to a Wular organization, by its id. */
const owned = {
  id: bigserial({ mode: 'number' }).primaryKey(),
  organizationId: text().notNull(),
};

/** A platform user (Slack member, GitHub login) who connected their Wular account. */
export const platformLink = pgTable(
  'platform_link',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    platform: text().notNull(),
    platformUserId: text().notNull(),
    /** Wular user id, with the name and email Wular gave at link time. */
    userId: text().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    /** Workspaces the user belonged to when last linked. */
    organizations: jsonb().$type<string[]>(),
    /** The platform's user token from the link's OAuth, encrypted. */
    token: text(),
    createdAt: at().notNull().defaultNow(),
  },
  t => [
    uniqueIndex('platform_link_platform_platformUserId_unique').on(t.platform, t.platformUserId),
    index().on(t.userId),
  ],
);

/** An agent owned by an organization; its current version is the one events run. */
export const agent = pgTable(
  'agent',
  {
    ...owned,
    slug: text().notNull(),
    name: text().notNull(),
    description: text(),
    problems: jsonb().$type<string[]>(),
    source: text().$type<AgentRecord['source']>().notNull(),
    repo: text(),
    path: text(),
    currentVersion: integer().notNull(),
    settings: jsonb().$type<AgentUsage>(),
    ...timestamps,
  },
  t => [uniqueIndex('agent_organizationId_slug_unique').on(t.organizationId, t.slug)],
);

/** Immutable imported or uploaded content for one agent version. */
export const agentVersion = pgTable(
  'agent_version',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    agentId: bigint({ mode: 'number' })
      .notNull()
      .references(() => agent.id, { onDelete: 'cascade' }),
    version: integer().notNull(),
    definition: jsonb().$type<AgentDefinition>().notNull(),
    systemPrompt: text().notNull(),
    files: jsonb().$type<Record<string, string>>(),
    commit: text(),
    importedFrom: text().notNull(),
    createdAt: at().notNull().defaultNow(),
  },
  t => [uniqueIndex('agent_version_agentId_version_unique').on(t.agentId, t.version)],
);

/** Encrypted values shared by apps, installations, and engine credentials. */
export const secret = pgTable(
  'secret',
  {
    ...owned,
    kind: text().$type<'app' | 'installation' | 'engine' | 'runner'>().notNull(),
    iv: text().notNull(),
    tag: text().notNull(),
    ciphertext: text().notNull(),
    keyVersion: integer().notNull(),
    ...timestamps,
  },
  t => [index().on(t.organizationId, t.kind)],
);

/** The agent's identity on one platform; credentials encrypted. Organization `""` is a server-level app shared by every workspace. */
export const integrationApp = pgTable(
  'integration_app',
  {
    ...owned,
    /** `<integration>:<platform app id>`, the id the rest of the server uses. */
    key: text().notNull(),
    integration: text().notNull(),
    platformAppId: text().notNull(),
    agent: text().notNull(),
    name: text().notNull(),
    agentsRepo: text(),
    branch: text(),
    /** Any account may install it, not only the one that owns it. */
    credentialsSecretId: bigint({ mode: 'number' })
      .notNull()
      .references(() => secret.id),
    ...timestamps,
  },
  t => [
    uniqueIndex('integration_app_organizationId_key_unique').on(t.organizationId, t.key),
    uniqueIndex('integration_app_integration_platformAppId_unique').on(t.integration, t.platformAppId),
  ],
);

/** One grant of an app: a GitHub installation, a Slack workspace. It belongs to exactly one workspace. */
export const integrationAppInstallation = pgTable(
  'integration_app_installation',
  {
    ...owned,
    /** `<app key>:<platform install id>`. */
    key: text().notNull(),
    /** Null once the app is removed; the row stays for history and reads skip it. */
    appId: bigint({ mode: 'number' }).references(() => integrationApp.id, { onDelete: 'set null' }),
    platformInstallId: text().notNull(),
    account: jsonb().$type<{ login: string; type?: string }>().notNull(),
    tokenSecretId: bigint({ mode: 'number' }).references(() => secret.id),
    installer: text(),
    /** The app's own platform user in this installation, as the platform named it at install. */
    self: text(),
    covers: jsonb().$type<string[]>(),
    repos: jsonb().$type<string[]>(),
    settings: jsonb().$type<InstallationSettings>(),
    ...timestamps,
    deletedAt: at(),
    uninstalled: boolean(),
  },
  t => [unique().on(t.key), index().on(t.organizationId, t.appId)],
);

/** One engine credential, labelled by its variable or subscription engine: a member's own when `owner` is set, else the workspace's. */
export const engineCredential = pgTable(
  'engine_credential',
  {
    ...owned,
    secretId: bigint({ mode: 'number' })
      .notNull()
      .references(() => secret.id)
      .unique(),
    /** Wular user id of a personal credential; null for a workspace one. */
    owner: text(),
    label: text().notNull(),
    /** What the engine's CLI reported at sign-in. */
    account: jsonb().$type<{ email?: string; plan?: string }>(),
    ...timestamps,
  },
  t => [
    uniqueIndex('engine_credential_workspace_label_unique')
      .on(t.organizationId, t.label).where(sql`${t.owner} is null`),
    uniqueIndex('engine_credential_owner_label_unique')
      .on(t.organizationId, t.owner, t.label).where(sql`${t.owner} is not null`),
  ],
);

/** A scoped runner with its secret fields sealed separately. */
export const runner = pgTable(
  'runner',
  {
    ...owned,
    publicId: text().notNull(),
    owner: text(),
    name: text().notNull(),
    kind: text().$type<import('../../../client/types').RunnerKind>().notNull(),
    scope: text().$type<'personal' | 'workspace'>().notNull(),
    config: jsonb().$type<Record<string, string>>().notNull(),
    createdBy: text(),
    isDefault: boolean().notNull().default(false),
    lastSeen: timestamp({ withTimezone: true }),
    secretId: bigint({ mode: 'number' })
      .notNull()
      .references(() => secret.id),
    ...timestamps,
  },
  t => [uniqueIndex('runner_organizationId_publicId_unique').on(t.organizationId, t.publicId)],
);

/** One run of an agent for one request: queue row while waiting, record afterwards. */
export const task = pgTable(
  'task',
  {
    ...owned,
    publicId: text().notNull(),
    source: text().$type<TaskSource>().notNull(),
    status: text().$type<TaskState>().notNull(),
    agent: text().notNull(),
    flow: text().notNull(),
    reviewKey: text(),
    runner: text().notNull(),
    permissions: text().$type<AgentDefinition['permissions']>(),
    appId: bigint({ mode: 'number' }).references(() => integrationApp.id, { onDelete: 'set null' }),
    installationId: bigint({ mode: 'number' }).references(() => integrationAppInstallation.id),
    event: jsonb().$type<AgentEvent>(),
    prompt: text(),
    args: jsonb().$type<Record<string, unknown>>(),
    mcp: jsonb().$type<string[]>(),
    author: text(),
    definition: jsonb().$type<AgentDefinition>().notNull(),
    credential: text(),
    requester: text(),
    runnerId: text(),
    usage: jsonb().$type<AgentUsage>(),
    tools: jsonb().$type<Record<string, string[]>>().notNull(),
    context: jsonb().$type<TaskContext>(),
    files: jsonb().$type<Record<string, string>>(),
    result: jsonb().$type<TaskOutcome>(),
    error: text(),
    tokens: jsonb(),
    handle: text(),
    tokenHash: text(),
    lastSeenAt: at(),
    logCursor: integer(),
    logSeq: integer(),
    logBytes: integer(),
    archivedAt: at(),
    approval: jsonb(),
    answer: jsonb(),
    attempts: integer().notNull().default(0),
    inboxSeq: integer().notNull().default(sql`'-1'`),
    inboxAck: integer().notNull().default(sql`'-1'`),
    generation: integer().notNull().default(0),
    lockedAt: at(),
    startedAt: at(),
    finishedAt: at(),
    cancelRequestedAt: at(),
    ...timestamps,
  },
  t => [
    uniqueIndex('task_organizationId_publicId_unique').on(t.organizationId, t.publicId),
    index().on(t.publicId),
    index().on(t.organizationId, t.createdAt.desc(), t.publicId.desc()),
    index().on(t.organizationId, t.updatedAt),
    index()
      .on(t.organizationId)
      .where(sql`${t.status} = 'queued'`),
    index().on(t.status, t.createdAt),
    index()
      .on(t.organizationId, t.reviewKey)
      .where(sql`${t.status} in ('running', 'waiting')`),
  ],
);

/** Dashboard and CLI messages consumed by the running task. */
export const taskInbox = pgTable(
  'task_inbox',
  {
    ...owned,
    taskId: bigint({ mode: 'number' })
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    generation: integer().notNull().default(0),
    kind: text().$type<'steer' | 'ask' | 'approve' | 'cancel'>().notNull(),
    value: jsonb(),
    at: at().notNull(),
  },
  t => [
    uniqueIndex('task_inbox_taskId_seq_unique').on(t.taskId, t.seq),
    index().on(t.taskId, t.generation, t.seq),
  ],
);

/** A task's output, one row per line, streamed while it runs. */
export const taskLog = pgTable(
  'task_log',
  {
    ...owned,
    taskId: bigint({ mode: 'number' })
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    seq: integer().notNull(),
    at: at().notNull(),
    level: text().$type<TaskLogLine['level']>().notNull(),
    line: text().notNull(),
  },
  t => [uniqueIndex('task_log_taskId_seq_unique').on(t.taskId, t.seq)],
);

/** A task's engine conversations, one row each, gzipped and encrypted. */
export const taskHistory = pgTable(
  'task_history',
  {
    ...owned,
    taskId: bigint({ mode: 'number' })
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    engine: text().$type<TaskHistory['engine']>().notNull(),
    conversation: text().notNull(),
    data: text().notNull(),
    state: text(),
    savedAt: at().notNull(),
  },
  t => [uniqueIndex('task_history_taskId_conversation_unique').on(t.taskId, t.conversation)],
);

/** A deleted task's id for a while, so every server's events streams drop it from their lists. */
export const taskTombstone = pgTable(
  'task_tombstone',
  {
    organizationId: text().notNull(),
    publicId: text().notNull(),
    deletedAt: at().notNull(),
  },
  t => [index().on(t.organizationId, t.deletedAt)],
);

/** What a finished task cost. */
export const usage = pgTable(
  'usage',
  {
    ...owned,
    taskId: bigint({ mode: 'number' })
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' })
      .unique(),
    installationId: bigint({ mode: 'number' }).references(() => integrationAppInstallation.id),
    agent: text().notNull(),
    target: text().notNull(),
    engine: text(),
    model: text(),
    credential: text().notNull(),
    runnerMs: integer().notNull(),
    tokens: jsonb(),
    at: at().notNull(),
    ...timestamps,
  },
  t => [index().on(t.organizationId, t.at)],
);

/** TTL values: Chat SDK keys and organization-scoped server state. */
export const chatState = pgTable(
  'chat_state',
  {
    key: text().primaryKey(),
    value: jsonb().notNull(),
    expiresAt: at(),
  },
  t => [
    index()
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
    // Prefix reads (`like 'prefix%'`) under any database collation.
    index('chat_state_key_prefix_index').on(t.key.op('text_pattern_ops')),
  ],
);

/** Chat SDK list and queue items, one row each, in `seq` order under their app-prefixed key. */
export const chatItem = pgTable(
  'chat_item',
  {
    key: text().notNull(),
    seq: bigint({ mode: 'number' }).generatedAlwaysAsIdentity(),
    value: jsonb().notNull(),
    expiresAt: at(),
  },
  t => [
    uniqueIndex('chat_item_key_seq_pk').on(t.key, t.seq),
    index()
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

/** Every table, for drizzle's relational schema option. */
export const tables = {
  platformLink,
  agent,
  agentVersion,
  secret,
  integrationApp,
  integrationAppInstallation,
  engineCredential,
  runner,
  task,
  taskInbox,
  taskLog,
  taskHistory,
  taskTombstone,
  usage,
  chatState,
  chatItem,
};
