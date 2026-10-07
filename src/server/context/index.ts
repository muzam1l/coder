/** The server's request context and its configuration, and scoping it to one organization. */
import type { StateAdapter } from 'chat';
import type { JWK } from 'jose';

import type { Integration } from '../../integrations/types';
import type { Agent, AgentApp, AgentEvent, Installation, RunnerKind } from '../../agent/types';
import type { Runner } from '../runners';
import type { Store } from '../store/types';
import type { TaskQueue } from '../tasks/queue';

export interface ServerConfig {
  limits?: import('../limits').LimitsConfig;
  runner: RunnerKind;
  /** `memory` is for local testing only; `postgres` is a real deployment with sign-in. */
  store: 'memory' | 'postgres';
  workDir: string;
  encryptionKey?: string;
  previousEncryptionKey?: string;
  /** Bearer for `/admin/*` on a memory server, which has no sign-in; ignored with Postgres. */
  adminToken?: string;
  publicUrl?: string;
  /** What the dashboard calls this server; `Coder` unless set. */
  name?: string;
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
  /** `CLAUDE_SUBSCRIPTIONS` and `CODEX_SUBSCRIPTIONS`: subscription sign-in for personal credentials. */
  subscriptions?: { claude?: boolean; codex?: boolean };
  /** Wular, the identity provider; set for a Postgres server. */
  auth?: { wular: { url: string } };
  /** `SERVER_INTEGRATIONS`: the platforms this host offers, by id; every one when unset. */
  integrations?: string[];
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
  /** Set-Cookie values that store a refreshed session, for the response. */
  cookies?: string[];
  /** A bearer token older than a privileged action accepts; the client refreshes it and retries. */
  stale?: boolean;
}

/** What a link remembers besides the user: their workspaces then, and the encrypted platform user token. */
export interface LinkExtra {
  organizations?: string[];
  token?: string;
}

/** What the server needs from the sign-in layer; `src/server/auth/index.ts` builds it over Wular. */
export interface AuthApi {
  /** Wular's issuer URL. */
  issuer: string;
  /** The public keys of this server's client metadata document. */
  jwks: { keys: JWK[] };
  /** Handles `/api/auth/*`: sign-in, the OpenID callback, and sign-out. */
  handler(req: Request): Promise<Response>;
  /** `fresh` demands roles at most 60 seconds old, refreshing them from Wular first. */
  session(headers: Headers, fresh?: boolean): Promise<SessionInfo | undefined>;
  /** Switches the session's organization; `cookies` store the session for the response. */
  setOrganization(
    headers: Headers,
    slug: string,
  ): Promise<(OrganizationInfo & { cookies: string[] }) | undefined>;
  /** Connect a platform user to a Wular user; `taken` when another user already holds that identity. */
  link(
    user: SessionInfo['user'],
    platform: string,
    platformUserId: string,
    extra?: LinkExtra,
  ): Promise<'linked' | 'taken'>;
  linkedUser(
    platform: string,
    platformUserId: string,
  ): Promise<({ id: string; name: string; email: string } & LinkExtra) | undefined>;
}

export interface ServerContext {
  limits?: import('../limits').ServerLimits;
  /** The last healthy `/health` answer, reused for a few seconds. */
  health?: { at: number; body: unknown; status: number };
  databaseHealth?: () => Promise<void>;
  healthRunners?: () => Promise<{ online: number; total: number }>;
  config: ServerConfig;
  settings?: ServerSettings;
  authorizedRequest?: Request;
  dashboardHosts?: import('../dash/serve').DashboardHosts;
  requestScopes?: Map<string, import('../routes').RequestScope>;
  dbProfile?: import('../store/pg/profile').DatabaseProfile;
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
  };
  /** Resolve a callback tenant without exposing tasks from other organizations. */
  taskOrganization?(taskId: string, tokenHash: string): Promise<string | undefined>;
  /** The signed-in user behind this request, once resolved. */
  session?: SessionInfo;
  integrations: Record<string, Integration>;
  runners: Partial<Record<RunnerKind, Runner>>;
  store: Store;
  queue: TaskQueue;
  /** Chat SDK state for every app; a context without one keeps it for the request only. */
  chatState?: StateAdapter;
  /** Load the app's server-owned agent version and per-repository usage. */
  loadAgent(
    app: AgentApp,
    installation: Installation,
    event: AgentEvent,
    tokens: Record<string, string>,
  ): Promise<Agent>;
  /** Test or host override for outbound credential validation. */
  fetch?: typeof fetch;
  runnerExec?: typeof import('node:child_process').execFile;
  now?: () => number;
  waitUntil?: (work: Promise<unknown>) => void;
}

export interface ServerSettings {
  runnerInstances?: Map<string, { signature: string; runner: Runner }>;
  configUpdate?: Promise<unknown>;
  registry?: import('./cache').MemoryCache<import('../../client/types').Found[]>;
  probes?: import('./cache').MemoryCache<import('../../client/types').ProbeResult>;
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
