/** Slack app creation from a manifest plus the OAuth install dance for that app. */
import { IntegrationError, type AgentDefinition, type IntegrationApp, type Preset } from '../types';
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
  /** When `configToken` expires, in epoch milliseconds. */
  configTokenExpires?: number;
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
      org_deploy_enabled: true,
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
): Promise<Omit<SlackAppCredentials, 'configToken' | 'configRefreshToken' | 'configTokenExpires'>> {
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
  const events = Array.isArray(wiring.events) ? wiring.events : Object.keys(wiring.events ?? {});
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
): Promise<
  Required<Pick<SlackAppCredentials, 'configToken' | 'configRefreshToken' | 'configTokenExpires'>>
> {
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
    exp?: number;
  };
  if (!response.ok || !value.ok || !value.token || !value.refresh_token)
    throw new Error(`Slack token rotation failed: ${value.error ?? response.statusText}`);
  return {
    configToken: value.token,
    configRefreshToken: value.refresh_token,
    configTokenExpires: (value.exp ?? 0) * 1000,
  };
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
  /** The workspace, or the Enterprise Grid org of an org-wide install. */
  id: string;
  name: string;
  org: boolean;
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
    team?: { id?: string; name?: string } | null;
    enterprise?: { id?: string; name?: string } | null;
    is_enterprise_install?: boolean;
    authed_user?: { id?: string };
  };
  const org = value.is_enterprise_install === true;
  const owner = org ? value.enterprise : value.team;
  if (!response.ok || !value.ok || !value.access_token || !owner?.id || !owner.name)
    throw new IntegrationError('platform-error', value.error ?? String(response.status));
  return {
    id: owner.id,
    name: owner.name,
    org,
    accessToken: value.access_token,
    ...(value.authed_user?.id ? { installer: value.authed_user.id } : {}),
  };
}

/** Workspaces an org-wide token reaches, through every `auth.teams.list` page. */
async function grantedTeams(token: string, request: Fetcher): Promise<string[]> {
  const teams: string[] = [];
  let cursor = '';
  do {
    const page = await slackApi<{
      teams: Array<{ id: string }>;
      response_metadata?: { next_cursor?: string };
    }>('auth.teams.list', { limit: 1000, ...(cursor ? { cursor } : {}) }, token, request);
    teams.push(...page.teams.map(team => team.id));
    cursor = page.response_metadata?.next_cursor ?? '';
  } while (cursor);

  return teams;
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
  builtin: 'own',
  createStep: () => ({
    intro:
      "Coder creates the Slack app with a configuration token and installs its bot in the token's whole workspace.",
    link: 'https://api.slack.com/apps',
    steps: [
      {
        text: 'Under **Your App Configuration Tokens**, click **Generate Token** and pick the workspace the agent should join.',
      },
      { text: 'Paste the refresh token below, then approve the install when Slack asks.' },
    ],
    notes: [
      'A workspace that requires app approval sends the install to its admins first. In Enterprise Grid, only an org admin can install org-wide.',
      "To install the app in other Slack workspaces, click **Activate Public Distribution** under the app's **Manage Distribution**.",
    ],
    fields: [
      { name: 'refreshToken', label: 'Refresh token', placeholder: 'xoxe-1-…', required: true },
    ],
    submit: 'Create Slack app',
  }),
  async createCallback(req, { publicUrl, state, definition, fetch: request }) {
    const refreshToken = new URLSearchParams(await req.text()).get('refreshToken');
    if (!refreshToken) throw new Error('Missing refresh token');
    const rotated = await rotateConfigToken(refreshToken, request);
    const name = definition.name ?? state.agent;
    const created = await createSlackApp(
      rotated.configToken,
      agentManifest(publicUrl, name, definition),
      request,
    );
    return { platformAppId: created.appId, name, credentials: { ...created, ...rotated } };
  },
  // Configuration tokens last 12 hours; an expired one is rotated and the new pair saved first.
  async update(app, credentials, { publicUrl, definition, fetch: request, saveCredentials }) {
    let current = credentials as SlackAppCredentials;
    if (!current.configRefreshToken) return undefined;
    if (!current.configToken || (current.configTokenExpires ?? 0) <= Date.now() + 60_000) {
      current = { ...current, ...(await rotateConfigToken(current.configRefreshToken, request)) };
      await saveCredentials(current);
    }
    await slackApi(
      'apps.manifest.update',
      {
        app_id: current.appId,
        manifest: JSON.stringify(agentManifest(publicUrl, app.name, definition)),
      },
      current.configToken!,
      request,
    );
  },
  installUrl(_app, credentials, { publicUrl, state }) {
    return oauthInstallUrl(credentials as SlackAppCredentials, publicUrl, state);
  },
  async installCallback(req, { app, credentials, publicUrl, fetch: request, connect }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new IntegrationError('missing-code');
    const result = await oauthCallback(
      code,
      credentials as SlackAppCredentials,
      publicUrl,
      request,
    );
    const links = await connect(`${app.id}:${result.id}`);
    if (result.installer)
      await slackApi(
        'chat.postMessage',
        { channel: result.installer, text: welcomeMessage(app.name, links) },
        result.accessToken,
        request,
      ).catch(() => undefined);
    // Workspaces the org admin grants later arrive as `team_access_granted`.
    const covers = result.org
      ? await grantedTeams(result.accessToken, request).catch(() => null)
      : undefined;
    return {
      platformInstallId: result.id,
      account: { login: result.name, ...(result.org ? { type: 'Organization' } : {}) },
      token: result.accessToken,
      ...(result.org ? { covers } : {}),
      installer: result.installer,
      ...(result.installer ? { user: { id: result.installer } } : {}),
      ...(Object.keys(links).length ? { connect: links } : {}),
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
/** Slack manifest agent events for catalog event names, plus the workspace grants of an org install. */
export function slackAppEvents(events: string[]): string[] {
  return [
    ...new Set(events.flatMap(event => APP_EVENTS[event] ?? [])),
    'team_access_granted',
    'team_access_revoked',
  ];
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
