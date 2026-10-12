/** MCP authorization (spec 2026-07-28) with Coder as the OAuth client of a remote MCP server. */
import { secureUrl, request, tokens, withTokens, type OAuthSecret } from '../../core/oauth';
import { connectionUrlAllowed } from '../../core/connections';
export { oauthAccessToken, OAuthRevoked, type OAuthSecret } from '../../core/oauth';
import type { Connection } from '../../agent/types';
import { createHash, randomBytes } from 'node:crypto';
import * as z from 'zod/mini';
import { scoped, type ServerContext } from '../context';
import { consumeBoundNonce, issueNonce, nonceOrganization } from '../auth/nonce';
import { decryptSecret, encryptSecret } from '../store/secrets';
import type { Store } from '../store/types';
import { json, notFound, redirect } from '../routes/http';
import { workspaceAdmin } from '../routes/guards';

export const MCP_CLIENT_PATH = '/connections/oauth/client.json';
const CALLBACK_PATH = '/connections/oauth/callback';
const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const attemptKey = (id: string) => `connection-oauth:${id}`;

export async function completeAuthorization(
  ctx: Pick<ServerContext, 'store' | 'now'>,
  connection: Connection,
  attempt: string,
): Promise<void> {
  await ctx.store.put(
    'delivery',
    `connection-authorized:${createHash('sha256').update(attempt).digest('hex')}`,
    { at: (ctx.now ?? Date.now)(), target: `${connection.id}:${connection.createdAt}` },
    { ttlMs: AUTHORIZATION_TTL_MS },
  );
}
const text = z.string().check(z.minLength(1));
const resourceSchema = z.object({
  resource: text,
  authorization_servers: z.array(text).check(z.minLength(1)),
  scopes_supported: z.optional(z.array(text)),
});
const metadataSchema = z.object({
  issuer: text,
  authorization_endpoint: text,
  token_endpoint: text,
  registration_endpoint: z.optional(text),
  userinfo_endpoint: z.optional(text),
  scopes_supported: z.optional(z.array(text)),
  code_challenge_methods_supported: z.optional(z.array(text)),
  client_id_metadata_document_supported: z.optional(z.boolean()),
  authorization_response_iss_parameter_supported: z.optional(z.boolean()),
});
const authMethodSchema = z.enum(['none', 'client_secret_basic', 'client_secret_post']);
const clientSchema = z.object({
  client_id: text,
  client_secret: z.optional(text),
  token_endpoint_auth_method: z.optional(authMethodSchema),
  redirect_uris: z.optional(z.array(text)),
});
const accountSchema = z.object({
  name: z.optional(text),
  preferred_username: z.optional(text),
  email: z.optional(text),
});

function discoveryUrl(ctx: ServerContext, value: string): URL {
  const url = secureUrl(value);
  if (!connectionUrlAllowed(url, !!ctx.local)) throw new Error('OAuth endpoint is not allowed.');

  return url;
}

async function document(
  ctx: ServerContext,
  fetcher: typeof fetch,
  paths: string[],
  optional = false,
): Promise<unknown> {
  for (const path of [...new Set(paths)]) {
    discoveryUrl(ctx, path);
    const response = await request(fetcher, path, { headers: { accept: 'application/json' } });
    if (response.status === 404 || response.status === 405) continue;
    if (optional && (response.status === 401 || response.status === 403)) continue;
    if (!response.ok) throw new Error('OAuth metadata discovery failed.');

    return response.json();
  }
  if (!optional) throw new Error('OAuth metadata is unavailable.');
}

function challenge(header: string | null): Record<string, string> {
  const params: Record<string, string> = {};
  let scheme = '';
  for (const match of header?.matchAll(
    /(?:^|,)\s*(?:([\w-]+)\s+)?([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g,
  ) ?? []) {
    if (match[1]) {
      if (scheme === 'bearer') break;
      scheme = match[1].toLowerCase();
    }
    if (scheme === 'bearer')
      params[match[2]!.toLowerCase()] = match[3]?.replace(/\\(.)/g, '$1') ?? match[4]!;
  }

  return params;
}

export async function oauthResource(
  ctx: ServerContext,
  url: string,
  optional = false,
  authenticate?: string,
) {
  const endpoint = discoveryUrl(ctx, url);
  const fetcher = ctx.fetch ?? fetch;
  if (authenticate === undefined) {
    const probe = await request(fetcher, endpoint.href);
    authenticate = probe.status === 401 ? (probe.headers.get('www-authenticate') ?? '') : '';
    await probe.body?.cancel();
  }
  const params = challenge(authenticate);
  const value = await document(
    ctx,
    fetcher,
    params.resource_metadata
      ? [params.resource_metadata]
      : [
          endpoint.origin +
            '/.well-known/oauth-protected-resource' +
            (endpoint.pathname === '/' ? '' : endpoint.pathname),
          endpoint.origin + '/.well-known/oauth-protected-resource',
        ],
    optional && !params.resource_metadata,
  );
  if (value === undefined) return undefined;
  const resource = resourceSchema.parse(value);
  if (discoveryUrl(ctx, resource.resource).origin !== endpoint.origin)
    throw new Error('OAuth resource changed origin.');

  return { resource, params };
}

function originOf(ctx: ServerContext): string {
  if (ctx.local) return `http://localhost:${ctx.local.port}`;
  if (ctx.config.publicUrl) return secureUrl(ctx.config.publicUrl).origin;
  throw new Error('PUBLIC_URL or a local server is required for OAuth.');
}

function clientMetadata(ctx: ServerContext) {
  const origin = originOf(ctx);

  return {
    client_name: ctx.config.name ?? 'Coder',
    redirect_uris: [origin + CALLBACK_PATH],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

export function oauthClientDocument(req: Request, ctx: ServerContext): Response {
  if (!ctx.config.publicUrl || secureUrl(ctx.config.publicUrl).protocol !== 'https:')
    return notFound();

  return json({
    client_id: secureUrl(ctx.config.publicUrl).origin + MCP_CLIENT_PATH,
    ...clientMetadata(ctx),
  });
}

function userOf(ctx: ServerContext): string {
  if (ctx.session) return ctx.session.user.id;
  if (ctx.local && !ctx.auth) return 'local';
  throw new Error('Sign in before authorizing a connection.');
}

function checkConnection(
  current: Connection | undefined,
  expected: Pick<Connection, 'createdAt' | 'owner' | 'endpoint'>,
): asserts current is Connection {
  if (
    !current ||
    current.createdAt !== expected.createdAt ||
    current.owner !== expected.owner ||
    current.auth !== 'oauth' ||
    current.provider !== 'mcp' ||
    JSON.stringify(current.endpoint) !== JSON.stringify(expected.endpoint)
  )
    throw new Error('The connection changed during authorization.');
}

async function checkAttempt(store: Store, id: string, attempt: string): Promise<void> {
  const current = await store.get('delivery', attemptKey(id));
  if (!current || !('target' in current) || current.target !== attempt)
    throw new Error('The authorization attempt was superseded or expired.');
}

/** Where the browser goes to authorize `connection`; discovery, registration and PKCE happen here. */
export async function authorizeUrl(
  ctx: ServerContext,
  connection: Connection,
  discovered?: Awaited<ReturnType<typeof oauthResource>>,
): Promise<string> {
  const user = userOf(ctx);
  if (
    connection.auth !== 'oauth' ||
    connection.provider !== 'mcp' ||
    !connection.endpoint ||
    !('url' in connection.endpoint) ||
    typeof connection.endpoint.url !== 'string' ||
    (connection.owner && connection.owner !== user)
  )
    throw new Error('This connection cannot be authorized.');
  const fetcher = ctx.fetch ?? fetch;
  const { resource, params } = discovered ?? (await oauthResource(ctx, connection.endpoint.url))!;
  const issuer = resource.authorization_servers[0]!;
  const issuerUrl = discoveryUrl(ctx, issuer);
  if (issuerUrl.search) throw new Error('OAuth issuer cannot contain a query.');
  const path = issuerUrl.pathname.replace(/\/$/, '');
  const metadata = metadataSchema.parse(
    await document(ctx, fetcher, [
      issuerUrl.origin + '/.well-known/oauth-authorization-server' + path,
      issuerUrl.origin + '/.well-known/openid-configuration' + path,
      issuerUrl.origin + path + '/.well-known/openid-configuration',
    ]),
  );
  if (metadata.issuer !== issuer) throw new Error('OAuth issuer mismatch.');
  if (!metadata.code_challenge_methods_supported?.includes('S256'))
    throw new Error('OAuth server does not support PKCE S256.');
  discoveryUrl(ctx, metadata.authorization_endpoint);
  discoveryUrl(ctx, metadata.token_endpoint);
  if (metadata.registration_endpoint) discoveryUrl(ctx, metadata.registration_endpoint);
  if (metadata.userinfo_endpoint) discoveryUrl(ctx, metadata.userinfo_endpoint);

  const previous = connection.secret
    ? decryptSecret<OAuthSecret>(ctx.config, connection.secret)
    : undefined;
  let client:
    Pick<OAuthSecret, 'clientId' | 'clientSecret' | 'tokenEndpointAuthMethod'> | undefined =
    previous?.issuer === issuer && previous.clientId
      ? {
          clientId: previous.clientId,
          clientSecret: previous.clientSecret,
          tokenEndpointAuthMethod: previous.tokenEndpointAuthMethod,
        }
      : undefined;
  if (
    !client &&
    metadata.client_id_metadata_document_supported &&
    ctx.config.publicUrl &&
    secureUrl(ctx.config.publicUrl).protocol === 'https:'
  )
    client = {
      clientId: secureUrl(ctx.config.publicUrl).origin + MCP_CLIENT_PATH,
      tokenEndpointAuthMethod: 'none',
    };
  if (!client) {
    if (!metadata.registration_endpoint)
      throw new Error('OAuth server does not support client registration.');
    const response = await request(fetcher, metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(clientMetadata(ctx)),
    });
    if (!response.ok) throw new Error('OAuth client registration failed.');
    const registered = clientSchema.parse(await response.json());
    const method = registered.token_endpoint_auth_method ?? 'client_secret_basic';
    if (method !== 'none' && !registered.client_secret)
      throw new Error('OAuth registration omitted the client secret.');
    if (
      registered.redirect_uris &&
      !registered.redirect_uris.includes(originOf(ctx) + CALLBACK_PATH)
    )
      throw new Error('OAuth registration changed the redirect URI.');
    client = {
      clientId: registered.client_id,
      clientSecret: registered.client_secret,
      tokenEndpointAuthMethod: method,
    };
  }
  const secret: OAuthSecret = {
    issuer,
    authorizationEndpoint: metadata.authorization_endpoint,
    tokenEndpoint: metadata.token_endpoint,
    resource: resource.resource,
    ...client,
    scope:
      params.scope ?? resource.scopes_supported?.join(' ') ?? metadata.scopes_supported?.join(' '),
  };
  const sealed = encryptSecret(ctx.config, secret);
  const attempt = randomBytes(18).toString('base64url');
  await ctx.store.withAppLock(`connection:${connection.id}`, async store => {
    const current = await store.get('connection', connection.id);
    checkConnection(current, connection);
    await store.put(
      'delivery',
      attemptKey(connection.id),
      { at: (ctx.now ?? Date.now)(), target: attempt },
      { ttlMs: AUTHORIZATION_TTL_MS },
    );
  });
  const verifier = randomBytes(32).toString('base64url');
  const state = await issueNonce(
    ctx,
    'connection-oauth',
    user,
    encryptSecret(ctx.config, {
      id: connection.id,
      attempt,
      secret: sealed,
      createdAt: connection.createdAt,
      endpoint: connection.endpoint,
      owner: connection.owner,
      verifier,
      redirectUri: originOf(ctx) + CALLBACK_PATH,
      userinfo: metadata.userinfo_endpoint,
      requireIssuer: metadata.authorization_response_iss_parameter_supported === true,
    }),
    AUTHORIZATION_TTL_MS,
  );
  const url = new URL(secret.authorizationEndpoint);
  const fields = {
    response_type: 'code',
    client_id: secret.clientId,
    redirect_uri: originOf(ctx) + CALLBACK_PATH,
    state,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    resource: secret.resource,
  };
  for (const [key, value] of Object.entries(fields)) url.searchParams.set(key, value);
  if (secret.scope !== undefined) url.searchParams.set('scope', secret.scope);

  return url.href;
}

/** The redirect back from the authorization server: stores the tokens sealed on the connection, then returns to the dashboard. */
export async function oauthCallback(req: Request, ctx: ServerContext, url: URL): Promise<Response> {
  const outcome = (value: string) => redirect(`/dash/settings/connections?outcome=${value}`);
  try {
    const state = url.searchParams.get('state') ?? '';
    const organization = nonceOrganization(ctx, state);
    if (
      ctx.auth &&
      (!organization || !ctx.session?.organizations.some(entry => entry.id === organization))
    )
      return outcome('invalid-state');
    const membership = ctx.session?.organizations.find(entry => entry.id === organization);
    const member = organization
      ? {
          ...scoped(ctx, organization),
          session: ctx.session && {
            ...ctx.session,
            organizationId: organization,
            role: organization === ctx.session.organizationId ? ctx.session.role : membership!.role,
          },
        }
      : ctx;
    const target = await consumeBoundNonce(member, state, 'connection-oauth', userOf(member));
    if (!target) return outcome('invalid-state');
    const claim = decryptSecret<{
      id: string;
      attempt: string;
      secret: string;
      createdAt: number;
      endpoint: Connection['endpoint'];
      owner?: string;
      verifier: string;
      redirectUri: string;
      userinfo?: string;
      requireIssuer: boolean;
    }>(member.config, target);
    if (!claim.owner && !workspaceAdmin(member)) return outcome('failed');
    const secret = decryptSecret<OAuthSecret>(member.config, claim.secret);
    const issuer = url.searchParams.get('iss');
    if ((claim.requireIssuer || issuer !== null) && issuer !== secret.issuer)
      return outcome('failed');
    if (url.searchParams.has('error'))
      return outcome(url.searchParams.get('error') === 'access_denied' ? 'denied' : 'failed');
    const code = url.searchParams.get('code');
    if (!code) return outcome('failed');
    const current = await member.store.get('connection', claim.id);
    checkConnection(current, claim);
    await checkAttempt(member.store, claim.id, claim.attempt);
    const fetcher = member.fetch ?? fetch;
    const token = await tokens(
      fetcher,
      secret,
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: claim.redirectUri,
        code_verifier: claim.verifier,
      }),
    );
    let account = token.preferred_username ?? token.email ?? token.name;
    if (!account && claim.userinfo) {
      try {
        const response = await request(fetcher, claim.userinfo, {
          headers: {
            authorization: `Bearer ${token.access_token}`,
            accept: 'application/json',
          },
        });
        if (response.ok) {
          const info = accountSchema.parse(await response.json());
          account = info.preferred_username ?? info.email ?? info.name;
        }
      } catch {}
    }
    await member.store.withAppLock(`connection:${claim.id}`, async store => {
      const latest = await store.get('connection', claim.id);
      checkConnection(latest, claim);
      await checkAttempt(store, claim.id, claim.attempt);
      await store.put('connection', latest.id, {
        ...latest,
        secret: encryptSecret(member.config, withTokens(secret, token, (member.now ?? Date.now)())),
        account: account ?? latest.account,
        broken: undefined,
        updatedAt: (member.now ?? Date.now)(),
      });
      await store.delete('delivery', attemptKey(claim.id));
      await completeAuthorization({ ...member, store }, latest, state);
    });

    return outcome('connected');
  } catch {
    return outcome('failed');
  }
}
