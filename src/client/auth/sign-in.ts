/** Wular tokens for a Coder server: loopback (RFC 8252) or device (RFC 8628) sign-in, and refresh. */
import http from 'node:http';
import process from 'node:process';

import * as oidc from 'openid-client';

import { CoderError } from '../../core/dispatch';
import { openUrl } from '../../tui/prompt';
import { serverFor } from '../../core/remote';
import { savedSessions, writeSessions, type Session } from './session';

const SCOPE = 'openid profile email offline_access organizations:read';
const CALLBACK_TIMEOUT_MS = 5 * 60_000;

export type Tokens = Pick<Session, 'token' | 'refreshToken' | 'expiresAt' | 'issuer' | 'user'>;

const clientId = (server: string) => `${server}/.well-known/oauth-cli-client.json`;

/** The server's authorization server, from its RFC 9728 protected resource metadata. */
async function discover(server: string, savedIssuer?: string) {
  const resource = new URL(server).origin;
  const response = await fetch(`${resource}/.well-known/oauth-protected-resource`).catch(
    (error: Error) => {
      throw new CoderError(
        'login-failed',
        `No Coder server answers at ${server}: ${error.message}`,
      );
    },
  );
  const metadata = (await response.json().catch(() => ({}))) as {
    resource?: unknown;
    authorization_servers?: unknown;
  };
  const issuer = Array.isArray(metadata.authorization_servers)
    ? metadata.authorization_servers[0]
    : undefined;
  if (!response.ok || metadata.resource !== resource || typeof issuer !== 'string')
    throw new CoderError('login-failed', `${server} does not offer sign-in.`, {
      hint: 'Sign-in needs a Postgres-backed server; see coder docs self-host',
    });
  if (savedIssuer !== undefined && issuer !== savedIssuer)
    throw new CoderError(
      'login-failed',
      "The server's sign-in issuer has changed. Sign in again before using this session.",
    );
  const config = await oidc
    .discovery(
      new URL(issuer),
      clientId(server),
      undefined,
      oidc.None(),
      new URL(issuer).protocol === 'http:' ? { execute: [oidc.allowInsecureRequests] } : undefined,
    )
    .catch((error: Error) => {
      throw new CoderError(
        'login-failed',
        `Wular Auth at ${issuer} did not answer: ${error.message}`,
      );
    });
  return { config, resource };
}

function tokens(
  config: oidc.Configuration,
  response: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers,
  previous?: Tokens,
): Tokens {
  const id = response.claims();
  const refreshToken = response.refresh_token ?? previous?.refreshToken;
  if (!refreshToken) throw new CoderError('login-failed', 'Wular Auth returned no refresh token.');
  return {
    token: response.access_token,
    refreshToken,
    expiresAt: Date.now() + (response.expires_in ?? 600) * 1000,
    issuer: config.serverMetadata().issuer,
    user: id
      ? {
          name: typeof id.name === 'string' ? id.name : '',
          email: typeof id.email === 'string' ? id.email : '',
        }
      : (previous?.user ?? { name: '', email: '' }),
  };
}

const failed = (error: unknown) =>
  new CoderError(
    'login-failed',
    error instanceof oidc.ResponseBodyError || error instanceof oidc.AuthorizationResponseError
      ? error.error === 'access_denied'
        ? 'Sign-in was denied in the browser.'
        : (error.error_description ?? error.error)
      : error instanceof Error
        ? error.message
        : String(error),
  );

/** Authorization code with PKCE through a one-shot listener on 127.0.0.1. */
export async function loopbackSignIn(server: string, open: (url: string) => void): Promise<Tokens> {
  const { config, resource } = await discover(server);
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();

  const listener = http.createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const { port } = listener.address() as { port: number };
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    // Only a callback carrying this sign-in's state ends the wait.
    const callback = new Promise<URL>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new CoderError('login-failed', 'Sign-in timed out.')),
        CALLBACK_TIMEOUT_MS,
      );
      listener.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri);
        if (url.pathname !== '/callback' || url.searchParams.get('state') !== state) {
          res.writeHead(404).end();
          return;
        }
        res
          .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
          .end(
            url.searchParams.has('error')
              ? 'Sign-in failed. You can close this tab and return to the terminal.'
              : 'Signed in. You can close this tab and return to the terminal.',
          );
        clearTimeout(timer);
        resolve(url);
      });
    });
    open(
      oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: SCOPE,
        resource,
        code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
        code_challenge_method: 'S256',
        state,
      }).href,
    );
    const response = await oidc
      .authorizationCodeGrant(
        config,
        await callback,
        { pkceCodeVerifier: verifier, expectedState: state },
        { resource },
      )
      .catch((error: unknown) => {
        throw failed(error);
      });
    return tokens(config, response);
  } finally {
    listener.close();
    listener.closeAllConnections();
  }
}

/** The device authorization grant, for machines without a browser. */
export async function deviceSignIn(
  server: string,
  onCode: (code: string, url: string) => void,
): Promise<Tokens> {
  const { config, resource } = await discover(server);
  try {
    const started = await oidc.initiateDeviceAuthorization(config, {
      scope: SCOPE,
      resource,
    });
    onCode(started.user_code, started.verification_uri_complete ?? started.verification_uri);
    return tokens(config, await oidc.pollDeviceAuthorizationGrant(config, started, { resource }));
  } catch (error) {
    throw failed(error);
  }
}

/** Rotates a saved login's tokens; undefined when Wular answers `invalid_grant` or `invalid_client`, which means signed out. */
export async function refreshSignIn(server: string, login: Tokens): Promise<Tokens | undefined> {
  const { config, resource } = await discover(server, login.issuer);
  try {
    return tokens(
      config,
      await oidc.refreshTokenGrant(config, login.refreshToken, { resource }),
      login,
    );
  } catch (error) {
    if (
      error instanceof oidc.ResponseBodyError &&
      (error.error === 'invalid_grant' || error.error === 'invalid_client')
    )
      return undefined;
    throw new CoderError(
      'server',
      `Wular Auth did not refresh the session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** RFC 7009: revoke the refresh token; best effort, sign-out proceeds either way. */
export async function revokeSignIn(server: string, login: Tokens): Promise<void> {
  const { config } = await discover(server, login.issuer);
  if (config.serverMetadata().revocation_endpoint)
    await oidc.tokenRevocation(config, login.refreshToken, {
      token_type_hint: 'refresh_token',
    });
}

type LoginOrganization = NonNullable<Session['organization']>;

/** Resolve an explicit choice, the only organization, or ask the caller to choose. */
export async function selectLoginOrganization(
  organizations: LoginOrganization[],
  requested?: string,
  choose?: (organizations: LoginOrganization[]) => Promise<string>,
): Promise<LoginOrganization | undefined> {
  if (!organizations.length)
    throw new CoderError('login-failed', 'This account belongs to no workspace.');
  if (requested) {
    const selected = organizations.find(organization => organization.slug === requested);
    if (!selected)
      throw new CoderError('login-failed', `You are not a member of workspace "${requested}".`);
    return selected;
  }
  if (organizations.length <= 1) return organizations[0];
  if (!choose)
    throw new CoderError('login-failed', 'Choose a workspace for this server.', {
      hint: 'Pass --workspace <slug>.',
    });
  const slug = await choose(organizations);
  return organizations.find(organization => organization.slug === slug);
}

/** A browser can open here: not over SSH, and on Linux only with a display. */
export const hasBrowser = () =>
  !process.env.SSH_CONNECTION &&
  (process.platform !== 'linux' || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY));

export interface SignInOptions {
  device?: boolean;
  open?: (url: string) => void;
  onCode?: (code: string, url: string) => void;
  organization?: string;
  chooseOrganization?: (organizations: LoginOrganization[]) => Promise<string>;
}

/** Sign in to `server` with Wular, then pick the workspace its commands use. */
export async function signIn(server: string, options: SignInOptions = {}): Promise<Session> {
  const signed = options.device
    ? await deviceSignIn(server, options.onCode ?? (() => {}))
    : await loopbackSignIn(server, options.open ?? openUrl);

  const me = await fetch(`${server}/me`, {
    headers: { authorization: `Bearer ${signed.token}` },
  }).catch((error: Error) => {
    throw new CoderError('login-failed', `No Coder server answers at ${server}: ${error.message}`);
  });
  const who = (await me.json().catch(() => ({}))) as {
    organizations?: LoginOrganization[];
  };
  if (!me.ok) throw new CoderError('login-failed', 'Signed in, but the server refused the token.');

  const organization = await selectLoginOrganization(
    who.organizations ?? [],
    options.organization,
    options.chooseOrganization,
  );
  return { ...signed, ...(organization ? { organization } : {}), at: Date.now() };
}

export async function logoutSession(server: string): Promise<{ ok: true; server: string }> {
  const logins = savedSessions();
  const login = logins[server];
  if (!login) throw new CoderError('login-failed', `Not signed in to ${server}.`);

  await revokeSignIn(server, login).catch(() => undefined);
  delete logins[server];
  writeSessions(logins);
  return { ok: true, server };
}

/** Saved server sessions: what `coder auth` and `auth.*` share. */
export const sessions = {
  /** Sign in with Wular and save the session unless `save` is false; the result names its server. */
  async login(
    options: SignInOptions & {
      server?: string | true;
      yes?: boolean;
      save?: boolean;
    } = {},
  ): Promise<Session & { server: string }> {
    const server = serverFor(options);
    const login = await signIn(server, options);

    if (options.save !== false) writeSessions({ ...savedSessions(), [server]: login });

    return { ...login, server };
  },
  logout: (options: { server?: string | true; yes?: boolean } = {}) =>
    logoutSession(serverFor(options)),
  status: () =>
    Object.fromEntries(
      Object.entries(savedSessions()).map(([server, login]) => [
        server,
        { user: login.user, organization: login.organization, at: login.at },
      ]),
    ),
};
