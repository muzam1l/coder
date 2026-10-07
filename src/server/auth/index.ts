/** Sign-in with Wular: an OpenID Connect client with a stateless encrypted session cookie, and the bearer tokens Wular issues for this server. */
import { and, eq } from 'drizzle-orm';
import { EncryptJWT, createRemoteJWKSet, jwtDecrypt, jwtVerify, type JWTPayload } from 'jose';
import * as oidc from 'openid-client';

import type { AuthApi, ServerConfig, OrganizationInfo, SessionInfo } from '../context';
import type { Db } from '../store/pg/client';
import { platformLink } from '../store/pg/schema';
import {sameOriginProof} from '../routes/guards';
import {forbidden,notFound} from '../routes/http';
import { authKeys } from './keys';
import { CALLBACK_PATH, SCOPE, WEB_CLIENT_PATH } from './metadata';
import { COOKIE_PREFIX, safeReturnPath } from './sign-in';

const SESSION_COOKIE = `${COOKIE_PREFIX}.session`;
const FLOW_COOKIE = `${COOKIE_PREFIX}.oidc`;
// Browsers cap a cookie near 4 KB; larger sessions split into numbered chunks.
const CHUNK_SIZE = 3800;
/** Admin, agent, credential and member changes act on roles at most this old, in seconds. */
const PRIVILEGED_FRESHNESS_S = 60;
const SESSION_TTL_S = 30 * 24 * 3600;
const FLOW_TTL_S = 600;
// A rotated refresh token's result, for requests that still carry the cookie it replaced.
const REFRESHED_TTL_MS = 60_000;

interface Claims extends JWTPayload {
  sub: string;
  name: string;
  email: string;
  orgs: OrganizationInfo[];
  /** The active organization. */
  org?: string;
  /** When the access token expires, and with it these claims. */
  exp_at: number;
  /** When Wular issued these claims. */
  at: number;
  rt?: string;
  idt?: string;
}

interface Flow extends JWTPayload {
  verifier: string;
  state: string;
  nonce: string;
  return: string;
}

const epoch = () => Math.floor(Date.now() / 1000);

function readCookies(headers: Headers): Map<string, string> {
  const jar = new Map<string, string>();
  for (const part of (headers.get('cookie') ?? '').split(/;\s*/)) {
    const at = part.indexOf('=');
    if (at > 0) jar.set(part.slice(0, at), part.slice(at + 1));
  }
  return jar;
}

function chunks(jar: Map<string, string>): string[] {
  const names: string[] = [];
  while (jar.has(`${SESSION_COOKIE}.${names.length}`))
    names.push(`${SESSION_COOKIE}.${names.length}`);
  return names;
}

function readSession(headers: Headers): string | undefined {
  const jar = readCookies(headers);
  return (
    jar.get(SESSION_COOKIE) ??
    (chunks(jar)
      .map(name => jar.get(name))
      .join('') ||
      undefined)
  );
}

/** Organization claims as Wular issues them, keeping only what Coder reads. */
function organizations(value: unknown): OrganizationInfo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((org: Record<string, unknown>) =>
    typeof org?.id === 'string' && typeof org.role === 'string'
      ? [
          {
            id: org.id,
            slug: String(org.slug ?? org.id),
            name: String(org.name ?? org.slug ?? org.id),
            role: org.role,
          },
        ]
      : [],
  );
}

/** The request's organization: an explicit header, else the session's active one, else the first. */
function withOrganization(headers: Headers, info: SessionInfo, active?: string): SessionInfo {
  const wanted = headers.get('x-coder-organization');
  const org = wanted
    ? info.organizations.find(o => o.slug === wanted || o.id === wanted)
    : (info.organizations.find(o => o.id === active) ?? info.organizations[0]);
  if (!org) return wanted ? { ...info, organizationDenied: true } : info;
  return { ...info, organizationId: org.id, role: org.role };
}

export async function createAuth(db: Db, config: ServerConfig): Promise<AuthApi> {
  const issuer = config.auth!.wular.url;
  const publicUrl = config.publicUrl!;
  const resource = new URL(publicUrl).origin;
  const secure = publicUrl.startsWith('https:');
  const keys = await authKeys(config);
  const redirectUri = `${publicUrl}${CALLBACK_PATH}`;

  const cookie = (name: string, value: string, maxAge: number) =>
    `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;

  const seal = (payload: JWTPayload, ttl: number) =>
    new EncryptJWT(payload)
      .setProtectedHeader({ alg: 'dir', enc: 'A256GCM' })
      .setIssuedAt()
      .setExpirationTime(`${ttl}s`)
      .encrypt(keys.cookie[0]!);

  async function open<T>(sealed: string | undefined): Promise<T | undefined> {
    if (!sealed) return undefined;
    for (const key of keys.cookie) {
      try {
        return (await jwtDecrypt(sealed, key)).payload as T;
      } catch {}
    }
    return undefined;
  }

  /** Set-Cookie values that store the session, replacing whatever chunks the request carried. */
  async function storeSession(headers: Headers, claims: Claims) {
    const sealed = await seal(claims, SESSION_TTL_S);
    const stale = chunks(readCookies(headers));
    if (sealed.length <= CHUNK_SIZE)
      return [
        cookie(SESSION_COOKIE, sealed, SESSION_TTL_S),
        ...stale.map(name => cookie(name, '', 0)),
      ];
    const parts = sealed.match(new RegExp(`.{1,${CHUNK_SIZE}}`, 'g'))!;
    return [
      cookie(SESSION_COOKIE, '', 0),
      ...parts.map((part, i) => cookie(`${SESSION_COOKIE}.${i}`, part, SESSION_TTL_S)),
      ...stale.slice(parts.length).map(name => cookie(name, '', 0)),
    ];
  }

  const clearSession = (headers: Headers) =>
    [SESSION_COOKIE, ...chunks(readCookies(headers))].map(name => cookie(name, '', 0));

  // Discovery waits for Wular; a failure is retried on the next use, so a Wular that was down at boot still works later.
  let discovered: Promise<oidc.Configuration> | undefined;
  const configuration = () =>
    (discovered ??= oidc
      .discovery(
        new URL(issuer),
        `${publicUrl}${WEB_CLIENT_PATH}`,
        undefined,
        oidc.PrivateKeyJwt(keys.client),
        new URL(issuer).protocol === 'http:'
          ? { execute: [oidc.allowInsecureRequests] }
          : undefined,
      )
      .catch((error: unknown) => {
        discovered = undefined;
        throw error;
      }));

  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  const wularKeys = async () =>
    (jwks ??= createRemoteJWKSet(new URL((await configuration()).serverMetadata().jwks_uri!)));

  function fromTokens(
    tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
    previous?: Claims,
  ): Claims {
    const id = tokens.claims();
    if (!id) throw new Error('Wular Auth returned no ID token');
    const orgs = organizations(id.organizations);
    return {
      sub: id.sub,
      name: typeof id.name === 'string' ? id.name : '',
      email: typeof id.email === 'string' ? id.email : '',
      orgs,
      org: orgs.some(org => org.id === previous?.org) ? previous!.org : orgs[0]?.id,
      exp_at: epoch() + (tokens.expires_in ?? 600),
      at: epoch(),
      rt: tokens.refresh_token ?? previous?.rt,
      idt: tokens.id_token ?? previous?.idt,
    };
  }

  const refreshed = new Map<string, Promise<Claims | undefined>>();
  /** New claims from the refresh grant; undefined when Wular refuses or cannot be reached. */
  function refresh(claims: Claims): Promise<Claims | undefined> {
    const token = claims.rt;
    if (!token) return Promise.resolve(undefined);
    let found = refreshed.get(token);
    if (!found) {
      found = configuration()
        .then(wular => oidc.refreshTokenGrant(wular, token))
        .then(tokens => fromTokens(tokens, claims))
        .catch(() => {
          refreshed.delete(token);
          return undefined;
        });
      refreshed.set(token, found);
      setTimeout(() => refreshed.delete(token), REFRESHED_TTL_MS).unref?.();
    }
    return found;
  }

  async function bearerSession(
    token: string,
    headers: Headers,
    fresh: boolean,
  ): Promise<SessionInfo | undefined> {
    const verified = await wularKeys()
      .then(keySet =>
        jwtVerify(token, keySet, {
          issuer,
          audience: resource,
          typ: 'at+jwt',
        }),
      )
      .catch(() => undefined);
    const payload = verified?.payload;
    if (!payload?.sub) return undefined;
    const info: SessionInfo = {
      user: { id: payload.sub, name: '', email: '' },
      organizations: organizations(payload.organizations),
    };
    if (fresh && epoch() - (payload.iat ?? 0) > PRIVILEGED_FRESHNESS_S)
      return { ...info, stale: true };
    return withOrganization(headers, info);
  }

  async function signIn(url: URL): Promise<Response> {
    const wular = await configuration().catch(() => undefined);
    if (!wular) return Response.redirect(`${publicUrl}/login?error=unavailable`, 302);
    const flow: Flow = {
      verifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      return: safeReturnPath(url.searchParams.get('return'), resource),
    };
    const target = oidc.buildAuthorizationUrl(wular, {
      redirect_uri: redirectUri,
      scope: SCOPE,
      code_challenge: await oidc.calculatePKCECodeChallenge(flow.verifier),
      code_challenge_method: 'S256',
      state: flow.state,
      nonce: flow.nonce,
    });
    return new Response(null, {
      status: 302,
      headers: {
        location: target.href,
        'set-cookie': cookie(FLOW_COOKIE, await seal(flow, FLOW_TTL_S), FLOW_TTL_S),
      },
    });
  }

  async function callback(req: Request, url: URL): Promise<Response> {
    const failed = (error: string) => {
      const headers = new Headers({
        location: `/login?error=${encodeURIComponent(error)}`,
      });
      headers.append('set-cookie', cookie(FLOW_COOKIE, '', 0));
      return new Response(null, { status: 302, headers });
    };
    const flow = await open<Flow>(readCookies(req.headers).get(FLOW_COOKIE));
    if (!flow) return failed('expired');
    const denied = url.searchParams.get('error');
    if (denied) return failed(denied);
    let claims: Claims;
    try {
      const tokens = await oidc.authorizationCodeGrant(
        await configuration(),
        new URL(`${redirectUri}${url.search}`),
        {
          pkceCodeVerifier: flow.verifier,
          expectedState: flow.state,
          expectedNonce: flow.nonce,
          idTokenExpected: true,
        },
      );
      claims = fromTokens(tokens);
    } catch {
      return failed('sign_in_failed');
    }
    const headers = new Headers({ location: flow.return });
    headers.append('set-cookie', cookie(FLOW_COOKIE, '', 0));
    for (const value of await storeSession(req.headers, claims))
      headers.append('set-cookie', value);
    return new Response(null, { status: 302, headers });
  }

  async function signOut(req: Request): Promise<Response> {
    if (!sameOriginProof(req, publicUrl)) return forbidden();
    const claims = await open<Claims>(readSession(req.headers));
    const wular = await configuration().catch(() => undefined);
    const signedOut = `${publicUrl}/?signed_out=1`;
    const url =
      wular?.serverMetadata().end_session_endpoint && claims?.idt
        ? oidc.buildEndSessionUrl(wular, {
            id_token_hint: claims.idt,
            post_logout_redirect_uri: signedOut,
          }).href
        : signedOut;
    const response = Response.json({ url });
    for (const value of clearSession(req.headers)) response.headers.append('set-cookie', value);
    return response;
  }

  return {
    issuer,
    jwks: keys.jwks,
    handler(req) {
      const url = new URL(req.url);
      if (url.pathname === '/api/auth/sign-in' && req.method === 'GET') return signIn(url);
      if (url.pathname === CALLBACK_PATH && req.method === 'GET') return callback(req, url);
      if (url.pathname === '/api/auth/sign-out' && req.method === 'POST') return signOut(req);
      return Promise.resolve(notFound());
    },
    async session(headers, fresh = false) {
      const authorization = headers.get('authorization');
      if (authorization?.startsWith('Bearer '))
        return bearerSession(authorization.slice('Bearer '.length), headers, fresh);
      let claims = await open<Claims>(readSession(headers));
      if (!claims) return undefined;
      let cookies: string[] | undefined;
      if (claims.exp_at <= epoch() || (fresh && epoch() - claims.at > PRIVILEGED_FRESHNESS_S)) {
        claims = await refresh(claims);
        if (!claims) return undefined;
        cookies = await storeSession(headers, claims);
      }
      return withOrganization(
        headers,
        {
          user: { id: claims.sub, name: claims.name, email: claims.email },
          organizations: claims.orgs,
          ...(cookies ? { cookies } : {}),
        },
        claims.org,
      );
    },
    async setOrganization(headers, slug) {
      const claims = await open<Claims>(readSession(headers));
      const org = claims?.orgs.find(candidate => candidate.slug === slug);
      if (!claims || !org) return undefined;
      return {
        ...org,
        cookies: await storeSession(headers, { ...claims, org: org.id }),
      };
    },
    async link(user, platform, platformUserId, extra = {}) {
      const known = {
        name: user.name,
        email: user.email,
        ...(extra.organizations ? { organizations: extra.organizations } : {}),
        ...(extra.token ? { token: extra.token } : {}),
      };
      await db
        .insert(platformLink)
        .values({ platform, platformUserId, userId: user.id, ...known })
        .onConflictDoUpdate({
          target: [platformLink.platform, platformLink.platformUserId],
          set: known,
          setWhere: eq(platformLink.userId, user.id),
        });
      const [row] = await db
        .select({ userId: platformLink.userId })
        .from(platformLink)
        .where(
          and(eq(platformLink.platform, platform), eq(platformLink.platformUserId, platformUserId)),
        );
      return row?.userId === user.id ? 'linked' : 'taken';
    },
    async linkedUser(platform, platformUserId) {
      const [row] = await db
        .select({
          id: platformLink.userId,
          name: platformLink.name,
          email: platformLink.email,
          organizations: platformLink.organizations,
          token: platformLink.token,
        })
        .from(platformLink)
        .where(
          and(eq(platformLink.platform, platform), eq(platformLink.platformUserId, platformUserId)),
        );
      return (
        row && {
          id: row.id,
          name: row.name,
          email: row.email,
          ...(row.organizations ? { organizations: row.organizations } : {}),
          ...(row.token ? { token: row.token } : {}),
        }
      );
    },
  };
}
