import { randomUUID } from 'node:crypto';
import { redirect, json, forbidden, toLogin, notFound, decodeParam } from './http';
import { dashboard, dashPage, toSignIn } from '../dash/serve';
import { registration } from '../settings/runners';
import { authorizeTask } from '../tasks/callbacks';
import { OPERATOR, type AppsContext } from '../agents/platform';
import { isLoginEngine, LOCAL_LOGINS } from '../tasks/local';
import { type Guard, type Params, type RouteOptions } from './match';
import { type CreateState } from '../agents/platform';
import { nonceOrganization, nonceUser } from '../auth/nonce';
import {
  canView,
  isTaskToken,
  principalContext,
  settingsProblem,
  taskClaims,
  taskPrincipal,
  taskTokenHash,
  viewer,
} from '../tasks/access';
import { eventTarget } from '../tasks/admin';
import { conversationTask } from '../tasks/conversation';
import type { AgentEvent } from '../../agent/types';
import { requestChange, type ChangeKind } from '../tasks/changes';
import { decryptSecret } from '../store/secrets';
import { type TaskStatus } from '../store/types';
import { safeEqual } from '../../utils/crypto';
import { chosenOrganization, scoped, type ServerContext, type SessionInfo } from '../context';
import { loadedStore } from '../store/primed';
import { MCP_CLIENT_PATH } from '../connections/oauth';
import { LOCAL_SLUG } from '../auth/members';

async function signedIn(req: Request, ctx: ServerContext): Promise<ServerContext | undefined> {
  if (!ctx.auth) return ctx;
  const session = await ctx.auth.session(req.headers);
  if (!session?.organizationId || session.organizationDenied) return undefined;
  return { ...scoped(ctx, session.organizationId), session };
}

const ADMIN_ROLES = new Set(['owner', 'admin']);

export const adminRole = (role: string | undefined) => ADMIN_ROLES.has(role ?? '');

export function workspaceAdmin(ctx: ServerContext): boolean {
  return !ctx.auth || adminRole(ctx.session?.role);
}

/** Whoever sees a task reads, stops and deletes it; anyone else finds no task. A 1:1 DM task is steered only by the member who asked. */
async function taskRefusal(
  ctx: ServerContext,
  status: TaskStatus,
  steer: boolean,
): Promise<Response | undefined> {
  const { task } = status;
  if (ctx.taskPrincipal && task.parent !== ctx.taskPrincipal.task)
    return json({ error: `No task "${task.id}"` }, 404);
  if (!canView(await viewer(ctx, [task.audience]), task))
    return json({ error: `No task "${task.id}"` }, 404);
  const dm = task.audience?.startsWith('dm:');
  if (steer && ctx.auth && dm && task.requestedBy !== ctx.session?.user.id)
    return json({ error: 'Only the member who asked can steer this task.' }, 403);

  return undefined;
}

export const taskAccess =
  (steer = false): Guard =>
  async (req, ctx, params) => {
    const status = await ctx.store.get('task', params.id!);
    // A task's store holds only its children, so a missing row is never a CLI task to fall back to.
    if (!status && ctx.taskPrincipal) return json({ error: `No task "${params.id}"` }, 404);

    if (!status) return ctx;

    return (await taskRefusal(ctx, status, steer)) ?? { ...ctx, routeTask: status };
  };

export function requireWorkspaceAdmin(ctx: ServerContext, error: string): ServerContext | Response {
  return workspaceAdmin(ctx) ? ctx : json({ error }, 403);
}

export function sameToken(given: string | null, expected: string | undefined): boolean {
  return Boolean(given && expected && safeEqual(given, expected));
}

export function bearerToken(req: Request): string | null {
  const value = req.headers.get('authorization');
  return value?.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
}

export const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function loopbackRequest(req: Request): boolean {
  if (req.headers.has('x-forwarded-for') || req.headers.has('x-forwarded-host')) return false;
  const host = req.headers.get('host') ?? new URL(req.url).host;
  try {
    return LOOPBACK.has(new URL(`http://${host}`).hostname);
  } catch {
    return false;
  }
}

export type ServerMode = 'local' | 'memory' | 'cloud';

export const serverMode = (ctx: ServerContext): ServerMode =>
  ctx.local ? 'local' : ctx.config.store === 'postgres' ? 'cloud' : 'memory';

const runnerCallback = (pathname: string) =>
  pathname.startsWith('/tasks/') ||
  pathname.startsWith('/logins/') ||
  pathname === '/runners/register';

const PLATFORM_PATHS = ['/hooks/', '/create/', '/install/', '/connect/'];

export function socketAllowed(address: string | undefined, path: string): boolean {
  const host = address?.replace(/^::ffff:/, '') ?? '';
  if (LOOPBACK.has(host) || host.startsWith('127.')) return true;
  // Parsed as the handler parses it, so dot segments cannot climb out of a platform path.
  const pathname = URL.parse(`http://localhost${path}`)?.pathname ?? '';
  return (
    pathname === MCP_CLIENT_PATH ||
    runnerCallback(pathname) ||
    PLATFORM_PATHS.some(prefix => pathname.startsWith(prefix))
  );
}

export function localHostAllowed(req: Request, ctx: ServerContext): boolean {
  if (!ctx.local) return true;
  const url = new URL(req.url);
  const host = req.headers.get('host') ?? url.host;
  const port = URL.parse(`http://${host}`)?.port || '80';
  if (loopbackRequest(req) && port === String(ctx.local.port)) return true;
  const tunnel = ctx.config.publicUrl ? new URL(ctx.config.publicUrl).host : undefined;
  const forwarded = req.headers.get('x-forwarded-host')?.split(',', 1)[0]?.trim();
  return (
    (forwarded ?? host) === tunnel &&
    !loopbackRequest(req) &&
    (url.pathname === MCP_CLIENT_PATH ||
      runnerCallback(url.pathname) ||
      PLATFORM_PATHS.some(prefix => url.pathname.startsWith(prefix)))
  );
}

export function sameOriginProof(req: Request, publicUrl?: string): boolean {
  const proof = req.headers.get('origin') ?? req.headers.get('referer');
  if (!proof) return false;
  try {
    return new URL(proof).origin === new URL(publicUrl ?? req.url).origin;
  } catch {
    return false;
  }
}

function cookieToken(req: Request): string | null {
  const value = req.headers
    .get('cookie')
    ?.split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('coder_admin='))
    ?.slice('coder_admin='.length);
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export async function authorize(
  req: Request,
  ctx: ServerContext,
): Promise<ServerContext | Response> {
  const bearer = bearerToken(req);
  if (bearer && isTaskToken(bearer)) return authorizeTaskPrincipal(req, ctx, bearer);
  if (!ctx.auth) {
    const unauthorized = () =>
      new Response('Unauthorized', {
        status: 401,
        headers: { 'www-authenticate': 'Bearer' },
      });
    if (ctx.config.store !== 'memory' || !loopbackRequest(req)) return unauthorized();
    const adminCookie = cookieToken(req);
    const bearer = sameToken(bearerToken(req), ctx.config.adminToken);
    const cookie = sameToken(adminCookie, ctx.config.adminToken);
    if (bearer) return { ...ctx, authorizedRequest: req };
    if (cookie)
      return req.method === 'GET' || sameOriginProof(req)
        ? { ...ctx, authorizedRequest: req }
        : forbidden();
    return unauthorized();
  }
  // Changes act on roles at most 60 seconds old.
  const session = await ctx.auth.session(req.headers, req.method !== 'GET');
  if (session?.stale)
    return json({ error: 'Token too old for this action.' }, 401, {
      'www-authenticate':
        'Bearer error="invalid_token", error_description="Token too old for this action"',
    });
  if (session?.organizationDenied)
    return json({ error: 'You are not a member of that workspace.' }, 403);
  const role = session?.role;
  if (!session?.organizationId || !role)
    return json(
      { error: 'Sign in first.', hint: 'coder auth login' },
      401,
      bearerToken(req) ? { 'www-authenticate': 'Bearer error="invalid_token"' } : {},
    );
  if (
    req.method !== 'GET' &&
    req.headers.has('cookie') &&
    !sameOriginProof(req, ctx.config.publicUrl)
  )
    return forbidden();
  // The request's own auth keeps collecting the cookies its response carries.
  return {
    ...scoped(ctx, session.organizationId),
    auth: ctx.auth,
    session,
    authorizedRequest: req,
  };
}

/** A task attempt token acts as its task while it runs, in the organization it claims. */
async function authorizeTaskPrincipal(
  req: Request,
  ctx: ServerContext,
  token: string,
): Promise<ServerContext | Response> {
  const claimed = await claimedScope(ctx, taskClaims(token).task, token);
  const principal = claimed && (await taskPrincipal(claimed, token));
  if (!claimed || !principal)
    return json({ error: 'The task has ended.' }, 401, {
      'www-authenticate': 'Bearer error="invalid_token"',
    });

  return { ...principalContext(claimed, principal), authorizedRequest: req };
}

/** A task starts children only as its own children, never by posting a platform event; an event acts only as the sender's own linked account, carries no trust the platform alone gives, and steers only a task its sender may steer. */
export async function taskCreateAllowed(req: Request, ctx: ServerContext) {
  const body = await req
    .clone()
    .json()
    .catch(() => undefined);
  const event = body?.event as AgentEvent | undefined;
  if (!event) return ctx;
  if (ctx.taskPrincipal) return json({ error: 'A task starts only its own child tasks.' }, 403);

  const actor = event.actor;
  if (actor?.agent !== undefined || actor?.role !== undefined)
    return json({ error: "Only the platform sets an event actor's role." }, 403);
  const target = await eventTarget(ctx, body);
  if (target instanceof Response) return target;
  const steered = await conversationTask(ctx, target.event);

  return (steered && (await taskRefusal(ctx, steered, true))) || ctx;
}

/** Whether a task's call on a `confirm` route waits for a person: always, except its own agent's engine, model and effort. */
async function needsConfirm(
  req: Request,
  ctx: ServerContext,
  kind: ChangeKind,
  params: Params,
): Promise<boolean> {
  if (kind !== 'agent-settings' || params.slug !== ctx.taskPrincipal?.agent) return true;
  const body = await req
    .clone()
    .json()
    .catch(() => undefined);
  const current = (await ctx.store.get('agent', params.slug!))?.settings;

  return Boolean(settingsProblem(current, body));
}

/** A task changes only its own agent's engine, model and effort, for the linked member who asked. */
export async function agentSettingsAllowed(req: Request, ctx: ServerContext, params: Params) {
  const principal = ctx.taskPrincipal;
  if (!principal) return ctx;
  if (params.slug !== principal.agent)
    return json({ error: 'A task changes only its own agent.' }, 403);
  if (!principal.asker)
    return json({ error: 'Changing the agent needs a linked member asking.' }, 403);
  const body = await req
    .clone()
    .json()
    .catch(() => undefined);
  const current = (await ctx.store.get('agent', params.slug!))?.settings;
  const problem = settingsProblem(current, body);

  return problem ? json({ error: problem }, 403) : ctx;
}

async function provisioningAdmin(
  req: Request,
  ctx: ServerContext,
): Promise<ServerContext | Response> {
  if (!ctx.auth) return ctx;
  const headers = new Headers(req.headers);
  const selected = new URL(req.url).searchParams.get('organization');
  if (selected) headers.set('x-coder-organization', selected);
  const session = await ctx.auth.session(headers, true);
  if (session?.organizationDenied)
    return new Response('You are not a member of that workspace.', {
      status: 403,
    });
  const role = session?.role;
  if (!session?.organizationId || !role) return toLogin(new URL(req.url));
  return { ...scoped(ctx, session.organizationId), session };
}

export async function runnerPrincipal(
  req: Request,
  base: ServerContext,
): Promise<string | undefined> {
  if (req.method !== 'POST') return;

  const parsed = registration.safeParse(
    await req
      .clone()
      .json()
      .catch(() => undefined),
  );
  if (!parsed.success || parsed.data.token) return;

  const { id, organizationId, secret } = parsed.data;
  if (!id || !organizationId || (organizationId !== base.organizationId && !base.scope)) return;

  const ctx = scoped(base, organizationId);
  const runner = await ctx.store.get('runner', id);
  if (
    runner?.kind === 'http' &&
    safeEqual(decryptSecret<Record<string, string>>(ctx.config, runner.secret).secret ?? '', secret)
  )
    return `runner:${organizationId}:${id}`;
}

export async function inboxGuard(req: Request, ctx: ServerContext, params: Params, url: URL) {
  const id = params.id!;
  const token = bearerToken(req);
  if (!token) return new Response('Unauthorized', { status: 401 });

  const claims = taskClaims(token);
  if (
    claims.task !== id ||
    typeof claims.organization !== 'string' ||
    !claims.organization ||
    !Number.isInteger(claims.attempt)
  )
    return new Response('Unauthorized', { status: 401 });
  const claimed = await claimedScope(ctx, id, token);
  if (claimed?.organizationId !== claims.organization)
    return new Response('Unauthorized', { status: 401 });

  return claimed;
}

export async function taskGuard(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
  allowCompleted = false,
  include?: 'secrets' | 'context',
) {
  const id = params.id!;
  const token = bearerToken(req);
  const claimed = token ? await claimedScope(ctx, id, token) : ctx;
  if (!claimed) return new Response('Unauthorized', { status: 401 });
  ctx = claimed;

  const authorized = await authorizeTask(req, ctx, id!, allowCompleted, include);
  if (authorized instanceof Response) return authorized;
  const { status, loaded } = authorized;

  return {
    ...ctx,
    ...(loaded ? { store: loadedStore(ctx.store, status, loaded) } : {}),
    ...(loaded?.workspace ? { callbackWorkspace: loaded.workspace } : {}),
    callbackTask: status,
  };
}

/** A task guard that loads `include` with the task; a callback that redacts still reports for a finished task. */
const loading =
  (include: 'secrets' | 'context', allowCompleted: (req: Request) => boolean) =>
  (req: Request, ctx: ServerContext, params: Params, url: URL) =>
    taskGuard(req, ctx, params, url, allowCompleted(req), include);
export const secretsGuard = loading('secrets', req => req.method === 'POST');
export const credentialGuard = loading('secrets', () => false);
export const logsGuard = loading('secrets', () => true);
export const contextGuard = loading('context', () => false);

function claimedOrganization(token: string): string | undefined {
  const { organization } = taskClaims(token);
  return typeof organization === 'string' ? organization : undefined;
}

/** The context of the organization a task token claims, opened only once that task there holds the token. */
async function claimedScope(
  ctx: ServerContext,
  task: string | undefined,
  token: string,
): Promise<ServerContext | undefined> {
  const organization = claimedOrganization(token);
  if (!organization || !ctx.scope || organization === ctx.organizationId) return ctx;
  if (!task || (await ctx.taskOrganization?.(task, taskTokenHash(token))) !== organization) return;

  return scoped(ctx, organization);
}

export async function loginGuard(req: Request, base: ServerContext, params: Params) {
  const token = bearerToken(req);
  if (!token) return new Response('Unauthorized', { status: 401 });

  const organization = claimedOrganization(token);
  const ctx =
    organization && base.scope && organization !== base.organizationId
      ? scoped(base, organization)
      : base;
  const id = params.id!;
  const found = await ctx.store.get('login', id);
  if (!found || !safeEqual(taskTokenHash(token), found.tokenHash))
    return new Response('Unauthorized', { status: 401 });

  return { ...ctx, callbackLogin: found };
}

async function operatorTransaction(req: Request, url: URL): Promise<string | undefined> {
  const form = req.method === 'POST' ? new URLSearchParams(await req.clone().text()) : undefined;
  return (
    url.searchParams.get('tx') ??
    decodeParam<CreateState>(url.searchParams.get('state'))?.tx ??
    form?.get('tx') ??
    undefined
  );
}

export async function createAllowed(req: Request, ctx: AppsContext, params: Params, url: URL) {
  if (!/^[a-z0-9_-]+$/.test(params.integration ?? params.id ?? '')) return dashboard(req, ctx);
  const tx = await operatorTransaction(req, url);
  const server = ctx.serverOrganizationId ?? ctx.organizationId;
  if (tx && nonceUser(ctx, tx) === OPERATOR && nonceOrganization(ctx, tx) === server)
    return { ...scoped(ctx, server), operatorApp: true };

  return provisioningAdmin(req, ctx);
}

export function installAllowed(req: Request, ctx: AppsContext, params: Params, url: URL) {
  if (!/^[a-z0-9_-]+$/.test(params.integration ?? params.id ?? '')) return dashboard(req, ctx);
  return provisioningAdmin(req, ctx);
}

export async function oauthAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (!/^[a-z0-9_-]+$/.test(params.integration ?? '')) return dashboard(req, ctx);
  const integration = ctx.integrations[params.integration!];

  if (!integration?.auth.user || !ctx.auth || !ctx.config.publicUrl) return notFound();
  if (req.method !== 'GET') return ctx;
  const signed = await signedIn(req, ctx);
  return signed?.session ? signed : toLogin(url);
}

export async function connectionOAuthAllowed(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
) {
  if (ctx.local && !ctx.auth) return localOnly(req, ctx);
  if (!ctx.auth) return notFound();
  const signed = await signedIn(req, ctx);

  return signed?.session ? signed : toLogin(url);
}

export function adminOnly(req: Request, ctx: ServerContext) {
  return requireWorkspaceAdmin(ctx, 'Workspace admin access is required.');
}

/** `SERVER_OPERATORS` with a signed-in session; on a server without sign-in, whoever holds the admin token. */
export const operator = (ctx: ServerContext, session = ctx.session) =>
  !ctx.auth || Boolean(session && ctx.config.operators?.includes(session.user.id));

/** Operator routes answer 404 to everyone else, and 401 once the operator session ends. */
export async function operatorOnly(req: Request, ctx: ServerContext) {
  if (!operator(ctx)) return notFound();
  if (ctx.auth && (await ctx.auth.operator(req.headers)) !== ctx.session!.user.id)
    return json({ error: 'Operator mode ended. Sign in again to continue.' }, 401);

  return ctx;
}

export async function operatorPageAllowed(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
) {
  const allowed = await dashboardAllowed(req, ctx, params, url);
  if (allowed instanceof Response || !ctx.auth) return allowed;
  if (!operator(ctx, await ctx.auth.session(req.headers))) return notFound();

  // Renews the operator cookie before the page streams.
  await ctx.auth.operator(req.headers);

  return allowed;
}

export function localOnly(req: Request, ctx: ServerContext) {
  return ctx.local ? ctx : notFound();
}

export function loginAllowed(req: Request, ctx: ServerContext) {
  if (ctx.local) return json({ error: LOCAL_LOGINS }, 400);
  return ctx.session?.user.id ? ctx : json({ error: 'Sign in to use a subscription.' }, 403);
}

export function adminGuard(guard?: Guard, route?: RouteOptions): Guard {
  return async (req, ctx, params, url) => {
    const checked = ctx.authorizedRequest === req ? ctx : await authorize(req, ctx);
    if (checked instanceof Response) return checked;
    if (checked.taskPrincipal && !route?.approvalPolicy)
      return json({ error: 'Not available to a task.' }, 403);
    if (
      checked.taskPrincipal &&
      route?.approvalPolicy === 'ask' &&
      (await needsConfirm(req, checked, route.change, params))
    )
      return requestChange(req, checked, route.change, params);

    return guard ? guard(req, checked, params, url) : checked;
  };
}

export function engineAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (req.method !== (params.engine ? 'POST' : 'GET')) return ctx;
  if (!ctx.local || (params.engine && !isLoginEngine(params.engine)))
    return json(
      {
        error: params.engine
          ? 'Engine sign-in is available on a local server only'
          : 'Engine status is available on a local server only',
      },
      404,
    );

  return ctx;
}

export async function metadataAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return ctx.config.publicUrl && ctx.auth ? ctx : dashboard(req, ctx);
}
export async function accountAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (!ctx.auth) return authorize(req, ctx);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return ctx;
  const session = await ctx.auth.session(req.headers);
  if (session?.organizationDenied)
    return json({ error: 'You are not a member of that workspace.' }, 403);
  if (!session) return json({ error: 'Sign in first.', hint: 'coder auth login' }, 401);
  return { ...(session.organizationId ? scoped(ctx, session.organizationId) : ctx), session };
}
export function dashboardTokenAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (req.method !== 'POST') return ctx;
  if (ctx.auth || ctx.config.store !== 'memory' || !loopbackRequest(req)) return notFound();
  return sameOriginProof(req) ? ctx : forbidden();
}
export async function pageSession(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (req.method !== 'GET') return ctx;
  return { ...ctx, session: (await signedIn(req, ctx))?.session };
}
export async function signInAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return ctx;
  return ctx.auth && (await signedIn(req, ctx))?.session ? redirect('/dash') : ctx;
}
export async function dashboardAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return ctx;
  // `/dash/<org>/…` shows that organization; the page's own loads ask for it the same way, so the session resolves once.
  const segment = url.pathname.split('/')[2] ?? '';
  const headers = new Headers(req.headers);
  headers.delete('x-coder-organization');
  if (segment) headers.set('x-coder-organization', segment);
  const session = await ctx.auth?.session(headers);
  if (session && !session.organizations.length)
    return ctx.auth!.handler(
      new Request(
        url.origin + '/api/auth/sign-in?return=' + encodeURIComponent(url.pathname + url.search),
      ),
    );
  if (ctx.auth && !session) return toSignIn(req, ctx, url, url.pathname + url.search);

  const organizations = session?.organizations ?? [
    { id: ctx.organizationId, slug: LOCAL_SLUG, name: '', role: 'owner' },
  ];
  const org = organizations.find(entry => encodeURIComponent(entry.slug) === segment);
  // A path without one opens in the active organization, an id at its slug.
  if (!org) {
    const named = organizations.find(entry => encodeURIComponent(entry.id) === segment);
    const active = (await ctx.auth?.session(req.headers))?.organizationId;
    const to = named ?? organizations.find(entry => entry.id === active) ?? organizations[0]!;
    const home = `/dash/${encodeURIComponent(to.slug)}`;
    const page = url.pathname.slice(`/dash/${segment}`.length);
    if (named) return redirect(`${home}${page}${url.search}`);
    const target = `${home}${url.pathname.slice('/dash'.length)}`;
    if (await dashPage(target, ctx.dashboardHosts)) return redirect(`${target}${url.search}`);

    // Another workspace's page, or one that does not exist: the active one says so and offers another account.
    return ctx.auth &&
      req.method === 'GET' &&
      (await dashPage(`${home}${page}`, ctx.dashboardHosts))
      ? redirect(`${home}/agents?${new URLSearchParams({ link: url.pathname + url.search })}`)
      : notFound();
  }
  if (!ctx.auth) return ctx;

  // It becomes the session's active organization, so the page's own API calls act on it.
  await ctx.auth.setOrganization(req.headers, org.slug);
  return { ...scoped(ctx, org.id), session: session! };
}
export function credentialAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return req.method === 'POST' && ctx.local ? json({ error: LOCAL_LOGINS }, 400) : ctx;
}

export function apiAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || ctx.auth
    ? ctx
    : notFound();
}

export const REQUEST_SCOPE_HEADER = 'x-coder-request-scope';

export type RequestScope = {
  sessions: Map<string, Promise<SessionInfo | undefined>>;
  operators: Map<string, Promise<string | undefined>>;
  /** Refreshed or cleared session cookies the response carries. */
  cookies: string[];
};

function shareSessions(
  ctx: ServerContext,
  { sessions, operators, cookies }: RequestScope,
): ServerContext {
  const auth = ctx.auth;
  if (!auth) return ctx;
  return {
    ...ctx,
    auth: {
      ...auth,
      // One lookup per credential; an organization the request names is picked from it.
      session(headers, fresh) {
        const key = JSON.stringify([
          ...['cookie', 'authorization'].map(name => headers.get(name)),
          Boolean(fresh),
        ]);
        let found = sessions.get(key);
        if (!found) {
          const own = new Headers(headers);
          own.delete('x-coder-organization');
          found = auth.session(own, fresh, cookies);
          sessions.set(key, found);
        }
        const wanted = headers.get('x-coder-organization');
        return wanted
          ? found.then(info => info && (info.stale ? info : chosenOrganization(info, wanted)))
          : found;
      },
      setOrganization: (headers, slug) => auth.setOrganization(headers, slug, cookies),
      operator(headers) {
        const key = headers.get('cookie') ?? '';
        let found = operators.get(key);
        if (!found) {
          found = auth.operator(headers, cookies);
          operators.set(key, found);
        }
        return found;
      },
    },
  };
}

export function requestScope(req: Request, ctx: ServerContext, inProcess: boolean) {
  const scopes = (ctx.requestScopes ??= new Map());
  const given = req.headers.get(REQUEST_SCOPE_HEADER);
  const live = inProcess && given ? scopes.get(given) : undefined;
  if (live) return { req, ctx: shareSessions(ctx, live), end() {} };
  const headers = new Headers(req.headers);
  headers.delete(REQUEST_SCOPE_HEADER);
  if (!ctx.auth) return { req: given ? new Request(req, { headers }) : req, ctx, end() {} };
  const id = randomUUID();
  const scope: RequestScope = { sessions: new Map(), operators: new Map(), cookies: [] };
  scopes.set(id, scope);
  headers.set(REQUEST_SCOPE_HEADER, id);
  return {
    req: new Request(req, { headers }),
    ctx: shareSessions(ctx, scope),
    cookies: scope.cookies,
    end: () => scopes.delete(id),
  };
}
