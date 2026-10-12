import * as z from 'zod/mini';

/** What an OAuth connection's sealed secret holds. */
export interface OAuthSecret {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  /** The MCP server's canonical URI, sent as `resource`. */
  resource: string;
  clientId: string;
  clientSecret?: string;
  scope?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpointAuthMethod?: 'none' | 'client_secret_basic' | 'client_secret_post';
}

const text = z.string().check(z.minLength(1));
const tokenSchema = z.object({
  access_token: text,
  token_type: z.string().check(z.refine(value => value.toLowerCase() === 'bearer')),
  refresh_token: z.optional(text),
  expires_in: z.optional(z.number().check(z.gte(0))),
  scope: z.optional(z.string()),
  name: z.optional(text),
  preferred_username: z.optional(text),
  email: z.optional(text),
});
const errorSchema = z.object({ error: text });

export function secureUrl(value: string): URL {
  const url = new URL(value);
  const loopback =
    url.hostname === 'localhost' ||
    url.hostname === '[::1]' ||
    /^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('OAuth URLs require HTTPS or loopback and no credentials or fragment.');

  return url;
}

export async function request(
  fetcher: typeof fetch,
  value: string,
  init: RequestInit = {},
): Promise<Response> {
  const origin = secureUrl(value).origin;
  for (let count = 0; count < 5; count++) {
    const response = await fetcher(value, {
      ...init,
      redirect: 'manual',
      signal: init.signal ?? AbortSignal.timeout(15_000),
    });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('OAuth redirect has no location.');
    const next = secureUrl(new URL(location, value).href);
    if (next.origin !== origin) throw new Error('OAuth redirect changed origin.');
    await response.body?.cancel();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && init.method === 'POST')
    )
      throw new Error('OAuth redirect would discard the request body.');
    value = next.href;
  }
  throw new Error('Too many OAuth redirects.');
}

function credentials(secret: OAuthSecret, body: URLSearchParams): Headers {
  const headers = new Headers({
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'application/json',
  });
  const method =
    secret.tokenEndpointAuthMethod ?? (secret.clientSecret ? 'client_secret_basic' : 'none');
  if (method !== 'none' && !secret.clientSecret) throw new Error('OAuth client secret is missing.');
  if (method === 'client_secret_basic') {
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.set(
      'authorization',
      `Basic ${Buffer.from(`${encode(secret.clientId)}:${encode(secret.clientSecret!)}`).toString('base64')}`,
    );
  } else {
    body.set('client_id', secret.clientId);
    if (method === 'client_secret_post') body.set('client_secret', secret.clientSecret!);
  }

  return headers;
}

export async function tokens(fetcher: typeof fetch, secret: OAuthSecret, body: URLSearchParams) {
  body.set('resource', secret.resource);
  const headers = credentials(secret, body);
  const response = await request(fetcher, secret.tokenEndpoint, { method: 'POST', headers, body });
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = errorSchema.safeParse(value);
    if (
      body.get('grant_type') === 'refresh_token' &&
      response.status >= 400 &&
      response.status < 500 &&
      error.success &&
      ['invalid_grant', 'invalid_client'].includes(error.data.error)
    )
      throw new OAuthRevoked('The OAuth connection must be reconnected.');
    throw new Error('OAuth token request failed.');
  }

  return tokenSchema.parse(value);
}

export function withTokens(
  secret: OAuthSecret,
  token: z.infer<typeof tokenSchema>,
  now: number,
): OAuthSecret {
  return {
    ...secret,
    accessToken: token.access_token,
    refreshToken: token.refresh_token ?? secret.refreshToken,
    expiresAt: token.expires_in === undefined ? undefined : now + token.expires_in * 1000,
    scope: token.scope ?? secret.scope,
  };
}

/** A live access token, refreshed through `save` when expired; throws `OAuthRevoked` when the server refuses the refresh. */
export async function oauthAccessToken(input: {
  secret: OAuthSecret;
  fetch: typeof fetch;
  now: number;
  save(secret: OAuthSecret): Promise<void>;
  force?: boolean;
}): Promise<string> {
  const { secret, now } = input;
  if (
    !input.force &&
    secret.accessToken &&
    (secret.expiresAt === undefined ? !secret.refreshToken : secret.expiresAt - now >= 60_000)
  )
    return secret.accessToken;
  if (!secret.refreshToken) throw new OAuthRevoked('The OAuth connection must be reconnected.');
  const token = await tokens(
    input.fetch,
    secret,
    new URLSearchParams({ grant_type: 'refresh_token', refresh_token: secret.refreshToken }),
  );
  const next = withTokens(secret, token, now);
  await input.save(next);

  return next.accessToken!;
}

/** The refresh token was refused or revoked; the connection needs reconnecting. */
export class OAuthRevoked extends Error {}
