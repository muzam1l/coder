/** App setup helpers for form-based integrations: the posted credentials and OAuth token endpoint calls. */
import { IntegrationError } from './types';

/** The posted credentials form, every named field present and trimmed. */
export async function postedFields<K extends string>(
  req: Request,
  names: readonly K[],
): Promise<Record<K, string>> {
  const form = new URLSearchParams(await req.text());
  const values = Object.fromEntries(
    names.map(name => [name, form.get(name)?.trim() ?? '']),
  ) as Record<K, string>;
  const missing = names.filter(name => !values[name]);
  if (missing.length)
    throw new IntegrationError('invalid-field', missing[0], `Missing ${missing.join(', ')}`);
  return values;
}

/** An installation token as stored: the access token, its refresh token, and when it expires. */
export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

/** One token endpoint call: a code exchange, a refresh, or client credentials. */
export async function tokenGrant(
  url: string,
  params: Record<string, string>,
  request: typeof fetch = fetch,
  now = Date.now(),
): Promise<StoredToken & { idToken?: string }> {
  const response = await request(url, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    id_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !body.access_token)
    throw new IntegrationError(
      'platform-error',
      body.error ?? String(response.status),
      `${new URL(url).host} refused the token request: ${body.error_description ?? body.error ?? response.status}`,
    );
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(body.expires_in ? { expiresAt: now + body.expires_in * 1000 } : {}),
    ...(body.id_token ? { idToken: body.id_token } : {}),
  };
}

/** A usable access token from stored token JSON, refreshed and saved when it is about to expire. */
export async function freshToken(
  stored: string | undefined,
  refresh: (refreshToken: string) => Promise<StoredToken>,
  save?: (token: string) => Promise<string | void>,
  now = Date.now(),
): Promise<string> {
  if (!stored) throw new Error('The installation has no token; connect it again');
  const token = JSON.parse(stored) as StoredToken;
  if (!token.refreshToken || (token.expiresAt ?? Infinity) - 5 * 60_000 > now)
    return token.accessToken;
  const { idToken: _idToken, ...next } = (await refresh(token.refreshToken)) as StoredToken & {
    idToken?: string;
  };
  const kept = { ...next, refreshToken: next.refreshToken ?? token.refreshToken };
  const winner = await save?.(JSON.stringify(kept));
  return winner ? (JSON.parse(winner) as StoredToken).accessToken : kept.accessToken;
}
