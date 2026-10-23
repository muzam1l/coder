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
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import type {
  AgentDefinition,
  AgentEvent,
  AgentTask,
  AgentUsage,
  Connection,
  TaskContext,
  TaskSource,
  TaskUsage,
  ModelAttempt,
} from '../../../agent/types';
import type { Approval, Task } from '../../../core/types';
import type { Space } from '../../../integrations/types';
import type { StoredConfig } from '../../settings/config';
import type { ApprovalPost } from '../../tasks/approvals';
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

/** Every credential-like sealed value, one row each: `plain.<base64>` or `<iv>.<tag>.<ciphertext>`. Owners point at it and delete it with themselves; shared apps point at one row. */
export const secret = pgTable('secret', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  value: text().notNull(),
});
const secretId = () => bigint({ mode: 'number' }).references(() => secret.id);

/** A platform user (Slack member, GitHub login) who connected their Wular account. */
export const platformLink = pgTable(
  'platform_link',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    platform: text().notNull(),
    platformUserId: text().notNull(),
    /** The platform's own handle for the user (GitHub login), when the link learned it. */
    login: text(),
    /** Wular user id, with the name and email Wular gave at link time. */
    userId: text().notNull(),
    name: text().notNull(),
    email: text().notNull(),
    /** Workspaces the user belonged to when last linked. */
    organizations: jsonb().$type<string[]>(),
    /** The user's role in each of those workspaces, refreshed at sign-in. */
    roles: jsonb().$type<Record<string, string>>(),
    /** The platform's user token from the link's OAuth, sealed. */
    tokenSecretId: secretId(),
    /** When the platform refused the token's refresh; a new token clears it. */
    refusedAt: at(),
    createdAt: at().notNull().defaultNow(),
  },
  t => [
    uniqueIndex('platform_link_platform_platformUserId_unique').on(t.platform, t.platformUserId),
    index().on(t.userId),
  ],
);

/** A workspace's own row: its Wular slug and name for links made without a session, and its task configuration. */
export const workspace = pgTable('workspace', {
  organizationId: text().primaryKey(),
  slug: text(),
  name: text(),
  config: jsonb().$type<StoredConfig>(),
});

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
    engineSettings: jsonb().$type<AgentUsage>(),
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

/** The agent's identity on one platform; credentials sealed. Organization `""` is a server-level app shared by every workspace. */
export const integrationApp = pgTable(
  'integration_app',
  {
    ...owned,
    /** `<integration>:<platform app id>`, the id the rest of the server uses. */
    key: text().notNull(),
    integration: text().notNull(),
    agent: text().notNull(),
    name: text().notNull(),
    agentsRepo: text(),
    branch: text(),
    /** Its sealed credentials, the shared app's row when it runs on them. */
    credentialsSecretId: secretId().notNull(),
    /** The server-level app whose credentials this app uses. Any account may install it, not only the one that owns it. */
    sharedAppId: bigint({ mode: 'number' }).references((): AnyPgColumn => integrationApp.id),
    ...timestamps,
  },
  t => [
    uniqueIndex('integration_app_organizationId_key_unique').on(t.organizationId, t.key),
    uniqueIndex('integration_app_key_unique').on(t.key),
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
    /** The platform's one-time secret (Slack bot token), sealed. */
    tokenSecretId: secretId(),
    installer: text(),
    /** The app's own platform user in this installation, as the platform named it at install. */
    self: text(),
    covers: jsonb().$type<string[]>(),
    repos: jsonb().$type<string[]>(),
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
    /** Wular user id of a personal credential; null for a workspace one. */
    owner: text(),
    label: text().notNull(),
    /** The sealed credential environment. */
    secretId: secretId().notNull(),
    /** What the engine's CLI reported at sign-in. */
    account: jsonb().$type<{ email?: string; plan?: string }>(),
    ...timestamps,
  },
  t => [
    uniqueIndex('engine_credential_workspace_label_unique')
      .on(t.organizationId, t.label)
      .where(sql`${t.owner} is null`),
    uniqueIndex('engine_credential_owner_label_unique')
      .on(t.organizationId, t.owner, t.label)
      .where(sql`${t.owner} is not null`),
  ],
);

/** A runner; the workspace's when `owner` is null, else that member's own. */
export const runner = pgTable(
  'runner',
  {
    ...owned,
    publicId: text().notNull(),
    owner: text(),
    name: text().notNull(),
    kind: text().$type<import('../../../client/types').RunnerKind>().notNull(),
    config: jsonb().$type<Record<string, string>>().notNull(),
    /** Its secret fields, sealed. */
    secretId: secretId().notNull(),
    createdBy: text(),
    isDefault: boolean().notNull().default(false),
    lastSeen: timestamp({ withTimezone: true }),
    ...timestamps,
  },
  t => [uniqueIndex('runner_organizationId_publicId_unique').on(t.organizationId, t.publicId)],
);

/** A member's connection to an MCP server or a platform API, its sealed secret in its own row; the workspace's when `owner` is null. */
export const connection = pgTable(
  'connection',
  {
    ...owned,
    key: text().notNull(),
    owner: text(),
    record: jsonb().$type<Omit<Connection, 'secret'>>().notNull(),
    secretId: secretId(),
  },
  t => [
    uniqueIndex('connection_organizationId_key_unique').on(t.organizationId, t.key),
    index().on(t.organizationId, t.owner),
  ],
);

/** One run of an agent for one request: queue row while waiting, record afterwards, with what it cost once finished. */
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
    runnerKind: text().notNull(),
    access: text().$type<AgentTask['access']>(),
    installationId: bigint({ mode: 'number' }).references(() => integrationAppInstallation.id),
    event: jsonb().$type<AgentEvent>(),
    /** Who sees it: `''` every member, `dm:<user>` the member who asked, `space:<key>` the private space's members; null is unknown and shows to the member who asked and admins only. Set by every insert; a child copies its parent's. */
    audience: text(),
    /** The space it came from, own or inherited, so a privacy change finds its tasks. */
    space: text(),
    parent: text(),
    connections: jsonb().$type<string[]>(),
    models: jsonb().$type<ModelAttempt[]>(),
    name: text(),
    cwd: text(),
    prompt: text(),
    args: jsonb().$type<Record<string, unknown>>(),
    mcp: jsonb().$type<string[]>(),
    appendSystem: text(),
    addDirs: jsonb().$type<string[]>(),
    author: text(),
    definition: jsonb().$type<AgentDefinition>().notNull(),
    requestedBy: text(),
    runnerId: text(),
    engineSettings: jsonb().$type<TaskUsage>(),
    tools: jsonb().$type<Record<string, string[]>>().notNull(),
    context: jsonb().$type<TaskContext>(),
    files: jsonb().$type<Record<string, string>>(),
    failureReply: text(),
    taskUrl: text(),
    settingsUrl: text(),
    result: jsonb().$type<TaskOutcome>(),
    error: text(),
    fallbacks: jsonb().$type<NonNullable<Task['fallbacks']>>(),
    tokens: jsonb(),
    /** What the finished task cost: the engine, model and credential that ran, runner time and tokens summed over its turns. */
    engine: text(),
    model: text(),
    credential: text(),
    runnerMs: integer(),
    tokenCount: bigint({ mode: 'number' }),
    usageTokens: jsonb(),
    handle: text(),
    tokenHash: text(),
    lastSeenAt: at(),
    logCursor: integer(),
    logSeq: integer(),
    logBytes: integer(),
    /** The runner reported its last line of this attempt; cleared with the handle. */
    logsComplete: boolean(),
    archivedAt: at(),
    approval: jsonb().$type<Approval>(),
    answer: jsonb(),
    attempts: integer().notNull().default(0),
    inboxSeq: integer()
      .notNull()
      .default(sql`'-1'`),
    inboxAck: integer()
      .notNull()
      .default(sql`'-1'`),
    generation: integer().notNull().default(0),
    startedAt: at(),
    finishedAt: at(),
    cancelRequestedAt: at(),
    ...timestamps,
  },
  t => [
    uniqueIndex('task_organizationId_publicId_unique').on(t.organizationId, t.publicId),
    index().on(t.publicId),
    index().on(t.organizationId, t.createdAt.desc(), t.publicId.desc()),
    index('task_organizationId_unarchived_index')
      .on(t.organizationId, t.createdAt.desc(), t.publicId.desc())
      .where(sql`${t.archivedAt} is null`),
    index().on(t.organizationId, t.updatedAt),
    index().on(t.organizationId, t.finishedAt),
    index().on(t.organizationId, t.audience),
    index().on(t.organizationId, t.requestedBy),
    index().on(t.organizationId, t.parent),
    index()
      .on(t.organizationId)
      .where(sql`${t.status} = 'queued'`),
    index('task_organizationId_active_index')
      .on(t.organizationId)
      .where(sql`${t.status} in ('queued', 'running', 'waiting')`),
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
    id: bigserial({ mode: 'number' }).primaryKey(),
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

/** A task's output, one row per flush the runner sent: lines `seqFrom` through `seqTo`. */
export const taskLog = pgTable(
  'task_log',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    taskId: bigint({ mode: 'number' })
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    seqFrom: integer().notNull(),
    seqTo: integer().notNull(),
    lines: jsonb().$type<TaskLogLine[]>().notNull(),
  },
  t => [uniqueIndex('task_log_taskId_seqFrom_unique').on(t.taskId, t.seqFrom)],
);

/** A task's engine conversations, one row each, gzipped and encrypted. */
export const taskHistory = pgTable(
  'task_history',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
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

/** A task's sealed connection secrets while it runs: `connection-secrets:<task>:<hash>` rows and the `connections:<task>:<generation>:<attempt>:<id>` resolution, gone with the task. */
export const taskSecret = pgTable(
  'task_secret',
  {
    id: bigserial({ mode: 'number' }).primaryKey(),
    taskId: bigint({ mode: 'number' })
      .notNull()
      .references(() => task.id, { onDelete: 'cascade' }),
    key: text().notNull(),
    secretId: secretId().notNull(),
    expiresAt: at(),
  },
  t => [
    uniqueIndex('task_secret_taskId_key_unique').on(t.taskId, t.key),
    index()
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

/** A deleted task's id for a while, so every server's events streams drop it from their lists. */
export const taskTombstone = pgTable(
  'task_tombstone',
  {
    organizationId: text().notNull(),
    publicId: text().notNull(),
    /** The task's audience and the member who asked, so only who saw it hears the delete. */
    audience: text(),
    requestedBy: text(),
    deletedAt: at().notNull(),
  },
  t => [
    primaryKey({ name: 'task_tombstone_pk', columns: [t.organizationId, t.publicId] }),
    index().on(t.organizationId, t.deletedAt),
  ],
);

/** An approval's post in its conversation, under `approval:<task>:<approval>`; `retryAt` and `shownAt` are the record's own, lifted so the sweep finds due posts by index. */
export const approvalPost = pgTable(
  'approval_post',
  {
    ...owned,
    key: text().notNull(),
    value: jsonb().$type<ApprovalPost>().notNull(),
    at: at().notNull(),
    shownAt: at(),
    retryAt: at(),
    expiresAt: at(),
  },
  t => [
    uniqueIndex('approval_post_organizationId_key_unique').on(t.organizationId, t.key),
    index()
      .on(t.retryAt)
      .where(sql`${t.retryAt} is not null`),
    index('approval_post_unshown_index')
      .on(t.at)
      .where(sql`${t.shownAt} is null`),
  ],
);

/** A private space with tasks: its member list as last fetched, kept current by membership events; a row with no `syncedAt` is a fetch claim or a failed fetch. */
export const privateSpace = pgTable(
  'private_space',
  {
    ...owned,
    integration: text().notNull(),
    /** The app key and platform installation id whose token lists the members. */
    app: text().notNull(),
    installation: text().notNull(),
    /** The platform account, else the installation, as a task's `account ?? installationId`. */
    account: text().notNull(),
    kind: text().$type<Space['kind']>().notNull(),
    space: text().notNull(),
    syncedAt: at(),
    /** A fetch in progress holds the row until it lands, fails or expires. */
    claimedAt: at(),
  },
  t => [
    uniqueIndex('private_space_organizationId_integration_account_space_unique').on(
      t.organizationId,
      t.integration,
      t.account,
      t.space,
    ),
  ],
);

/** One platform user in a private space's member list. */
export const spaceMember = pgTable(
  'space_member',
  {
    spaceId: bigint({ mode: 'number' })
      .notNull()
      .references(() => privateSpace.id, { onDelete: 'cascade' }),
    member: text().notNull(),
  },
  t => [uniqueIndex('space_member_spaceId_member_unique').on(t.spaceId, t.member)],
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
    primaryKey({ name: 'chat_item_key_seq_pk', columns: [t.key, t.seq] }),
    index()
      .on(t.expiresAt)
      .where(sql`${t.expiresAt} is not null`),
  ],
);

/** Every table, for drizzle's relational schema option. */
export const tables = {
  secret,
  platformLink,
  workspace,
  agent,
  agentVersion,
  integrationApp,
  integrationAppInstallation,
  engineCredential,
  runner,
  connection,
  task,
  taskInbox,
  taskLog,
  taskHistory,
  taskSecret,
  taskTombstone,
  approvalPost,
  privateSpace,
  spaceMember,
  chatState,
  chatItem,
};
