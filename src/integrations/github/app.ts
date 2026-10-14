/** GitHub App creation from a manifest, installs bound by user authorization, and user OAuth for linking. */
import {
  IntegrationError,
  PRESETS,
  type AgentApp,
  type AgentDefinition,
  type AppDrift,
  type IntegrationApp,
  type IntegrationUserAuth,
  type PlatformUser,
  type Preset,
} from '../types';
import { API, githubHeaders, type Fetcher } from './api';
import { GITHUB_PRESETS } from './tools';

export interface GithubAppCredentials {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  /** The app's OAuth client, for user authorization during install and linking. */
  clientId?: string;
  clientSecret?: string;
  /** The account the app lives on. */
  owner?: { login: string; type?: string };
}

export interface GithubManifest {
  name: string;
  description?: string;
  url: string;
  hook_attributes: { url: string; active: boolean };
  redirect_url: string;
  /** The install callback first, where GitHub returns after installing; then the link callback. */
  callback_urls: string[];
  /** GitHub asks the installer to authorize the app, so the callback can prove the installation is theirs. */
  request_oauth_on_install: boolean;
  public: boolean;
  default_permissions: Record<string, string>;
  default_events: string[];
}

export interface GithubAppCreated {
  appId: string;
  slug: string;
  privateKey: string;
  webhookSecret: string;
  clientId: string;
  clientSecret: string;
  owner?: { login: string; type?: string };
}

export function buildGithubManifest(
  publicUrl: string,
  {
    name,
    description,
    permissions,
    events,
    isPublic = false,
  }: {
    name: string;
    description?: string;
    permissions: Record<string, string>;
    events: string[];
    isPublic?: boolean;
  },
): GithubManifest {
  const base = publicUrl.replace(/\/$/, '');
  return {
    name,
    ...(description ? { description } : {}),
    url: base,
    hook_attributes: { url: `${base}/hooks/github`, active: true },
    redirect_url: `${base}/create/github/callback`,
    callback_urls: [`${base}/install/github/callback`, `${base}/connect/github/callback`],
    request_oauth_on_install: true,
    public: isPublic,
    default_permissions: permissions,
    default_events: [...new Set([...events, 'repository'])],
  };
}

/** Where the manifest is posted: the user's own account, or an organization they admin; GitHub hands `state` back on the redirect. */
export function githubNewAppUrl(owner?: string, state?: string): string {
  const base = owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';

  return state ? `${base}?state=${encodeURIComponent(state)}` : base;
}

export async function convertGithubManifest(
  code: string,
  fetcher: Fetcher = fetch,
): Promise<GithubAppCreated> {
  const response = await fetcher(`${API}/app-manifests/${encodeURIComponent(code)}/conversions`, {
    method: 'POST',
    headers: githubHeaders(),
  });
  if (!response.ok) throw new Error(`GitHub App manifest conversion failed: ${response.status}`);
  const body = (await response.json()) as {
    id?: number;
    app_id?: number;
    slug?: string;
    pem?: string;
    webhook_secret?: string;
    client_id?: string;
    client_secret?: string;
    owner?: { login?: string; type?: string };
  };
  const appId = body.app_id ?? body.id;
  if (
    !appId ||
    !body.slug ||
    !body.pem ||
    !body.webhook_secret ||
    !body.client_id ||
    !body.client_secret
  )
    throw new Error('GitHub App manifest conversion response was incomplete');
  return {
    appId: String(appId),
    slug: body.slug,
    privateKey: body.pem,
    webhookSecret: body.webhook_secret,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    ...(body.owner?.login ? { owner: { login: body.owner.login, type: body.owner.type } } : {}),
  };
}

const OAUTH = 'https://github.com/login/oauth';

/** The app's first callback URL; GitHub allows no extra parameters on a `redirect_uri`. */
const installRedirect = (publicUrl: string) =>
  `${publicUrl.replace(/\/$/, '')}/install/github/callback`;

/** The user token as stored: JSON of the access token, its refresh token, and when each expires. */
interface UserToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

function oauthClient(credentials: unknown): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = credentials as GithubAppCredentials;
  if (!clientId || !clientSecret)
    throw new Error('This GitHub App has no OAuth client; create it again from the dashboard');
  return { clientId, clientSecret };
}

async function tokenRequest(
  credentials: unknown,
  params: Record<string, string>,
  request: Fetcher,
  now: number,
): Promise<UserToken> {
  const { clientId, clientSecret } = oauthClient(credentials);
  const response = await request(`${OAUTH}/access_token`, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...params }),
  });
  const body = (await response.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };
  if (!response.ok || !body.access_token)
    throw new IntegrationError(
      'platform-error',
      body.error ?? String(response.status),
      `GitHub authorization failed: ${body.error ?? response.status}`,
    );
  return {
    accessToken: body.access_token,
    ...(body.refresh_token ? { refreshToken: body.refresh_token } : {}),
    ...(body.expires_in ? { expiresAt: now + body.expires_in * 1000 } : {}),
  };
}

async function githubUser(token: string, request: Fetcher): Promise<{ id: number; login: string }> {
  const response = await request(`${API}/user`, { headers: githubHeaders(token) });
  const body = (await response.json().catch(() => ({}))) as { id?: number; login?: string };
  if (!response.ok || !body.id || !body.login)
    throw new Error(`GitHub user lookup failed: ${response.status}`);
  return { id: body.id, login: body.login };
}

/** The user's installation of this app with that id, from `GET /user/installations`; never the callback's word. */
export async function userInstallation(
  token: string,
  appId: string,
  installationId: string,
  request: Fetcher = fetch,
): Promise<{ login: string; type?: string } | undefined> {
  for (let page = 1; page <= 10; page++) {
    const response = await request(`${API}/user/installations?per_page=100&page=${page}`, {
      headers: githubHeaders(token),
    });
    if (!response.ok) throw new Error(`GitHub installation check failed: ${response.status}`);
    const body = (await response.json()) as {
      installations?: Array<{
        id?: number;
        app_id?: number;
        account?: { login?: string; type?: string };
      }>;
    };
    const batch = body.installations ?? [];
    const found = batch.find(
      entry => String(entry.id) === installationId && String(entry.app_id) === appId,
    );
    if (found)
      return {
        login: found.account?.login ?? 'unknown',
        ...(found.account?.type ? { type: found.account.type } : {}),
      };
    if (batch.length < 100) return undefined;
  }
  return undefined;
}

/** The app's own JWT, for `/app` endpoints. */
async function appToken(credentials: GithubAppCredentials): Promise<string> {
  const { createAppAuth } = await import('@octokit/auth-app');
  const { token } = await createAppAuth({
    appId: credentials.appId,
    privateKey: credentials.privateKey,
  })({ type: 'app' });

  return token;
}

/** Whether this app owns the installation, from `GET /app/installations/{id}` as the app itself; GitHub answers 404 for another app's. */
export async function appInstallation(
  credentials: GithubAppCredentials,
  installationId: string,
  request: Fetcher = fetch,
): Promise<boolean> {
  const token = await appToken(credentials);
  const response = await request(`${API}/app/installations/${encodeURIComponent(installationId)}`, {
    headers: githubHeaders(token),
  });
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(`GitHub installation lookup failed: ${response.status}`);
  return true;
}

async function verifiedUser(
  req: Request,
  credentials: unknown,
  redirectUri: string | undefined,
  request: Fetcher,
): Promise<PlatformUser & { accessToken: string }> {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) throw new IntegrationError('missing-code');
  const token = await tokenRequest(
    credentials,
    { code, ...(redirectUri ? { redirect_uri: redirectUri } : {}) },
    request,
    Date.now(),
  );
  const user = await githubUser(token.accessToken, request);
  return {
    id: String(user.id),
    login: user.login,
    token: JSON.stringify(token),
    accessToken: token.accessToken,
  };
}

export const githubUserAuth: IntegrationUserAuth = {
  authorizeUrl(credentials, { publicUrl, state }) {
    const params = new URLSearchParams({
      client_id: oauthClient(credentials).clientId,
      redirect_uri: `${publicUrl.replace(/\/$/, '')}/connect/github/callback`,
      state,
    });
    return `${OAUTH}/authorize?${params}`;
  },
  async exchange(req, credentials, { publicUrl, fetch: request }) {
    const { accessToken: _accessToken, ...user } = await verifiedUser(
      req,
      credentials,
      `${publicUrl.replace(/\/$/, '')}/connect/github/callback`,
      request,
    );
    return user;
  },
  async access(stored, credentials, { fetch: request, now }) {
    const token = JSON.parse(stored) as UserToken;
    if (!token.expiresAt || token.expiresAt - 5 * 60_000 > now || !token.refreshToken)
      return { accessToken: token.accessToken };
    const refreshed = await tokenRequest(
      credentials,
      { grant_type: 'refresh_token', refresh_token: token.refreshToken },
      request,
      now,
    );
    return { accessToken: refreshed.accessToken, refreshed: JSON.stringify(refreshed) };
  },
};

/** Smallest preset holding every listed tool. */
function presetFor(tools: Preset | string[]): Preset {
  if (!Array.isArray(tools)) return tools;
  return (
    PRESETS.find(preset => tools.every(tool => GITHUB_PRESETS[preset].includes(tool))) ?? 'write'
  );
}
const APP_PERMISSIONS: Record<Preset, Record<string, string>> = {
  observe: { metadata: 'read', contents: 'read', pull_requests: 'read', issues: 'read' },
  comment: { metadata: 'read', contents: 'read', pull_requests: 'write', issues: 'write' },
  write: { metadata: 'read', contents: 'write', pull_requests: 'write', issues: 'write' },
};
/** GitHub App manifest permissions for a tools preset or explicit tool list. */
export function githubAppPermissions(tools: Preset | string[] = 'observe'): Record<string, string> {
  return { ...APP_PERMISSIONS[presetFor(tools)] };
}
const APP_EVENTS: Record<string, string> = {
  pull_request: 'pull_request',
  issue: 'issues',
  comment: 'issue_comment',
  mention: 'issue_comment',
};
/** GitHub App manifest webhook events for catalog event names; GitHub sends installation events to every app unasked. */
export function githubAppEvents(events: string[]): string[] {
  const names = events
    .map(event => APP_EVENTS[event])
    .filter((name): name is string => Boolean(name));
  return [...new Set([...names, 'push'])];
}

/** The manifest a definition asks for, named `name` unless the definition names itself. */
function agentManifest(
  publicUrl: string,
  definition: AgentDefinition,
  name: string,
  isPublic?: boolean,
): GithubManifest {
  const wiring = definition.integrations.github ?? {};
  const events = Array.isArray(wiring.events) ? wiring.events : Object.keys(wiring.events ?? {});

  return buildGithubManifest(publicUrl, {
    name: definition.name ?? name,
    description: definition.description,
    permissions: githubAppPermissions(wiring.tools),
    events: githubAppEvents(events),
    isPublic,
  });
}

const settingsPage = (slug: string, owner?: { login: string; type?: string }) =>
  owner?.type === 'Organization'
    ? `https://github.com/organizations/${encodeURIComponent(owner.login)}/settings/apps/${slug}`
    : `https://github.com/settings/apps/${slug}`;

const LEVELS: Record<string, number> = { read: 1, write: 2, admin: 3 };
const LEVEL_NAMES: Record<string, string> = {
  read: 'Read-only',
  write: 'Read and write',
  admin: 'Admin',
};
/** GitHub's label for an event or permission key, as its settings page shows it. */
const uiLabel = (key: string) => key[0]!.toUpperCase() + key.slice(1).replaceAll('_', ' ');

/** The app as GitHub has it, from `GET /app`, against the manifest Coder would create it with now. */
async function githubDrift(
  app: AgentApp,
  credentials: GithubAppCredentials,
  {
    publicUrl,
    definition,
    fetch: request,
  }: { publicUrl: string; definition: AgentDefinition; fetch: Fetcher },
): Promise<AppDrift> {
  const response = await request(`${API}/app`, {
    headers: githubHeaders(await appToken(credentials)),
  });
  if (!response.ok) throw new Error(`GitHub app lookup failed: ${response.status}`);
  const live = (await response.json()) as {
    slug?: string;
    name?: string;
    description?: string | null;
    owner?: { login?: string; type?: string };
    events?: string[];
    permissions?: Record<string, string>;
  };
  const wanted = agentManifest(publicUrl, definition, app.agent);
  const events = new Set(live.events ?? []);
  const permissions = live.permissions ?? {};
  const lines: AppDrift['lines'] = [];

  if (wanted.name !== live.name)
    lines.push({ text: `Rename the app to **${wanted.name}**`, copy: wanted.name });
  const description = wanted.description ?? '';
  if (description !== (live.description ?? ''))
    lines.push(
      description
        ? { text: 'Set the **Description**', copy: description }
        : { text: 'Clear the **Description**' },
    );
  for (const [key, level] of Object.entries(wanted.default_permissions))
    if ((LEVELS[permissions[key] ?? ''] ?? 0) < (LEVELS[level] ?? 0))
      lines.push({ text: `Set **${uiLabel(key)}** to **${LEVEL_NAMES[level] ?? level}**` });
  for (const event of wanted.default_events)
    if (!events.has(event)) lines.push({ text: `Check the **${uiLabel(event)}** event` });
  for (const event of events)
    if (!wanted.default_events.includes(event))
      lines.push({ text: `Uncheck the **${uiLabel(event)}** event` });

  const owner = live.owner?.login
    ? { login: live.owner.login, type: live.owner.type }
    : credentials.owner;
  const settings = settingsPage(live.slug ?? credentials.slug, owner);

  return { url: `${settings}/permissions`, label: 'Open app settings', lines };
}

export const githubApp: IntegrationApp = {
  builtin: 'shared',
  postOrigins: ['https://github.com'],
  createPost({ publicUrl, state, definition, encodedState }) {
    const manifest = agentManifest(publicUrl, definition, state.agent, state.public === true);
    return {
      url: githubNewAppUrl(state.owner, encodedState),
      fields: { manifest: JSON.stringify(manifest) },
    };
  },
  async createCallback(req, { fetch: request }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new IntegrationError('missing-code');
    const created = await convertGithubManifest(code, request);
    const credentials: GithubAppCredentials = {
      appId: created.appId,
      slug: created.slug,
      privateKey: created.privateKey,
      webhookSecret: created.webhookSecret,
      clientId: created.clientId,
      clientSecret: created.clientSecret,
      ...(created.owner ? { owner: created.owner } : {}),
    };
    return { platformAppId: created.appId, name: created.slug, credentials };
  },
  accountUrl: ({ login }) => `https://github.com/${encodeURIComponent(login)}`,
  settingsUrl(_app, credentials) {
    const { slug, owner } = credentials as GithubAppCredentials;
    return owner ? settingsPage(slug, owner) : undefined;
  },
  drift: (app, credentials, input) => githubDrift(app, credentials as GithubAppCredentials, input),
  installUrl(_app: AgentApp, credentials, { publicUrl, state, installation }) {
    const { slug } = credentials as GithubAppCredentials;
    if (!installation)
      return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
    // Verifying an install GitHub started: a fresh user authorization, back to the install callback with only Coder's state.
    const params = new URLSearchParams({
      client_id: oauthClient(credentials).clientId,
      redirect_uri: installRedirect(publicUrl),
      state,
    });
    return `${OAUTH}/authorize?${params}`;
  },
  // The callback's installation id is not trusted; each candidate app asks GitHub whether the installation is its own.
  async installedApp(req, { apps, fetch: request }) {
    const id = new URL(req.url).searchParams.get('installation_id');
    if (!id || !/^\d+$/.test(id)) return undefined;
    for (const { app, credentials } of apps) {
      // One app's revoked key never hides another app's installation.
      const owns = await appInstallation(credentials as GithubAppCredentials, id, request).catch(
        (error: unknown) => {
          console.error(
            `coder server: asking GitHub whether ${app.id} owns installation ${id} failed`,
            error,
          );
          return false;
        },
      );
      if (owns) return { app, installation: id };
    }
    return undefined;
  },
  // The installer authorized the app; the installation counts only when their own token can see it.
  async installCallback(req, { credentials, publicUrl, fetch: request, installation }) {
    const id = installation ?? new URL(req.url).searchParams.get('installation_id');
    if (!id) throw new IntegrationError('missing-code');
    const { accessToken, ...user } = await verifiedUser(
      req,
      credentials,
      installation ? installRedirect(publicUrl) : undefined,
      request,
    );
    const account = await userInstallation(
      accessToken,
      (credentials as GithubAppCredentials).appId,
      id,
      request,
    );
    if (!account) throw new IntegrationError('not-yours');
    return {
      platformInstallId: id,
      account,
      installer: user.id,
      user,
    };
  },
};
