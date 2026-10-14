/** Sign-in with Wular: an OpenID Connect client with a stateless encrypted session cookie, and the bearer tokens Wular issues for this server. */
import { and, eq } from 'drizzle-orm';
import { EncryptJWT, createRemoteJWKSet, jwtDecrypt, jwtVerify, type JWTPayload } from 'jose';
import * as oidc from 'openid-client';

import type { AuthApi, ServerConfig, OrganizationInfo, SessionInfo } from '../context';
import { chosenOrganization } from '../context';
import type { Db } from '../store/pg/client';
import type { Store } from '../store/types';
import { DrizzleStore } from '../store/pg/store';
import { platformLink } from '../store/pg/schema';
import {sameOriginProof} from '../routes/guards';
import {forbidden,notFound} from '../routes/http';
import { authKeys } from './keys';
import { CALLBACK_PATH, SCOPE, WEB_CLIENT_PATH } from './metadata';
import { COOKIE_PREFIX, safeReturnPath } from './sign-in';

const SESSION_COOKIE = `${COOKIE_PREFIX}.session`;
const FLOW_COOKIE = `${COOKIE_PREFIX}.oidc`;
const OPERATOR_COOKIE = `${COOKIE_PREFIX}.operator`;
// Browsers cap a cookie near 4 KB; larger sessions split into numbered chunks.
const CHUNK_SIZE = 3800;
/** Admin, agent, credential and member changes act on roles at most this old, in seconds. */
const PRIVILEGED_FRESHNESS_S = 60;
const SESSION_TTL_S = 30 * 24 * 3600;
const FLOW_TTL_S = 600;
/** Operator mode lasts this long from the re-authentication, and ends sooner after `OPERATOR_IDLE_S` without a request. */
const OPERATOR_TTL_S = 3600;
const OPERATOR_IDLE_S = 900;
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
  operator?: boolean;
}

/** An operator session: who re-authenticated, for which server, when, and their last request. */
interface Operator extends JWTPayload {
  sub: string;
  aud: string;
  at: number;
  seen: number;
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

/** The operator page in the session's active organization. */
function operatorPath(claims?: Claims): string {
  const slug = (claims?.orgs.find(org => org.id === claims.org) ?? claims?.orgs[0])?.slug;

  return slug ? `/dash/${encodeURIComponent(slug)}/operator` : '/dash/operator';
}

/** The request's organization: an explicit header, else the session's active one, else the first. */
function withOrganization(headers: Headers, info: SessionInfo, active?: string): SessionInfo {
  const wanted = headers.get('x-coder-organization');
  if (wanted) return chosenOrganization(info, wanted);
  const org = info.organizations.find(o => o.id === active) ?? info.organizations[0];
  return org ? { ...info, organizationId: org.id, role: org.role } : info;
}

export async function createAuth(db: Db, config: ServerConfig): Promise<AuthApi> {
  const issuer = config.auth!.wular.url;
  const publicUrl = config.publicUrl!;
  const resource = new URL(publicUrl).origin;
  const secure = publicUrl.startsWith('https:');
  const keys = await authKeys(config);
  const accountDb = (store?: Store) => (store instanceof DrizzleStore ? store.db : db);
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
    const listed = (org: unknown) => orgs.find(candidate => candidate.id === org)?.id;
    return {
      sub: id.sub,
      name: typeof id.name === 'string' ? id.name : '',
      email: typeof id.email === 'string' ? id.email : '',
      orgs,
      // A choice made in Coder sticks; Wular's active organization comes next.
      org: listed(previous?.org) ?? listed(id.org) ?? orgs[0]?.id,
      exp_at: epoch() + (tokens.expires_in ?? 600),
      at: epoch(),
      rt: tokens.refresh_token ?? previous?.rt,
      idt: tokens.id_token ?? previous?.idt,
    };
  }

  /** Keeps each organization's slug and name in its own state, for dashboard links made without a session; sign-in never fails on it. */
  const remember = async (orgs: OrganizationInfo[]) => {
    try {
      await Promise.all(
        orgs.map(({ id, slug, name }) =>
          new DrizzleStore(db, id).put('delivery', 'workspace', { slug, name }),
        ),
      );
    } catch (error) {
      console.error('coder server: saving organizations failed', error);
    }
  };

  const refreshed = new Map<string, Promise<Claims | false | undefined>>();
  /** New claims from the refresh grant; false when Wular rejects the token, undefined when it cannot answer. */
  function refresh(claims: Claims): Promise<Claims | false | undefined> {
    const token = claims.rt;
    if (!token) return Promise.resolve(undefined);
    let found = refreshed.get(token);
    if (!found) {
      found = configuration()
        .then(wular => oidc.refreshTokenGrant(wular, token))
        .then(tokens => fromTokens(tokens, claims))
        .then(next => {
          // A request waits on Wular here already; the names are saved beside it.
          void remember(next.orgs);
          return next;
        })
        .catch((error: unknown) => {
          refreshed.delete(token);
          return error instanceof oidc.ResponseBodyError && error.error === 'invalid_grant'
            ? false
            : undefined;
        });
      refreshed.set(token, found);
      setTimeout(() => refreshed.delete(token), REFRESHED_TTL_MS).unref?.();
    }
    // Requests share one refresh per token; each keeps the organization its own cookie has active.
    return found.then(next =>
      next && next.orgs.some(org => org.id === claims.org) ? { ...next, org: claims.org } : next,
    );
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
    return withOrganization(
      headers,
      info,
      typeof payload.org === 'string' ? payload.org : undefined,
    );
  }

  async function signIn(url: URL): Promise<Response> {
    const wular = await configuration().catch(() => undefined);
    if (!wular) return Response.redirect(`${publicUrl}/login?error=unavailable`, 302);
    const operator = url.searchParams.get('operator') === '1';
    // Signing in again, possibly as someone else, as from another workspace's link.
    const again = url.searchParams.get('prompt') === 'login';
    const flow: Flow = {
      verifier: oidc.randomPKCECodeVerifier(),
      state: oidc.randomState(),
      nonce: oidc.randomNonce(),
      return: operator ? '/dash' : safeReturnPath(url.searchParams.get('return'), resource),
      ...(operator ? { operator } : {}),
    };
    const target = oidc.buildAuthorizationUrl(wular, {
      redirect_uri: redirectUri,
      // Operator mode re-authenticates and takes only the identity, so no refresh token exists for it.
      ...(operator ? { scope: 'openid', prompt: 'login' } : { scope: SCOPE }),
      ...(again ? { prompt: 'login' } : {}),
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
    let authTime: unknown;
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
      authTime = tokens.claims()?.auth_time;
    } catch {
      return failed('sign_in_failed');
    }
    if (flow.operator) return enterOperator(req, claims.sub, authTime);
    await remember(claims.orgs);
    const headers = new Headers({ location: flow.return });
    headers.append('set-cookie', cookie(FLOW_COOKIE, '', 0));
    for (const value of await storeSession(req.headers, claims))
      headers.append('set-cookie', value);
    return new Response(null, { status: 302, headers });
  }

  const sealOperator = (entered: Operator) =>
    seal(entered, entered.at + OPERATOR_TTL_S - entered.seen).then(sealed =>
      cookie(OPERATOR_COOKIE, sealed, entered.at + OPERATOR_TTL_S - entered.seen),
    );

  /** Starts operator mode for the signed-in operator who just signed in again; the normal session stays as it is. */
  async function enterOperator(req: Request, sub: string, authTime: unknown): Promise<Response> {
    const session = await open<Claims>(readSession(req.headers));
    const now = epoch();
    const fresh = typeof authTime === 'number' && now - authTime <= PRIVILEGED_FRESHNESS_S;
    const allowed = fresh && session?.sub === sub && config.operators?.includes(sub);
    const headers = new Headers({
      location: allowed
        ? operatorPath(session)
        : `${operatorPath(session)}?error=${fresh ? 'denied' : 'stale'}`,
    });
    headers.append('set-cookie', cookie(FLOW_COOKIE, '', 0));
    if (allowed)
      headers.append('set-cookie', await sealOperator({ sub, aud: resource, at: now, seen: now }));
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
    response.headers.append('set-cookie', cookie(OPERATOR_COOKIE, '', 0));
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
    async session(headers, fresh = false, cookies = []) {
      const authorization = headers.get('authorization');
      if (authorization?.startsWith('Bearer '))
        return bearerSession(authorization.slice('Bearer '.length), headers, fresh);
      let claims = await open<Claims>(readSession(headers));
      if (!claims) return undefined;
      if (claims.exp_at <= epoch() || (fresh && epoch() - claims.at > PRIVILEGED_FRESHNESS_S)) {
        const next = await refresh(claims);
        // A rejected refresh token is dead; clear it so later requests stop retrying it.
        if (next === false) cookies.push(...clearSession(headers));
        if (!next) return undefined;
        claims = next;
        cookies.push(...(await storeSession(headers, claims)));
      }
      return withOrganization(
        headers,
        {
          user: { id: claims.sub, name: claims.name, email: claims.email },
          organizations: claims.orgs,
        },
        claims.org,
      );
    },
    async operator(headers, cookies = []) {
      const sealed = readCookies(headers).get(OPERATOR_COOKIE);
      const entered = await open<Operator>(sealed);
      const now = epoch();
      if (
        !entered ||
        entered.aud !== resource ||
        now - entered.seen > OPERATOR_IDLE_S ||
        now >= entered.at + OPERATOR_TTL_S
      ) {
        if (sealed) cookies.push(cookie(OPERATOR_COOKIE, '', 0));
        return undefined;
      }
      cookies.push(await sealOperator({ ...entered, seen: now }));
      return entered.sub;
    },
    async setOrganization(headers, slug, cookies = []) {
      let claims = await open<Claims>(readSession(headers));
      if (claims && claims.exp_at <= epoch()) claims = (await refresh(claims)) || undefined;
      const org = claims?.orgs.find(candidate => candidate.slug === slug);
      if (!claims || !org) return undefined;

      if (claims.org !== org.id)
        cookies.push(...(await storeSession(headers, { ...claims, org: org.id })));
      return org;
    },
    async organization(id) {
      const named = await new DrizzleStore(db, id).get('delivery', 'workspace');

      return named && 'slug' in named ? named : undefined;
    },
    async link(user, platform, platformUserId, extra = {}, store) {
      const known = {
        name: user.name,
        email: user.email,
        ...(extra.organizations ? { organizations: extra.organizations } : {}),
        ...(extra.token ? { token: extra.token } : {}),
      };
      await accountDb(store)
        .insert(platformLink)
        .values({ platform, platformUserId, userId: user.id, ...known })
        .onConflictDoUpdate({
          target: [platformLink.platform, platformLink.platformUserId],
          set: known,
          setWhere: eq(platformLink.userId, user.id),
        });
      const [row] = await accountDb(store)
        .select({ userId: platformLink.userId })
        .from(platformLink)
        .where(
          and(eq(platformLink.platform, platform), eq(platformLink.platformUserId, platformUserId)),
        );
      return row?.userId === user.id ? 'linked' : 'taken';
    },
    async linkedAccounts(userId, store) {
      const rows = await accountDb(store)
        .select()
        .from(platformLink)
        .where(eq(platformLink.userId, userId));

      return rows.map(row => ({
        platform: row.platform,
        platformUserId: row.platformUserId,
        name: row.name,
        email: row.email,
        ...(row.organizations ? { organizations: row.organizations } : {}),
        ...(row.token ? { token: row.token } : {}),
      }));
    },
    async unlink(userId, platform, platformUserId, store) {
      await accountDb(store)
        .delete(platformLink)
        .where(
          and(
            eq(platformLink.userId, userId),
            eq(platformLink.platform, platform),
            eq(platformLink.platformUserId, platformUserId),
          ),
        );
    },
    async refreshLinkedToken(userId, platform, platformUserId, previous, next, store) {
      const [row] = await accountDb(store)
        .update(platformLink)
        .set({ token: next })
        .where(
          and(
            eq(platformLink.userId, userId),
            eq(platformLink.platform, platform),
            eq(platformLink.platformUserId, platformUserId),
            eq(platformLink.token, previous),
          ),
        )
        .returning({ userId: platformLink.userId });

      return !!row;
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
