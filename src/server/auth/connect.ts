import { type Params } from '../routes/match';
import { type AgentApp } from '../../agent/types';
import { escapeHtml, htmlResponse } from '../../utils/html';
import { consumeBoundNonce, inspectNonce, issueNonce, nonceOrganization } from './nonce';
import { scoped, type ServerContext, type SessionInfo } from '../context';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { serveDash } from '../dash/serve';
import { json, redirect } from '../routes/http';

const page = (body: string, status = 200) =>
  htmlResponse(`<title>Coder</title><p>${escapeHtml(body)}</p>`, status);

function memberOf(
  ctx: ServerContext,
  session: SessionInfo,
  organization: string | undefined,
): ServerContext | undefined {
  return organization && session.organizations.some(entry => entry.id === organization)
    ? { ...scoped(ctx, organization), session }
    : undefined;
}

async function appOf(ctx: ServerContext, key: string): Promise<AgentApp | undefined> {
  const installation = await ctx.store.get('installation', key);

  return installation && !installation.deletedAt
    ? ctx.store.get('app', installation.app)
    : undefined;
}

export async function startTokenLink(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const signed = (ctx as ServerContext & { linkContext: ServerContext }).linkContext;
  const session = signed.session!;
  // The token resolves in the workspace it was issued for, when the user belongs to it.
  const issuedIn = (token: string) => {
    const organization = nonceOrganization(signed, token);

    return organization && session.organizations.some(o => o.id === organization)
      ? { ...scoped(signed, organization), session }
      : signed;
  };
  const token = url.searchParams.get('token') ?? '';
  const member = issuedIn(token);
  if (await inspectNonce(member, token, 'link', session.user.id))
    return (
      (await serveDash(req, undefined, ctx.dashboardHosts)) ??
      new Response('UI is not built', { status: 503 })
    );

  const target = await consumeBoundNonce(member, token, 'link-start', session.user.id);
  if (!target)
    return new Response('This link is invalid or has expired.', {
      status: 400,
    });

  const confirmation = await issueNonce(member, 'link', session.user.id, target, 5 * 60 * 1000);

  return redirect(`/connect?token=${encodeURIComponent(confirmation)}`);
}

export async function confirmTokenLink(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const signed = (ctx as ServerContext & { linkContext: ServerContext }).linkContext;
  const session = signed.session!;
  // The token resolves in the workspace it was issued for, when the user belongs to it.
  const issuedIn = (token: string) => {
    const organization = nonceOrganization(signed, token);

    return organization && session.organizations.some(o => o.id === organization)
      ? { ...scoped(signed, organization), session }
      : signed;
  };
  const body = (await req.json().catch(() => ({}))) as {
    token?: unknown;
  };
  const target =
    typeof body.token === 'string'
      ? await consumeBoundNonce(issuedIn(body.token), body.token, 'link', session.user.id)
      : undefined;
  if (!target) return json({ error: 'This link is invalid or has expired.' }, 400);

  const claim = JSON.parse(target) as {
    platform: string;
    platformUserId: string;
  };
  const result = await ctx.auth!.link(session.user, claim.platform, claim.platformUserId, {
    organizations: session.organizations.map(o => o.id),
  });
  if (result === 'taken')
    return json({ error: 'That platform account is connected to someone else.' }, 409);

  return json({ ok: true, ...claim });
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
  const session = (ctx as ServerContext & { linkContext: ServerContext }).linkContext.session!;
  const key = url.searchParams.get('installation') ?? '';
  const member = memberOf(
    ctx,
    session,
    key ? await ctx.installationOrganization?.(key) : undefined,
  );
  if (!member)
    return page('Only members of the workspace this agent works for can link here.', 403);

  const app = await appOf(member, key);
  if (!app) return page('This installation is no longer connected.', 404);

  const state = await issueNonce(member, 'link-oauth', session.user.id, key);

  return redirect(
    userAuth.authorizeUrl(decryptSecret(ctx.config, app.credentials), {
      publicUrl,
      state,
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
  const session = (ctx as ServerContext & { linkContext: ServerContext }).linkContext.session!;
  const state = url.searchParams.get('state') ?? '';
  const member = memberOf(ctx, session, nonceOrganization(ctx, state));
  const key = member && (await consumeBoundNonce(member, state, 'link-oauth', session.user.id));
  const app = member && key ? await appOf(member, key) : undefined;
  if (!member || !app) return page('This link is invalid or has expired.', 400);

  const user = await userAuth
    .exchange(req, decryptSecret(ctx.config, app.credentials), {
      publicUrl,
      fetch: ctx.fetch ?? fetch,
    })
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (user instanceof Error) return page(user.message, 400);

  const result = await ctx.auth!.link(session.user, integration.id, user.id, {
    organizations: session.organizations.map(entry => entry.id),
    ...(user.token ? { token: encryptSecret(ctx.config, user.token) } : {}),
  });
  if (result === 'taken')
    return page(`That ${integration.id} account is connected to someone else.`, 409);

  return page(
    `Linked ${user.login ?? user.id} on ${integration.id} to your Coder account. Mention the agent again to start.`,
  );
}
