/** GitHub App creation from a manifest, installs bound by user authorization, and user OAuth for linking. */
import { escapeHtml, htmlResponse } from '../../utils/html';
import { PRESETS, type AgentApp, type Preset } from '../../agent/types';
import type { IntegrationApp, IntegrationUserAuth, PlatformUser } from '../types';
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
}

export interface GithubManifest {
  name: string;
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
  htmlUrl: string;
  installUrl: string;
}

export function buildGithubManifest(
  publicUrl: string,
  {
    name,
    permissions,
    events,
    state,
    isPublic = false,
  }: {
    name: string;
    permissions: Record<string, string>;
    events: string[];
    state: string;
    isPublic?: boolean;
  },
): GithubManifest {
  const base = publicUrl.replace(/\/$/, '');
  return {
    name,
    url: base,
    hook_attributes: { url: `${base}/hooks/github`, active: true },
    redirect_url: `${base}/create/github/callback?state=${encodeURIComponent(state)}`,
    callback_urls: [`${base}/install/github/callback`, `${base}/connect/github/callback`],
    request_oauth_on_install: true,
    public: isPublic,
    default_permissions: permissions,
    default_events: events,
  };
}

/** Where the manifest is posted: the user's own account, or an organization they admin. */
export function githubNewAppUrl(owner?: string): string {
  return owner
    ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new`
    : 'https://github.com/settings/apps/new';
}

export function githubManifestForm(manifest: GithubManifest, owner?: string): string {
  const value = JSON.stringify(manifest).replace(/'/g, '&#39;');
  return `<form method="post" action="${githubNewAppUrl(owner)}"><input type="hidden" name="manifest" value='${value}'><button type="submit">Create GitHub App</button></form>`;
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
    html_url?: string;
    install_url?: string;
  };
  const appId = body.app_id ?? body.id;
  if (
    !appId ||
    !body.slug ||
    !body.pem ||
    !body.webhook_secret ||
    !body.client_id ||
    !body.client_secret ||
    !body.html_url ||
    !body.install_url
  )
    throw new Error('GitHub App manifest conversion response was incomplete');
  return {
    appId: String(appId),
    slug: body.slug,
    privateKey: body.pem,
    webhookSecret: body.webhook_secret,
    clientId: body.client_id,
    clientSecret: body.client_secret,
    htmlUrl: body.html_url,
    installUrl: body.install_url,
  };
}

const OAUTH = 'https://github.com/login/oauth';

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
    throw new Error(`GitHub authorization failed: ${body.error ?? response.status}`);
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

async function verifiedUser(
  req: Request,
  credentials: unknown,
  redirectUri: string | undefined,
  request: Fetcher,
): Promise<PlatformUser & { accessToken: string }> {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) throw new Error('GitHub sent no authorization code');
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
/** GitHub App manifest webhook events for catalog event names. */
export function githubAppEvents(events: string[]): string[] {
  const names = events
    .map(event => APP_EVENTS[event])
    .filter((name): name is string => Boolean(name));
  return [...new Set([...names, 'push', 'installation', 'installation_repositories'])];
}

export const githubApp: IntegrationApp = {
  createPage({ publicUrl, state, definition, encodedState }) {
    const wiring = definition.integrations.github ?? {};
    const events = Array.isArray(wiring.triggers)
      ? wiring.triggers
      : Object.keys(wiring.triggers ?? {});
    const manifest = buildGithubManifest(publicUrl, {
      name: definition.name ?? state.agent,
      permissions: githubAppPermissions(wiring.tools),
      events: githubAppEvents(events),
      state: encodedState,
      isPublic: state.public === true,
    });
    return htmlResponse(
      `<title>Create GitHub App</title><p>Creating the GitHub App for <b>${escapeHtml(manifest.name)}</b>…</p>${githubManifestForm(manifest, state.owner)}<script>document.forms[0].submit()</script>`,
    );
  },
  async createCallback(req, { fetch: request }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new Error('Missing GitHub manifest code');
    const created = await convertGithubManifest(code, request);
    const credentials: GithubAppCredentials = {
      appId: created.appId,
      slug: created.slug,
      privateKey: created.privateKey,
      webhookSecret: created.webhookSecret,
      clientId: created.clientId,
      clientSecret: created.clientSecret,
    };
    return { platformAppId: created.appId, name: created.slug, credentials };
  },
  installUrl(_app: AgentApp, credentials, { state }) {
    const { slug } = credentials as GithubAppCredentials;
    return `https://github.com/apps/${slug}/installations/new?state=${encodeURIComponent(state)}`;
  },
  // The installer authorized the app; the installation counts only when their own token can see it.
  async installCallback(req, { credentials, fetch: request }) {
    const id = new URL(req.url).searchParams.get('installation_id');
    if (!id) throw new Error('Missing installation_id');
    const { accessToken, ...user } = await verifiedUser(req, credentials, undefined, request);
    const account = await userInstallation(
      accessToken,
      (credentials as GithubAppCredentials).appId,
      id,
      request,
    );
    if (!account) throw new Error('That installation is not one of yours on GitHub');
    return {
      platformInstallId: id,
      account,
      installer: user.id,
      user,
      response: htmlResponse(
        "<title>Connected</title><p>GitHub connected. The agent now runs on the repositories you picked; manage them from the app's settings page on GitHub.</p>",
      ),
    };
  },
};
