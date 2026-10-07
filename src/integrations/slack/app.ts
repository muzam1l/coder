/** Slack app creation from a manifest plus the OAuth install dance for that app. */
import { escapeHtml, htmlResponse } from '../../utils/html';
import type { AgentDefinition, Preset } from '../../agent/types';
import type { IntegrationApp } from '../types';
import { SLACK_READ_METHODS } from './tools';

type Fetcher = typeof fetch;

export interface SlackAppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  /** App configuration tokens, rotated via `tooling.tokens.rotate`. */
  configToken?: string;
  configRefreshToken?: string;
}

function baseUrl(publicUrl: string): string {
  return publicUrl.replace(/\/$/, '');
}

export function slackManifest(
  publicUrl: string,
  {
    name,
    scopes,
    events,
    extras,
  }: {
    name: string;
    scopes: string[];
    events: string[];
    /** `slackManifestExtras(...)`: slash commands and the assistant view. */
    extras?: { slash_commands?: unknown; assistant_view?: unknown };
  },
): Record<string, unknown> {
  const base = baseUrl(publicUrl);
  return {
    display_information: { name },
    features: { bot_user: { display_name: name }, ...extras },
    oauth_config: {
      redirect_urls: [`${base}/install/slack/callback`],
      scopes: { bot: scopes },
    },
    settings: {
      event_subscriptions: {
        request_url: `${base}/hooks/slack`,
        bot_events: events,
      },
    },
  };
}

/** `apps.manifest.create` with an app configuration token. */
/** One Slack Web API call through the adapter's fetch-based client; Slack's own error when it is not ok. */
async function slackApi<T>(
  method: string,
  body: Record<string, unknown>,
  token: string,
  request: Fetcher,
): Promise<T> {
  const { assertSlackOk, callSlackApi } = await import('@chat-adapter/slack/api');
  const value = await callSlackApi(method, body, { token, fetch: request });
  assertSlackOk(method, value);
  return value as T;
}

async function createSlackApp(
  configToken: string,
  manifest: Record<string, unknown>,
  request: Fetcher = fetch,
): Promise<Omit<SlackAppCredentials, 'configToken' | 'configRefreshToken'>> {
  const value = await slackApi<{
    app_id: string;
    credentials: { client_id: string; client_secret: string; signing_secret: string };
  }>('apps.manifest.create', { manifest: JSON.stringify(manifest) }, configToken, request);
  return {
    appId: value.app_id,
    clientId: value.credentials.client_id,
    clientSecret: value.credentials.client_secret,
    signingSecret: value.credentials.signing_secret,
  };
}

/** The manifest an agent's definition asks for. */
function agentManifest(publicUrl: string, name: string, definition: AgentDefinition) {
  const wiring = definition.integrations.slack ?? {};
  const events = Array.isArray(wiring.triggers)
    ? wiring.triggers
    : Object.keys(wiring.triggers ?? {});
  return slackManifest(publicUrl, {
    name,
    scopes: slackAppScopes(wiring.tools),
    events: slackAppEvents(events),
    extras: slackManifestExtras(publicUrl, definition),
  });
}

/** `tooling.tokens.rotate`: config tokens expire after 12 hours. */
async function rotateConfigToken(
  refreshToken: string,
  request: Fetcher = fetch,
): Promise<{ token: string; refreshToken: string }> {
  const response = await request('https://slack.com/api/tooling.tokens.rotate', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: refreshToken }),
  });
  const value = (await response.json()) as {
    ok?: boolean;
    error?: string;
    token?: string;
    refresh_token?: string;
  };
  if (!response.ok || !value.ok || !value.token || !value.refresh_token)
    throw new Error(`Slack token rotation failed: ${value.error ?? response.statusText}`);
  return { token: value.token, refreshToken: value.refresh_token };
}

export function oauthInstallUrl(
  credentials: Pick<SlackAppCredentials, 'clientId'>,
  publicUrl: string,
  state: string,
  scopes: string[] = [],
): string {
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    state,
    redirect_uri: `${baseUrl(publicUrl)}/install/slack/callback`,
  });
  if (scopes.length) params.set('scope', scopes.join(','));
  return `https://slack.com/oauth/v2/authorize?${params}`;
}

async function oauthCallback(
  code: string,
  credentials: Pick<SlackAppCredentials, 'clientId' | 'clientSecret'>,
  publicUrl: string,
  request: Fetcher = fetch,
): Promise<{
  teamId: string;
  teamName: string;
  accessToken: string;
  /** Slack user who installed; receives the welcome DM. */
  installer?: string;
}> {
  const response = await request('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: `${baseUrl(publicUrl)}/install/slack/callback`,
    }),
  });
  const value = (await response.json()) as {
    ok?: boolean;
    error?: string;
    access_token?: string;
    team?: { id?: string; name?: string };
    authed_user?: { id?: string };
  };
  if (!response.ok || !value.ok || !value.access_token || !value.team?.id || !value.team.name)
    throw new Error(`Slack OAuth failed: ${value.error ?? response.statusText}`);
  return {
    teamId: value.team.id,
    teamName: value.team.name,
    accessToken: value.access_token,
    ...(value.authed_user?.id ? { installer: value.authed_user.id } : {}),
  };
}

/** DM sent to the installer right after a Slack install. */
export function welcomeMessage(agentName: string, connect: Record<string, string>): string {
  return [
    `Hi, I'm ${agentName}. Ask me here or mention me in any channel; a thread keeps its context for follow-ups.`,
    'Use `/setup show` to see my settings. Workspace admins configure connected repositories in the Coder dashboard.',
    ...Object.entries(connect).map(([id, url]) => `Connect ${id} so I can act there: ${url}`),
  ].join('\n\n');
}

export const slackApp: IntegrationApp = {
  createPage({ publicUrl, state }) {
    const base = baseUrl(publicUrl);
    const hidden = Object.entries(state)
      .filter(([, value]) => value !== undefined)
      .map(
        ([key, value]) =>
          `<input type="hidden" name="${key}" value="${escapeHtml(String(value))}">`,
      )
      .join('');
    return htmlResponse(
      `<title>Create Slack app</title><p>Slack creates apps only with an app configuration token. Open <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps</a>, scroll to “Your App Configuration Tokens”, click Generate, and paste the access token below. Tokens expire after 12 hours; paste the refresh token too so the receiver can keep the app's manifest updated when this agent changes.</p>` +
        `<form method="post" action="${base}/create/slack/callback">${hidden}<p><input name="token" size="60" placeholder="xoxe.xoxp-..." required></p><p><input name="refreshToken" size="60" placeholder="xoxe-... refresh token (recommended)"></p><button type="submit">Create Slack app</button></form>`,
    );
  },
  async createCallback(req, { publicUrl, state, definition, fetch: request }) {
    const form = new URLSearchParams(await req.text());
    const token = form.get('token');
    if (!token) throw new Error('Missing configuration token');
    const name = definition.name ?? state.agent;
    const created = await createSlackApp(
      token,
      agentManifest(publicUrl, name, definition),
      request,
    );
    const refreshToken = form.get('refreshToken');
    const rotated = refreshToken ? await rotateConfigToken(refreshToken, request) : undefined;
    const credentials: SlackAppCredentials = {
      ...created,
      configToken: rotated?.token ?? token,
      configRefreshToken: rotated?.refreshToken ?? refreshToken ?? undefined,
    };
    return { platformAppId: created.appId, name, credentials };
  },
  // Configuration tokens last 12 hours, so every update saves a fresh pair first.
  async update(app, credentials, { publicUrl, definition, fetch: request, saveCredentials }) {
    const current = credentials as SlackAppCredentials;
    if (!current.configRefreshToken) return undefined;
    const rotated = await rotateConfigToken(current.configRefreshToken, request);
    await saveCredentials({
      ...current,
      configToken: rotated.token,
      configRefreshToken: rotated.refreshToken,
    });
    await slackApi(
      'apps.manifest.update',
      {
        app_id: current.appId,
        manifest: JSON.stringify(agentManifest(publicUrl, app.name, definition)),
      },
      rotated.token,
      request,
    );
  },
  installUrl(_app, credentials, { publicUrl, state }) {
    return oauthInstallUrl(credentials as SlackAppCredentials, publicUrl, state);
  },
  async installCallback(req, { app, credentials, publicUrl, fetch: request, connect }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new Error('Missing Slack OAuth code');
    const result = await oauthCallback(
      code,
      credentials as SlackAppCredentials,
      publicUrl,
      request,
    );
    const links = await connect(`${app.id}:${result.teamId}`);
    if (result.installer)
      await slackApi(
        'chat.postMessage',
        { channel: result.installer, text: welcomeMessage(app.name, links) },
        result.accessToken,
        request,
      ).catch(() => undefined);
    const connectHtml = Object.entries(links)
      .map(
        ([id, url]) =>
          `<p><a href="${escapeHtml(url)}">Connect ${escapeHtml(id)}</a> so the agent can act there.</p>`,
      )
      .join('');
    return {
      platformInstallId: result.teamId,
      account: { login: result.teamName },
      token: result.accessToken,
      installer: result.installer,
      ...(result.installer ? { user: { id: result.installer } } : {}),
      response: htmlResponse(
        `<title>Connected</title><p>Connected ${escapeHtml(result.teamName)}.</p>${connectHtml}`,
      ),
    };
  },
};

const OBSERVE_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'im:history',
  'channels:read',
  'users:read',
  'reactions:read',
  'commands',
];
/** Bot token scopes for a Slack app manifest; anything beyond observe can post and react. */
export function slackAppScopes(tools: Preset | string[] = 'observe'): string[] {
  const observe = new Set(Object.keys(SLACK_READ_METHODS));
  const readOnly = Array.isArray(tools)
    ? tools.every(tool => observe.has(tool))
    : tools === 'observe';
  return readOnly
    ? [...OBSERVE_SCOPES]
    : [...OBSERVE_SCOPES, 'chat:write', 'reactions:write', 'im:write', 'assistant:write'];
}
const APP_EVENTS: Record<string, string[]> = {
  mention: ['app_mention'],
  message: ['message.channels', 'message.groups', 'message.im'],
  reaction: ['reaction_added'],
};
/** Slack manifest agent events for catalog event names. */
export function slackAppEvents(events: string[]): string[] {
  return [...new Set(events.flatMap(event => APP_EVENTS[event] ?? []))];
}

/** Manifest pieces beyond scopes and events: the `/setup` slash command and the assistant view. */
export function slackManifestExtras(
  publicUrl: string,
  agent: { name?: string; description?: string },
): {
  slash_commands: Array<Record<string, string>>;
  assistant_view: { assistant_description: string };
} {
  const base = publicUrl.replace(/\/$/, '');
  return {
    slash_commands: [
      {
        command: '/setup',
        url: `${base}/hooks/slack`,
        description: 'Configure this agent',
        usage_hint: 'repo owner/name | model <name> | show',
      },
    ],
    assistant_view: {
      assistant_description: agent.description ?? `${agent.name ?? 'Coder'} in your workspace.`,
    },
  };
}
