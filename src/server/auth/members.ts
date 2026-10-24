/** Who a member is: their workspaces and roles, and the platform accounts they connect. */
import { type Connection } from '../../agent/types';
import { outcome } from '../agents/platform';
import { completeAuthorization } from '../connections/oauth';
import { nativeApp, needsReconnect } from '../connections/records';
import { linkedOrganizations, scoped, type ServerContext, type SessionInfo } from '../context';
import { consumeBoundNonce, issueNonce, nonceOrganization } from './nonce';
import { operator, serverMode } from '../routes/guards';
import { json, redirect, safeReturnPath } from '../routes/http';
import { type Params } from '../routes/match';
import { decryptSecret, encryptSecret } from '../store/secrets';

/** A server without accounts has one workspace, at `/dash/local`. */
export const LOCAL_SLUG = 'local';

export async function meRoute(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const reconnect =
    (!ctx.auth || ctx.session?.organizationId) &&
    (await needsReconnect(ctx, ctx.session?.user.id).catch(() => false));
  if (!ctx.auth) {
    return json({
      mode: serverMode(ctx),
      organization: { id: ctx.organizationId, slug: LOCAL_SLUG },
      server: serverInfo(ctx),
      operator: operator(ctx),
      ...(reconnect ? { reconnect } : {}),
    });
  }

  const session = ctx.session!;

  return json({
    mode: serverMode(ctx),
    user: session.user,
    organization:
      session.organizations.find(candidate => candidate.id === session.organizationId) ?? null,
    organizations: session.organizations,
    manageMembersUrl: `${ctx.auth.issuer}/auth/onboarding`,
    server: serverInfo(ctx),
    operator: operator(ctx, session),
    ...(reconnect ? { reconnect } : {}),
  });
}

function serverInfo(ctx: ServerContext) {
  return {
    name: ctx.config.name ?? 'Coder',
    store: ctx.config.store,
    ...(ctx.config.publicUrl ? { url: ctx.config.publicUrl } : {}),
    issuesUrl: ctx.config.issuesUrl,
    subscriptions: {
      claude: Boolean(ctx.config.subscriptions?.claude),
      codex: Boolean(ctx.config.subscriptions?.codex),
    },
  };
}

/** The slug of `ctx`'s organization from its session, else of the session's active one; else the organization id, which the dashboard sends on to the slug. */
export function sessionSlug(ctx: ServerContext): string {
  const organizations = ctx.session?.organizations ?? [];
  const org =
    organizations.find(entry => entry.id === ctx.organizationId) ??
    organizations.find(entry => entry.id === ctx.session?.organizationId);

  return org?.slug ?? (ctx.auth ? ctx.organizationId : LOCAL_SLUG);
}

/** The same without a session, such as for a link posted to a platform: the slug as Wular last named it. `workspace` is the workspace row when read already; one without a slug has had no member sign in. */
export async function organizationSlug(
  ctx: ServerContext,
  workspace?: { slug?: string },
): Promise<string> {
  const known =
    ctx.session?.organizations.find(org => org.id === ctx.organizationId)?.slug ?? workspace?.slug;

  if (known || !ctx.auth) return known ?? LOCAL_SLUG;
  if (workspace) return ctx.organizationId;

  return (await ctx.auth.organization?.(ctx.organizationId))?.slug ?? ctx.organizationId;
}

/** A dashboard page of the organization `slug`, such as `/tasks/<id>`; without one, the dashboard opens it in the active organization. */
export const dashPath = (slug: string, page = '') =>
  slug ? `/dash/${encodeURIComponent(slug)}${page}` : `/dash${page}`;

/** The session's context in `organization`, when they belong to it. */
export function memberOf(
  ctx: ServerContext,
  session: SessionInfo,
  organization: string | undefined,
): ServerContext | undefined {
  const membership = organization && session.organizations.find(entry => entry.id === organization);

  return membership
    ? {
        ...scoped(ctx, membership.id),
        session: {
          ...session,
          organizationId: membership.id,
          role: membership.id === session.organizationId ? session.role : membership.role,
        },
      }
    : undefined;
}

export async function startOAuth(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const integration = ctx.integrations[params.integration!]!;
  const userAuth = integration.auth.user!;
  const publicUrl = ctx.config.publicUrl!;
  const session = ctx.session!;
  // A flow started in the dashboard returns there; one from a platform thread ends on the setup page.
  const asked = safeReturnPath(url.searchParams.get('return'), url.origin);
  const back = asked.startsWith('/dash/') ? asked : undefined;
  const member = memberOf(
    ctx,
    session,
    url.searchParams.get('organization') ?? session.organizationId,
  );
  const connectionId = url.searchParams.get('connection');
  const connection = member && connectionId && (await member.store.get('connection', connectionId));
  if (
    !member ||
    !connection ||
    connection.provider !== integration.id ||
    connection.auth !== 'oauth' ||
    connection.owner !== session.user.id
  )
    return json({ error: 'Unknown OAuth connection' }, 404);
  const app = await nativeApp(member, integration.id);
  if (!app) return json({ error: `No OAuth client is available for ${integration.name}.` }, 400);
  const state = await issueNonce(
    member,
    'native-oauth',
    session.user.id,
    JSON.stringify({ connection, app: app.id, attempt: url.searchParams.get('attempt'), back }),
  );

  return redirect(
    userAuth.authorizeUrl(decryptSecret(ctx.config, app.credentials), {
      publicUrl,
      state,
      access: connection.access ?? 'auto',
    }),
  );
}

export async function completeOAuth(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const integration = ctx.integrations[params.integration!]!;
  const userAuth = integration.auth.user!;
  const publicUrl = ctx.config.publicUrl!;
  const session = ctx.session!;
  const state = url.searchParams.get('state') ?? '';
  const member = memberOf(ctx, session, nonceOrganization(ctx, state));
  const landing = member ?? { ...ctx, session };
  const native =
    member && (await consumeBoundNonce(member, state, 'native-oauth', session.user.id));
  if (!member || !native) return outcome(landing, 'link-expired', { platform: integration.id });
  const target = JSON.parse(native) as {
    connection: Connection;
    app: string;
    attempt?: string;
    back?: string;
  };
  const back = target.back;
  const original = target.connection;
  if (original.provider !== integration.id || original.owner !== session.user.id)
    return outcome(landing, 'link-expired', { platform: integration.id }, back);
  const app = await nativeApp(member, integration.id, target.app);
  if (!app) return outcome(landing, 'link-expired', { platform: integration.id }, back);

  return member.store.withAppLock(`connection:${original.id}`, async store => {
    const current = await store.get('connection', original.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(original))
      return outcome(landing, 'link-expired', { platform: integration.id }, back);
    const user = await userAuth
      .exchange(req, decryptSecret(ctx.config, app.credentials), {
        publicUrl,
        access: current.access ?? 'auto',
        fetch: ((input, init) =>
          (ctx.fetch ?? fetch)(input, {
            ...init,
            redirect: 'manual',
            signal: AbortSignal.timeout(5000),
          })) as typeof fetch,
      })
      .catch((error: unknown) => {
        console.error(`coder server: ${integration.id} connection sign-in failed`, error);
      });
    if (!user?.token) return outcome(landing, 'failed', { platform: integration.id }, back);
    const result = await ctx.auth!.link(
      session.user,
      integration.id,
      user.id,
      {
        ...linkedOrganizations(session.organizations),
        token: encryptSecret(ctx.config, { app: app.id, token: user.token }),
        organizationId: member.organizationId,
        ...(user.login ? { login: user.login } : {}),
      },
      store,
    );
    if (result === 'taken')
      return outcome(landing, 'account-taken', { platform: integration.id }, back);
    await store.put('connection', current.id, {
      ...current,
      account: user.id,
      oauthApp: app.id,
      secret: undefined,
      broken: undefined,
      updatedAt: (ctx.now ?? Date.now)(),
    });
    if (target.attempt) await completeAuthorization({ ...member, store }, current, target.attempt);

    return outcome(
      landing,
      'linked',
      { platform: integration.id, account: user.login ?? user.id },
      back,
    );
  });
}
