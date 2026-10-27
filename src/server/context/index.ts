/** The server's request context and its configuration, and scoping it to one organization. */
import type { StateAdapter } from 'chat';
import type { JWK } from 'jose';
import type { Integration } from '../../integrations/types';
import type { Agent, AgentApp, AgentEvent, Installation, RunnerKind } from '../../agent/types';
import type { Runner } from '../runners';
import type { AgentRecord, AgentVersionRecord, Store, TaskStatus } from '../store/types';
import type { TokenSource } from '../tasks/context';
import type { TaskQueue } from '../tasks/queue';
import type { TaskPrincipal } from '../tasks/access';

/** An agent's record and version, as one read loaded them, and the store that read holds repository files in. */
export interface LoadedAgent {
  record?: AgentRecord;
  version?: AgentVersionRecord;
  store?: Store;
}

export interface ServerConfig {
  limits?: import('../limits').LimitsConfig;
  usageLimits?: import('../tasks/usage').UsageLimits;
  runner: RunnerKind;
  /** `memory` is for local testing only; `postgres` is a real deployment with sign-in. */
  store: 'memory' | 'postgres';
  workDir: string;
  encryptionKey?: string;
  previousEncryptionKey?: string;
  /** Bearer for `/admin/*` on a memory server, which has no sign-in; ignored with Postgres. */
  adminToken?: string;
  publicUrl?: string;
  /** Themed review images, a path on this server or a URL; unset posts basic reviews. */
  reviewAssets?: string;
  /** What the dashboard calls this server; `Coder` unless set. */
  name?: string;
  /** `ISSUES_URL`: where the dashboard sends bug reports. */
  issuesUrl: string;
  /** `PLANS_URL`: where usage limit notices and refusals send for plans. */
  plansUrl?: string;
  databaseUrl?: string;
  databasePool?: import('../store/pg/client').PoolOptions;
  /** Host-only runner configuration. */
  runnerConfig?: Record<string, unknown>;
  /** Tasks the server may have running, and their lifecycle limits. */
  maxTasks?: number;
  taskTimeoutMs: number;
  taskStallMs?: number;
  taskAttempts?: number;
  maxQueued?: number;
  /** Conversation and reaction batching windows. */
  steerBatchMs?: number;
  reactionBatchMs?: number;
  /** `CLAUDE_SUBSCRIPTIONS` and `CODEX_SUBSCRIPTIONS`: subscription sign-in for personal credentials. */
  subscriptions?: { claude?: boolean; codex?: boolean };
  /** Wular, the identity provider; set for a Postgres server. */
  auth?: { wular: { url: string } };
  /** `SERVER_INTEGRATIONS`: the platforms this host offers, by id; every one when unset. */
  integrations?: string[];
  /** `SERVER_OPERATORS`: the Wular user ids that may enter operator mode. */
  operators?: string[];
}

export interface OrganizationInfo {
  id: string;
  name: string;
  slug: string;
  role: string;
}

/** Who is signed in, from the session cookie or a Wular access token issued for this server. */
export interface SessionInfo {
  user: { id: string; name: string; email: string };
  organizationId?: string;
  /** The user's role in `organizationId`. */
  role?: string;
  /** An explicit organization header named an organization the user cannot use. */
  organizationDenied?: boolean;
  /** The user's Wular organizations with their roles. */
  organizations: OrganizationInfo[];
  /** A bearer token older than a privileged action accepts; the client refreshes it and retries. */
  stale?: boolean;
}

/** The session in the organization a request names by slug or id; denied when the user is not a member. */
export function chosenOrganization(info: SessionInfo, wanted: string): SessionInfo {
  const org = info.organizations.find(o => o.slug === wanted || o.id === wanted);
  return org
    ? { ...info, organizationId: org.id, role: org.role }
    : { ...info, organizationId: undefined, role: undefined, organizationDenied: true };
}

/** What a link remembers besides the user: their workspaces then, and the encrypted platform user token. */
export interface LinkExtra {
  organizations?: string[];
  /** The user's role in each of `organizations`. */
  roles?: Record<string, string>;
  token?: string;
  /** The workspace `token` was granted in, the only one that uses it. */
  organizationId?: string;
  /** The platform's own handle for the user (GitHub login), when the link learned it. */
  login?: string;
}

/** A platform account linked to a member, with its sealed token. */
export type LinkedAccount = {
  platform: string;
  platformUserId: string;
  name: string;
  email: string;
} & LinkExtra & {
    /** When the platform refused the token's refresh. */
    refusedAt?: number;
  };

/** The workspaces and roles a link remembers. */
export const linkedOrganizations = (organizations: OrganizationInfo[]) => ({
  organizations: organizations.map(org => org.id),
  roles: Object.fromEntries(organizations.map(org => [org.id, org.role])),
});

/** What the server needs from the sign-in layer; `src/server/auth.ts` builds it over Wular. */
export interface AuthApi {
  /** Wular's issuer URL. */
  issuer: string;
  /** The public keys of this server's client metadata document. */
  jwks: { keys: JWK[] };
  /** Handles `/api/auth/*`: sign-in, the OpenID callback, and sign-out. */
  handler(req: Request): Promise<Response>;
  /** `fresh` demands roles at most 60 seconds old, refreshing them from Wular first; `cookies` receives the Set-Cookie values the response must carry. */
  session(headers: Headers, fresh?: boolean, cookies?: string[]): Promise<SessionInfo | undefined>;
  /** The user of a live operator session, whose idle timer restarts; `cookies` receives its renewed or cleared cookie. */
  operator(headers: Headers, cookies?: string[]): Promise<string | undefined>;
  /** Makes the organization the session's active one; `cookies` receives the Set-Cookie values that store it. */
  setOrganization(
    headers: Headers,
    slug: string,
    cookies?: string[],
  ): Promise<OrganizationInfo | undefined>;
  /** An organization's slug and name as Wular last gave them at a member's sign-in. */
  organization?(id: string): Promise<{ slug: string; name: string } | undefined>;
  /** Connect a platform user to a Wular user; `taken` when another user already holds that identity. */
  link(
    user: SessionInfo['user'],
    platform: string,
    platformUserId: string,
    extra?: LinkExtra,
    store?: Store,
  ): Promise<'linked' | 'taken'>;
  linkedAccounts?(userId: string, store?: Store): Promise<LinkedAccount[]>;
  /** Every member's linked accounts in the organization. */
  organizationAccounts?(
    organizationId: string,
    store?: Store,
  ): Promise<Array<LinkedAccount & { userId: string }>>;
  unlink?(userId: string, platform: string, platformUserId: string, store?: Store): Promise<void>;
  refreshLinkedToken?(
    userId: string,
    platform: string,
    platformUserId: string,
    previous: string,
    next: string,
    store?: Store,
  ): Promise<boolean>;
  /** Marks the link refused while it still holds `token`. */
  refuseLinkedToken?(
    userId: string,
    platform: string,
    platformUserId: string,
    token: string,
    store?: Store,
  ): Promise<void>;
  linkedUser(
    platform: string,
    platformUserId: string,
  ): Promise<({ id: string; name: string; email: string } & LinkExtra) | undefined>;
}

export interface ServerContext {
  limits?: import('../limits').ServerLimits;
  /** When `/health` last passed; reused for a few seconds. */
  healthyAt?: number;
  databaseHealth?: () => Promise<void>;
  config: ServerConfig;
  settings?: ServerSettings;
  authorizedRequest?: Request;
  dashboardHosts?: import('../dash/serve').DashboardHosts;
  requestScopes?: Map<string, import('../routes/guards').RequestScope>;
  dbProfile?: import('../store/pg/client').DatabaseProfile;
  /** Task changes for `/admin/events` requests, one read shared by those waiting. */
  taskWatcher?: import('../tasks/stream').TaskWatcher;
  /** Task logs for `/admin/tasks/:id/stream` requests, one read at a time per task. */
  logWatcher?: import('../tasks/stream').LogWatcher;
  /** Runs `work` with Postgres's statement_timeout at `ms`; absent without a database. */
  statementTimeout?: <T>(ms: number, work: () => Promise<T>) => Promise<T>;
  /** Tenant every store row and task belongs to. */
  organizationId: string;
  /** Sign-in layer; absent when the server runs without a database, where the admin token is the only auth. */
  auth?: AuthApi;
  /** The same server bound to another organization. */
  scope?(organizationId: string): ServerContext;
  /** An app record and the organization owning it, by its key, in one lookup. */
  webhookTarget?: import('../store').Backend['webhookTarget'];
  boundInstallation?: { organizationId: string; installation: Installation };
  appRecord?(appKey: string): Promise<{ organizationId: string; app: AgentApp } | undefined>;
  /** Every workspace's apps on one integration, for an install the platform started. */
  apps?(integration: string): Promise<Array<{ organizationId: string; app: AgentApp }>>;
  /** Which workspace an installation is bound to, by its key; webhooks route by it. */
  installationOrganization?(key: string): Promise<string | undefined>;
  /** Live installations of one integration in every workspace, by key and workspace. */
  installations?(integration: string): Promise<Array<{ key: string; organizationId: string }>>;
  /** The organization server-level apps live in. */
  serverOrganizationId?: string;
  /** A loopback server without a database: the CLI's own config, agents and tasks in `cwd`, served on `port`. */
  local?: {
    cwd: string;
    port: number;
    archiveScan?: number;
    usageSync?: Promise<void>;
    cacheMaintenance?: Promise<void>;
    engineChecks?: {
      expiresAt: number;
      work: Promise<import('../tasks/local').EngineStatus>;
      availability: Partial<Record<'claude' | 'codex', import('../../core/types').Availability>>;
    };
  };
  /** Resolve a callback tenant without exposing tasks from other organizations. */
  taskOrganization?(taskId: string, tokenHash: string): Promise<string | undefined>;
  /** The signed-in user behind this request, once resolved. */
  session?: SessionInfo;
  /** The running task whose Coder server made this request; its reach is its children and its agent. */
  taskPrincipal?: TaskPrincipal;
  /** The task row a `/tasks/:id` route's guard read, so its handler need not read it again. */
  routeTask?: TaskStatus;
  integrations: Record<string, Integration>;
  runners: Partial<Record<RunnerKind, Runner>>;
  store: Store;
  queue: TaskQueue;
  /** The host's usage limits per workspace; without it `config.usageLimits` applies to every workspace. */
  usageLimits?: (
    organizationId: string,
  ) => import('../tasks/usage').UsageLimits | Promise<import('../tasks/usage').UsageLimits>;
  /** Chat SDK state for every app; a context without one keeps it for the request only. */
  chatState?: StateAdapter;
  syncAgent?(slug: string): Promise<unknown>;
  /** Load the app's server-owned agent version and per-repository usage; `known` is what the event's dispatch read already. */
  loadAgent(
    app: AgentApp,
    installation: Installation,
    event: AgentEvent,
    tokens: TokenSource,
    known?: LoadedAgent,
  ): Promise<Agent>;
  /** Test or host override for outbound credential validation. */
  fetch?: typeof fetch;
  /** Repository file reads in flight, one per cache key. */
  fileReads?: Map<string, Promise<string | undefined>>;
  /** Repository listings in flight, one per installation. */
  repositoryLists?: Map<string, Promise<Installation | undefined>>;
  runnerExec?: typeof import('node:child_process').execFile;
  runnerTimeoutMs?: number;
  now?: () => number;
  waitUntil?: (work: Promise<unknown>) => void;
}

export interface ServerSettings {
  builtinAgents?: Promise<void>;
  taskLogSecrets?: Map<string, Promise<(text: string) => string>>;
  agentInstallations?: Map<string, Promise<import('../../agent/types').Installation[]>>;
  cancelChecks?: Map<string, { timer: ReturnType<typeof setTimeout>; finish(): void }>;
  runnerInstances?: Map<string, { signature: string; runner: Runner }>;
  configUpdate?: Promise<unknown>;
  registry?: import('../settings/mcp').RegistryIndex;
  probes?: import('../settings/models').MemoryCache<import('../../client/types').ProbeResult>;
}

/** The same server context, scoped to one organization. */
export function scoped(ctx: ServerContext, organizationId: string): ServerContext {
  return organizationId === ctx.organizationId || !ctx.scope ? ctx : ctx.scope(organizationId);
}

/** An app and the context of the organization owning it. */
export async function appOwner(
  ctx: ServerContext,
  appKey: string,
): Promise<{ ctx: ServerContext; app: AgentApp } | undefined> {
  if (!ctx.appRecord) {
    const app = await ctx.store.get('app', appKey);

    return app && { ctx, app };
  }

  const found = await ctx.appRecord(appKey);

  return found && { ctx: scoped(ctx, found.organizationId), app: found.app };
}

/** The context of the workspace an installation key is bound to. */
export async function forInstallation(
  ctx: ServerContext,
  key: string,
): Promise<ServerContext | undefined> {
  if (ctx.boundInstallation?.installation.id === key)
    return {
      ...scoped(ctx, ctx.boundInstallation.organizationId),
      boundInstallation: ctx.boundInstallation,
    };
  if (!ctx.installationOrganization) return ctx;
  const organizationId = await ctx.installationOrganization(key);
  return organizationId === undefined ? undefined : scoped(ctx, organizationId);
}
