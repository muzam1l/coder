import { redirect, json, forbidden, toLogin, notFound, decodeParam } from './http';
import { dashPage, pagesFallback, toSignIn } from '../dash/serve';
import { registration } from '../settings/runners';
import { authorizeTask } from '../tasks/callbacks';
import { OPERATOR, type AppsContext } from '../agents/platform';
import { isLoginEngine, LOCAL_LOGINS } from '../tasks/local';
import { type Guard, type Params } from './match';
import { type CreateState } from '../../integrations/types';
import { nonceOrganization, nonceUser } from '../auth/nonce';
import { taskClaims, taskTokenHash } from '../tasks/token';
import { decryptSecret } from '../store/secrets';
import { safeEqual } from '../../utils/crypto';
import { scoped, type ServerContext } from '../context';
import { MCP_CLIENT_PATH } from '../connections/oauth';
import { LOCAL_SLUG } from '../auth/account';

export async function signedIn(
  req: Request,
  ctx: ServerContext,
): Promise<ServerContext | undefined> {
  if (!ctx.auth) return ctx;
  const session = await ctx.auth.session(req.headers);
  if (!session?.organizationId || session.organizationDenied) return undefined;
  return { ...scoped(ctx, session.organizationId), session };
}

const ADMIN_ROLES = new Set(['owner', 'admin']);

export function workspaceAdmin(ctx: ServerContext): boolean {
  return !ctx.auth || ADMIN_ROLES.has(ctx.session?.role ?? '');
}

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

export function loopbackRequest(req: Request): boolean {
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

export const runnerCallback = (pathname: string) =>
  pathname.startsWith('/tasks/') ||
  pathname.startsWith('/logins/') ||
  pathname === '/runners/register';

export const PLATFORM_PATHS = ['/hooks/', '/create/', '/install/', '/connect/'];

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

export function cookieToken(req: Request): string | null {
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

export async function provisioningAdmin(
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
  if (ctx.scope) ctx = scoped(ctx, claims.organization);
  if (ctx.organizationId !== claims.organization)
    return new Response('Unauthorized', { status: 401 });

  return ctx;
}

export async function taskGuard(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
  allowCompleted = false,
) {
  const id = params.id!;
  const token = bearerToken(req);
  if (token && ctx.taskOrganization && ctx.scope) {
    const organization = await ctx.taskOrganization(id!, taskTokenHash(token));
    if (organization) ctx = scoped(ctx, organization);
  }

  const authorized = await authorizeTask(req, ctx, id!, allowCompleted);

  return authorized instanceof Response ? authorized : { ...ctx, callbackTask: authorized };
}

export function completedTaskGuard(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return taskGuard(req, ctx, params, url, req.method === 'POST');
}

export function claimedOrganization(token: string): string | undefined {
  const { organization } = taskClaims(token);
  return typeof organization === 'string' ? organization : undefined;
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

export async function operatorTransaction(req: Request, url: URL): Promise<string | undefined> {
  const form = req.method === 'POST' ? new URLSearchParams(await req.clone().text()) : undefined;
  return (
    url.searchParams.get('tx') ??
    decodeParam<CreateState>(url.searchParams.get('state'))?.tx ??
    form?.get('tx') ??
    undefined
  );
}

export async function createAllowed(req: Request, ctx: AppsContext, params: Params, url: URL) {
  const tx = await operatorTransaction(req, url);
  const server = ctx.serverOrganizationId ?? ctx.organizationId;
  if (tx && nonceUser(ctx, tx) === OPERATOR && nonceOrganization(ctx, tx) === server)
    return { ...scoped(ctx, server), operatorApp: true };

  return provisioningAdmin(req, ctx);
}

export function installAllowed(req: Request, ctx: AppsContext, params: Params, url: URL) {
  return provisioningAdmin(req, ctx);
}

export async function oauthAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  const id = url.pathname.split('/')[2]!;
  const integration = /^[a-z0-9_-]+$/.test(id) ? ctx.integrations[params.integration!] : undefined;

  if (!integration?.auth.user || !ctx.auth || !ctx.config.publicUrl) return notFound();
  if (req.method !== 'GET') return ctx;
  const signed = await signedIn(req, ctx);
  return signed?.session ? { ...ctx, linkContext: signed } : toLogin(url);
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

export function adminGuard(guard?: Guard): Guard {
  return async (req, ctx, params, url) => {
    const checked = ctx.authorizedRequest === req ? ctx : await authorize(req, ctx);
    if (checked instanceof Response) return checked;

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
  return ctx.config.publicUrl && ctx.auth ? ctx : pagesFallback(req, ctx, url);
}
export async function accountAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (!ctx.auth) return authorize(req, ctx);
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return ctx;
  const session = await ctx.auth.session(req.headers);
  if (session?.organizationDenied)
    return json({ error: 'You are not a member of that workspace.' }, 403);
  if (!session) return json({ error: 'Sign in first.', hint: 'coder auth login' }, 401);
  return { ...ctx, session };
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
    return ctx.auth && req.method === 'GET' && (await dashPage(`${home}${page}`, ctx.dashboardHosts))
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
export async function tokenLinkAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  if (!['GET', 'POST'].includes(req.method)) return ctx;
  if (!ctx.auth) return notFound();
  if (req.headers.get('authorization')?.startsWith('Bearer '))
    return json({ error: 'Link your account from the browser.' }, 403);
  const signed = await signedIn(req, ctx);
  if (!signed?.session)
    return req.method === 'GET' ? toLogin(url) : json({ error: 'Sign in first.' }, 401);
  return { ...ctx, linkContext: signed };
}

export function apiAllowed(req: Request, ctx: ServerContext, params: Params, url: URL) {
  return !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || ctx.auth
    ? ctx
    : notFound();
}
