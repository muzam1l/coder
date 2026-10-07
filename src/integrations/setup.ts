/** App setup the Gmail, Linear and Teams integrations share: the credentials form and OAuth token endpoint calls. */
import { escapeHtml, htmlResponse } from '../utils/html';
import type { CreateState } from './types';

/** The page that asks for an app's credentials and posts them, with the creation state, to `/create/<id>/callback`. */
export function credentialsPage(
  publicUrl: string,
  id: string,
  state: CreateState,
  input: { title: string; steps: string[]; fields: Array<[name: string, label: string]> },
): Response {
  const hidden = Object.entries(state)
    .filter(([, value]) => value !== undefined)
    .map(
      ([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(String(value))}">`,
    )
    .join('');
  const steps = input.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('');
  const fields = input.fields
    .map(
      ([name, label]) =>
        `<p><label>${escapeHtml(label)}<br><input name="${name}" size="60" required></label></p>`,
    )
    .join('');
  return htmlResponse(
    `<title>${escapeHtml(input.title)}</title><ol>${steps}</ol>` +
      `<form method="post" action="${publicUrl.replace(/\/$/, '')}/create/${id}/callback">${hidden}${fields}<button type="submit">${escapeHtml(input.title)}</button></form>`,
  );
}

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
  if (missing.length) throw new Error(`Missing ${missing.join(', ')}`);
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
    throw new Error(
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
  save?: (token: string) => Promise<void>,
  now = Date.now(),
): Promise<string> {
  if (!stored)
    throw new Error('The installation has no token; connect it again from the dashboard');
  const token = JSON.parse(stored) as StoredToken;
  if (!token.refreshToken || (token.expiresAt ?? Infinity) - 5 * 60_000 > now)
    return token.accessToken;
  const { idToken: _idToken, ...next } = (await refresh(token.refreshToken)) as StoredToken & {
    idToken?: string;
  };
  const kept = { ...next, refreshToken: next.refreshToken ?? token.refreshToken };
  await save?.(JSON.stringify(kept));
  return kept.accessToken;
}

/** Claims of an ID token the token endpoint returned over TLS, which OIDC Core 3.1.3.7 lets a client trust without its signature. */
export function idClaims(idToken: string | undefined, clientId: string): Record<string, unknown> {
  const claims = JSON.parse(
    Buffer.from(idToken?.split('.')[1] ?? '', 'base64url').toString() || '{}',
  ) as Record<string, unknown>;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(clientId))
    throw new Error('The sign-in returned no identity for this app');
  return claims;
}
