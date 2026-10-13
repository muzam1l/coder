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
  /** The manifest's bot scopes, asked for again on every install. */
  scopes?: string[];
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
    /** `slackManifestExtras(...)`: slash commands and the agent view. */
    extras?: { slash_commands?: unknown; agent_view?: unknown };
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

/** The bot scopes an agent's definition asks for. */
const agentScopes = (definition: AgentDefinition) =>
  slackAppScopes(definition.integrations.slack?.tools);

/** The manifest an agent's definition asks for. */
function agentManifest(publicUrl: string, name: string, definition: AgentDefinition) {
  const wiring = definition.integrations.slack ?? {};
  const events = Array.isArray(wiring.events) ? wiring.events : Object.keys(wiring.events ?? {});
  return slackManifest(publicUrl, {
    name,
    scopes: agentScopes(definition),
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
    throw new IntegrationError('platform-error', value.error ?? String(response.status));
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
export function welcomeMessage(agentName: string): string {
  return [
    `Hi, I'm ${agentName}. Ask me here or mention me in any channel; a thread keeps its context for follow-ups.`,
    'Use `/setup show` to see my settings. Workspace admins configure connected repositories in the Coder dashboard.',
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
      {
        name: 'refreshToken',
        label: 'Refresh token',
        hint: 'Starts with xoxe-1-.',
        placeholder: 'xoxe-1-…',
        required: true,
      },
    ],
    submit: 'Create Slack app',
  }),
  async createCallback(req, { publicUrl, state, definition, fetch: request }) {
    const refreshToken = new URLSearchParams(await req.text()).get('refreshToken');
    if (!refreshToken) throw new Error('Missing refresh token');
    if (refreshToken.startsWith('xoxe.xoxp-'))
      throw new IntegrationError(
        'invalid-field',
        'access-token',
        'That is the access token, xoxe.xoxp-…. Paste the refresh token next to it, which starts with xoxe-1-.',
      );
    if (!refreshToken.startsWith('xoxe-1-'))
      throw new IntegrationError(
        'invalid-field',
        'refresh-token',
        'That is not a refresh token; they start with xoxe-1-. Copy it from Your App Configuration Tokens.',
      );
    const rotated = await rotateConfigToken(refreshToken, request);
    const name = definition.name ?? state.agent;
    const created = await createSlackApp(
      rotated.configToken,
      agentManifest(publicUrl, name, definition),
      request,
    );
    return {
      platformAppId: created.appId,
      name,
      credentials: { ...created, ...rotated, scopes: agentScopes(definition) },
    };
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
    const scopes = agentScopes(definition);
    if (scopes.join() !== current.scopes?.join()) await saveCredentials({ ...current, scopes });
  },
  settingsUrl: (_app, credentials) =>
    `https://api.slack.com/apps/${encodeURIComponent((credentials as SlackAppCredentials).appId)}`,
  // Slack's authorize page needs the scopes on the URL; an app created before they were saved asks for the write set.
  installUrl(_app, credentials, { publicUrl, state }) {
    const current = credentials as SlackAppCredentials;
    return oauthInstallUrl(current, publicUrl, state, current.scopes ?? slackAppScopes('write'));
  },
  async installCallback(req, { app, credentials, publicUrl, fetch: request }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new IntegrationError('missing-code');
    const result = await oauthCallback(
      code,
      credentials as SlackAppCredentials,
      publicUrl,
      request,
    );
    if (result.installer)
      await slackApi(
        'chat.postMessage',
        { channel: result.installer, text: welcomeMessage(app.name) },
        result.accessToken,
        request,
      ).catch(() => undefined);
    // The workspace address, for the dashboard's link; `auth.test` needs no scope.
    const url = await slackApi<{ url?: string }>('auth.test', {}, result.accessToken, request)
      .then(value => value.url?.replace(/\/$/, ''))
      .catch(() => undefined);
    // Workspaces the org admin grants later arrive as `team_access_granted`.
    const covers = result.org
      ? await grantedTeams(result.accessToken, request).catch(() => null)
      : undefined;
    return {
      platformInstallId: result.id,
      account: {
        login: result.name,
        ...(result.org ? { type: 'Organization' } : {}),
        ...(url ? { url } : {}),
      },
      token: result.accessToken,
      ...(result.org ? { covers } : {}),
      installer: result.installer,
      ...(result.installer ? { user: { id: result.installer } } : {}),
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

/** Manifest pieces beyond scopes and events: the `/setup` slash command and the agent view. */
export function slackManifestExtras(
  publicUrl: string,
  agent: { name?: string; description?: string },
): {
  slash_commands: Array<Record<string, string>>;
  agent_view: { agent_description: string };
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
    agent_view: {
      agent_description: agent.description ?? `${agent.name ?? 'Coder'} in your workspace.`,
    },
  };
}
