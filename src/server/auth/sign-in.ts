/** Sign-in with Wular: an OpenID Connect client with a stateless encrypted session cookie, the bearer tokens Wular issues for this server, and the stored platform account links. */
// Loaded only through auth/index.ts, which context/create.ts imports lazily, so openid-client, jose and the Postgres store stay off the boot path.
import { createECDH, hkdfSync } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import {
  EncryptJWT,
  calculateJwkThumbprint,
  createRemoteJWKSet,
  jwtDecrypt,
  jwtVerify,
  errors,
  type JWK,
  type JWTPayload,
} from 'jose';
import * as oidc from 'openid-client';

import type { AuthApi, ServerConfig, OrganizationInfo, SessionInfo } from '../context';
import { chosenOrganization, linkedOrganizations } from '../context';
import type { Db } from '../store/pg/client';
import type { Store } from '../store/types';
import { DrizzleStore } from '../store/pg/store';
import { platformLink, secret, workspace } from '../store/pg/schema';
import { addSecret, dropSecrets, setSecret } from '../store/pg/tables/shared';
import { sameOriginProof } from '../routes/guards';
import { forbidden, notFound, safeReturnPath, signInPrompt } from '../routes/http';
import { CALLBACK_PATH, SCOPE, WEB_CLIENT_PATH } from './metadata';

/** Prefix of Coder's cookies, so another app on the host never collides. */
export const COOKIE_PREFIX = 'coder';

type SessionAuth = Pick<
  AuthApi,
  'issuer' | 'jwks' | 'handler' | 'session' | 'operator' | 'setOrganization' | 'organization'
>;

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

export async function createSessionAuth(db: Db, config: ServerConfig): Promise<SessionAuth> {
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

  /** Keeps each organization's slug and name on its workspace row, for dashboard links made without a session; sign-in never fails on it. */
  const remember = async (orgs: OrganizationInfo[]) => {
    try {
      if (orgs.length)
        await db
          .insert(workspace)
          .values(orgs.map(({ id, slug, name }) => ({ organizationId: id, slug, name })))
          .onConflictDoUpdate({
            target: workspace.organizationId,
            set: { slug: sql`excluded.slug`, name: sql`excluded.name` },
          });
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
          // A request waits on Wular here already; the names and links are saved beside it.
          if (!isDeepStrictEqual(next.orgs, claims.orgs)) void remember(next.orgs);
          void relink(db, next.sub, next.orgs);
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
      .catch(error => {
        if (
          !(error instanceof errors.JOSEError) ||
          error instanceof errors.JWKSTimeout ||
          error.code === 'ERR_JOSE_GENERIC'
        )
          console.error('coder server: bearer verification unavailable', error);
        return undefined;
      });
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
    // Signing in again, possibly as someone else, or picking or creating a workspace in Wular Auth.
    const prompt = signInPrompt(url);
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
      ...(operator
        ? { scope: 'openid', prompt: 'login' }
        : {
            scope: SCOPE,
            ...(prompt && { prompt }),
            // Wular Auth links it when a new workspace hits the account's limit.
            ...(prompt === 'select_account' && config.plansUrl && { plans_url: config.plansUrl }),
          }),
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
    await Promise.all([remember(claims.orgs), relink(db, claims.sub, claims.orgs)]);
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
    if (!allowed)
      console.error(
        `coder server: operator sign-in refused: ${fresh ? 'not this session or not an operator' : `auth_time ${typeof authTime === 'number' ? `${now - authTime}s old` : 'missing'}`}`,
      );
    // `entered` tells the page this sign-in just happened, so a failure there shows instead of signing in again.
    const headers = new Headers({
      location: `${operatorPath(session)}?${allowed ? 'entered=1' : `error=${fresh ? 'denied' : 'stale'}`}`,
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
      const [named] = await db
        .select({ slug: workspace.slug, name: workspace.name })
        .from(workspace)
        .where(eq(workspace.organizationId, id));

      return named?.slug ? { slug: named.slug, name: named.name ?? '' } : undefined;
    },
  };
}

/** Session and client keys, derived with HKDF from SERVER_ENCRYPTION_KEY (and its previous value while rotating). */
const derive = (secret: string, info: string) =>
  new Uint8Array(hkdfSync('sha256', secret, '', info, 32));

// An ES256 key whose private scalar is derived, so every instance signs with the same key.
async function clientKey(secret: string) {
  const d = derive(secret, 'coder oidc client key');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  const jwk: JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
    y: Buffer.from(point.subarray(33)).toString('base64url'),
  };
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, d: Buffer.from(d).toString('base64url') },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const kid = await calculateJwkThumbprint(jwk);
  return { key, kid, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } };
}

interface AuthKeys {
  /** Session cookie keys, current first. */
  cookie: Uint8Array[];
  /** private_key_jwt signing key and the public keys the client metadata publishes. */
  client: { key: CryptoKey; kid: string };
  jwks: { keys: JWK[] };
}

export async function authKeys(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
): Promise<AuthKeys> {
  const secrets = [config.encryptionKey!, config.previousEncryptionKey].filter(
    (secret): secret is string => Boolean(secret),
  );
  const clients = await Promise.all(secrets.map(clientKey));
  return {
    cookie: secrets.map(secret => derive(secret, 'coder session cookie')),
    client: clients[0]!,
    jwks: { keys: clients.map(client => client.jwk) },
  };
}

/** Keeps the user's platform links in step with their workspaces and roles, writing only links that differ; sign-in never fails on it. */
export async function relink(db: Db, sub: string, orgs: OrganizationInfo[]) {
  const linked = linkedOrganizations(orgs);
  try {
    await db
      .update(platformLink)
      .set(linked)
      .where(
        and(
          eq(platformLink.userId, sub),
          sql`(${platformLink.organizations}, ${platformLink.roles}) is distinct from (${JSON.stringify(linked.organizations)}::jsonb, ${JSON.stringify(linked.roles)}::jsonb)`,
        ),
      );
  } catch (error) {
    console.error('coder server: updating linked accounts failed', error);
  }
}

/** The platform accounts linked to Wular users, with their platform tokens. */
export function platformLinks(
  db: Db,
): Pick<
  AuthApi,
  | 'link'
  | 'linkedAccounts'
  | 'organizationAccounts'
  | 'unlink'
  | 'refreshLinkedToken'
  | 'refuseLinkedToken'
  | 'linkedUser'
> {
  const accountDb = (store?: Store) => (store instanceof DrizzleStore ? store.db : db);
  // A link and its token row change together, in the caller's transaction when it has one.
  const linkTransaction = <T>(
    store: Store | undefined,
    key: string,
    work: (db: Db) => Promise<T>,
  ) =>
    store instanceof DrizzleStore
      ? store.transaction(key, s => work(s.db))
      : db.transaction(tx => work(tx as unknown as Db));
  const accounts = async (store: Store | undefined, where: SQL) =>
    (
      await accountDb(store)
        .select({ row: platformLink, token: secret.value })
        .from(platformLink)
        .leftJoin(secret, eq(secret.id, platformLink.tokenSecretId))
        .where(where)
    ).map(({ row, token }) => ({
      userId: row.userId,
      platform: row.platform,
      platformUserId: row.platformUserId,
      name: row.name,
      email: row.email,
      ...(row.organizations ? { organizations: row.organizations } : {}),
      ...(row.organizationId ? { organizationId: row.organizationId } : {}),
      ...(row.login ? { login: row.login } : {}),
      ...(token ? { token } : {}),
      ...(row.refusedAt ? { refusedAt: row.refusedAt.getTime() } : {}),
    }));

  return {
    link(user, platform, platformUserId, extra = {}, store) {
      const known = {
        name: user.name,
        email: user.email,
        ...(extra.organizations ? { organizations: extra.organizations } : {}),
        ...(extra.roles ? { roles: extra.roles } : {}),
        ...(extra.login ? { login: extra.login } : {}),
        ...(extra.token ? { organizationId: extra.organizationId ?? null } : {}),
      };
      return linkTransaction(store, `link:${platform}:${platformUserId}`, async db => {
        const [row] = await db
          .insert(platformLink)
          .values({ platform, platformUserId, userId: user.id, ...known })
          .onConflictDoUpdate({
            target: [platformLink.platform, platformLink.platformUserId],
            set: { ...known, ...(extra.token ? { refusedAt: null } : {}) },
            setWhere: eq(platformLink.userId, user.id),
          })
          .returning({
            id: platformLink.id,
            userId: platformLink.userId,
            tokenSecretId: platformLink.tokenSecretId,
          });
        if (row?.userId !== user.id) return 'taken';
        if (extra.token && row.tokenSecretId) await setSecret(db, row.tokenSecretId, extra.token);
        else if (extra.token)
          await db
            .update(platformLink)
            .set({ tokenSecretId: await addSecret(db, extra.token) })
            .where(eq(platformLink.id, row.id));

        return 'linked';
      });
    },
    linkedAccounts: (userId, store) => accounts(store, eq(platformLink.userId, userId)),
    organizationAccounts: (organizationId, store) =>
      accounts(
        store,
        sql`${platformLink.organizations} @> ${JSON.stringify([organizationId])}::jsonb`,
      ),
    unlink(userId, platform, platformUserId, store) {
      return linkTransaction(store, `link:${platform}:${platformUserId}`, async db => {
        const gone = await db
          .delete(platformLink)
          .where(
            and(
              eq(platformLink.userId, userId),
              eq(platformLink.platform, platform),
              eq(platformLink.platformUserId, platformUserId),
            ),
          )
          .returning({ secretId: platformLink.tokenSecretId });
        await dropSecrets(
          db,
          gone.map(row => row.secretId),
        );
      });
    },
    async refreshLinkedToken(userId, platform, platformUserId, previous, next, store) {
      const link = accountDb(store)
        .select({ id: platformLink.tokenSecretId })
        .from(platformLink)
        .where(
          and(
            eq(platformLink.userId, userId),
            eq(platformLink.platform, platform),
            eq(platformLink.platformUserId, platformUserId),
          ),
        );
      const [row] = await accountDb(store)
        .update(secret)
        .set({ value: next })
        .where(and(inArray(secret.id, link), eq(secret.value, previous)))
        .returning({ id: secret.id });

      return !!row;
    },
    async refuseLinkedToken(userId, platform, platformUserId, token, store) {
      await accountDb(store)
        .update(platformLink)
        .set({ refusedAt: new Date() })
        .where(
          and(
            eq(platformLink.userId, userId),
            eq(platformLink.platform, platform),
            eq(platformLink.platformUserId, platformUserId),
            inArray(
              platformLink.tokenSecretId,
              accountDb(store)
                .select({ id: secret.id })
                .from(secret)
                .where(eq(secret.value, token)),
            ),
          ),
        );
    },
    async linkedUser(platform, platformUserId) {
      const [row] = await db
        .select({
          id: platformLink.userId,
          name: platformLink.name,
          email: platformLink.email,
          organizations: platformLink.organizations,
          roles: platformLink.roles,
          login: platformLink.login,
          token: secret.value,
        })
        .from(platformLink)
        .leftJoin(secret, eq(secret.id, platformLink.tokenSecretId))
        .where(
          and(eq(platformLink.platform, platform), eq(platformLink.platformUserId, platformUserId)),
        );
      return (
        row && {
          id: row.id,
          name: row.name,
          email: row.email,
          ...(row.organizations ? { organizations: row.organizations } : {}),
          ...(row.roles ? { roles: row.roles } : {}),
          ...(row.login ? { login: row.login } : {}),
          ...(row.token ? { token: row.token } : {}),
        }
      );
    },
  };
}
