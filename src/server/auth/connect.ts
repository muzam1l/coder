import { type Params } from '../routes/match';
import { type AgentApp } from '../../agent/types';
import { consumeBoundNonce, inspectNonce, issueNonce, nonceOrganization } from './nonce';
import { scoped, type ServerContext, type SessionInfo } from '../context';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { serveDash } from '../dash/serve';
import { json, redirect } from '../routes/http';
import { outcome } from '../agents/platform';
import { IntegrationError } from '../../integrations/types';
import { completeNativeConnection, nativeApp } from '../connections/records';
import { requireWorkspaceAdmin } from '../routes/guards';
import type { Connection } from '../../agent/types';
import { completeAuthorization } from '../connections/oauth';

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
  const connectionId = url.searchParams.get('connection');
  if (connectionId) {
    const member = memberOf(
      ctx,
      session,
      url.searchParams.get('organization') ?? session.organizationId,
    );
    const connection = member && (await member.store.get('connection', connectionId));
    if (
      !member ||
      !connection ||
      connection.provider !== integration.id ||
      connection.auth !== 'oauth'
    )
      return json({ error: 'Unknown OAuth connection' }, 404);
    if (connection.owner && connection.owner !== session.user.id)
      return json({ error: 'Unknown OAuth connection' }, 404);
    if (!connection.owner) {
      const allowed = requireWorkspaceAdmin(
        member,
        'Only workspace owners and admins can authorize workspace connections',
      );
      if (allowed instanceof Response) return allowed;
    }
    const app = await nativeApp(member, integration.id);
    if (!app) return json({ error: `No OAuth client is available for ${integration.name}.` }, 400);
    const state = await issueNonce(
      member,
      'native-oauth',
      session.user.id,
      JSON.stringify({ connection, app: app.id, attempt: url.searchParams.get('attempt') }),
    );

    return redirect(
      userAuth.authorizeUrl(decryptSecret(ctx.config, app.credentials), {
        publicUrl,
        state,
        access: connection.access,
      }),
    );
  }
  const key = url.searchParams.get('installation') ?? '';
  const member = memberOf(
    ctx,
    session,
    key ? await ctx.installationOrganization?.(key) : undefined,
  );
  if (!member) return outcome(ctx, 'not-member', { platform: integration.id });

  const app = await appOf(member, key);
  if (!app || app.integration !== integration.id)
    return outcome(ctx, 'disconnected', { platform: integration.id });

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
  const native =
    member && (await consumeBoundNonce(member, state, 'native-oauth', session.user.id));
  if (member && native) {
    const target = JSON.parse(native) as { connection: Connection; app: string; attempt?: string };
    const original = target.connection;
    if (original.provider !== integration.id)
      return outcome(ctx, 'link-expired', { platform: integration.id });
    if (!original.owner) {
      const allowed = requireWorkspaceAdmin(
        member,
        'Only workspace owners and admins can authorize workspace connections',
      );
      if (allowed instanceof Response) return allowed;
    } else if (original.owner !== session.user.id)
      return outcome(ctx, 'link-expired', { platform: integration.id });
    const app = await nativeApp(member, integration.id, target.app);
    if (!app) return outcome(ctx, 'link-expired', { platform: integration.id });

    return member.store.withAppLock(`connection:${original.id}`, async store => {
      const current = await store.get('connection', original.id);
      if (!current || JSON.stringify(current) !== JSON.stringify(original))
        return outcome(ctx, 'link-expired', { platform: integration.id });
      const user = await userAuth
        .exchange(req, decryptSecret(ctx.config, app.credentials), {
          publicUrl,
          access: current.access,
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
      if (!user?.token) return outcome(ctx, 'failed', { platform: integration.id });
      if (current.owner) {
        const result = await ctx.auth!.link(
          session.user,
          integration.id,
          user.id,
          {
            organizations: session.organizations.map(entry => entry.id),
            token: encryptSecret(ctx.config, { app: app.id, token: user.token }),
          },
          store,
        );
        if (result === 'taken') return outcome(ctx, 'account-taken', { platform: integration.id });
      }
      await store.put('connection', current.id, {
        ...current,
        account: current.owner ? user.id : (user.login ?? user.id),
        oauthApp: current.owner ? app.id : undefined,
        secret: current.owner
          ? undefined
          : encryptSecret(ctx.config, { app: app.id, token: user.token }),
        broken: undefined,
        updatedAt: (ctx.now ?? Date.now)(),
      });
      if (target.attempt)
        await completeAuthorization({ ...member, store }, current, target.attempt);

      return outcome(ctx, 'linked', { platform: integration.id, account: user.login ?? user.id });
    });
  }
  const key = member && (await consumeBoundNonce(member, state, 'link-oauth', session.user.id));
  const app = member && key ? await appOf(member, key) : undefined;
  if (!member || !app || app.integration !== integration.id)
    return outcome(ctx, 'link-expired', { platform: integration.id });

  const user = await userAuth
    .exchange(req, decryptSecret(ctx.config, app.credentials), {
      publicUrl,
      fetch: ctx.fetch ?? fetch,
    })
    .catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  if (user instanceof IntegrationError)
    return outcome(ctx, user.code, { platform: integration.id, error: user.error });
  if (user instanceof Error) {
    console.error(`coder server: ${integration.id} sign-in failed`, user);

    return outcome(ctx, 'failed', { platform: integration.id });
  }

  const result = await ctx.auth!.link(session.user, integration.id, user.id, {
    organizations: session.organizations.map(entry => entry.id),
    ...(user.token ? { token: encryptSecret(ctx.config, { app: app.id, token: user.token }) } : {}),
  });
  if (result === 'taken') return outcome(ctx, 'account-taken', { platform: integration.id });
  await completeNativeConnection(member, session.user.id, integration.id, user.id);

  return outcome(ctx, 'linked', { platform: integration.id, account: user.login ?? user.id });
}
