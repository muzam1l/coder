/** Slack app creation from a manifest plus the OAuth install dance for that app. */
import { isIP } from 'node:net';

import { IntegrationError, type AgentDefinition, type AppTokens, type IntegrationApp, type Preset } from '../types';

type Fetcher = typeof fetch;

export interface SlackAppCredentials {
  appId: string;
  clientId: string;
  clientSecret: string;
  signingSecret: string;
  configTokenId?: string;
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
    description,
    scopes,
    events,
    extras,
  }: {
    name: string;
    description?: string;
    scopes: string[];
    events: string[];
    /** `slackManifestExtras(...)`: slash commands and the agent view. */
    extras?: { slash_commands?: unknown; agent_view?: unknown };
  },
): Record<string, unknown> {
  const base = baseUrl(publicUrl);
  const host = new URL(base).hostname;
  return {
    display_information: {
      name,
      ...(description ? { description: description.slice(0, 140) } : {}),
    },
    features: {
      bot_user: { display_name: name, always_online: true },
      app_home: {
        home_tab_enabled: true,
        messages_tab_enabled: true,
        messages_tab_read_only_enabled: false,
      },
      // Slack unfurls only named domains, never an IP address or a host without a dot.
      ...(host.includes('.') && !isIP(host) ? { unfurl_domains: [host] } : {}),
      ...extras,
    },
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
      interactivity: { is_enabled: true, request_url: `${base}/hooks/slack` },
    },
  };
}

/** `apps.manifest.create` with an app configuration token. */
/** One Slack Web API call through the adapter's fetch-based client; Slack's own error when it is not ok. */
export async function slackApi<T>(
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
): Promise<SlackAppCredentials> {
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

/** The Slack events an agent's definition listens to. */
function agentEvents(definition: AgentDefinition): string[] {
  const events = definition.integrations.slack?.events;
  return Array.isArray(events) ? events : Object.keys(events ?? {});
}

/** The bot scopes an agent's definition asks for. */
const agentScopes = (definition: AgentDefinition) =>
  slackAppScopes(definition.access, agentEvents(definition));

/** The manifest an agent's definition asks for. */
function agentManifest(publicUrl: string, name: string, definition: AgentDefinition) {
  return slackManifest(publicUrl, {
    name,
    description: definition.description,
    scopes: agentScopes(definition),
    events: slackAppEvents(agentEvents(definition)),
    extras: slackManifestExtras(publicUrl, definition),
  });
}

export interface SlackConfigToken {
  configToken: string;
  configRefreshToken: string;
  configTokenExpires: number;
  workspace: string;
  user: string;
}

/** `tooling.tokens.rotate`: config tokens expire after 12 hours. */
export async function rotateConfigToken(
  refreshToken: string,
  request: Fetcher = fetch,
): Promise<SlackConfigToken> {
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
    team_id?: string;
    user_id?: string;
  };
  if (!response.ok || !value.ok || !value.token || !value.refresh_token || !value.team_id || !value.user_id)
    throw new IntegrationError('platform-error', value.error ?? String(response.status));
  return {
    workspace: value.team_id,
    user: value.user_id,
    configToken: value.token,
    configRefreshToken: value.refresh_token,
    configTokenExpires: (value.exp ?? 0) * 1000,
  };
}

async function withConfigToken<T>(
  tokens: AppTokens,
  id: string,
  request: Fetcher,
  run: (token: string) => Promise<T>,
): Promise<T> {
  return tokens.use(id, async (credentials, save, invalidate) => {
    let current = credentials as SlackConfigToken;
    if (current.configTokenExpires <= Date.now() + 60_000) {
      try {
        const rotated = await rotateConfigToken(current.configRefreshToken, request);
        if (rotated.workspace !== current.workspace || rotated.user !== current.user)
          throw new Error('Configuration token owner changed');
        current = rotated;
      } catch {
        await invalidate();
        throw new IntegrationError(
          'invalid-field',
          'token',
          'This configuration token could not be refreshed. Paste a new token.',
        );
      }
      await save(current);
    }
    return run(current.configToken);
  });
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

export const slackApp: IntegrationApp = {
  builtin: 'own',
  createStep: (_publicUrl, input) => {
    const saved = input?.saved ?? [];
    const when = saved.length ? { field: 'token', equals: 'new' } : undefined;
    return {
      intro:
        "Coder creates the Slack app with a configuration token and installs its bot in the token's whole workspace.",
      link: 'https://api.slack.com/apps',
      steps: [
        {
          ...(when ? { when } : {}),
          text: 'Under **Your App Configuration Tokens**, click **Generate Token** and pick the workspace the agent should join.',
        },
        {
          text: 'Paste the refresh token below, then approve the install when Slack asks.',
          ...(when ? { when } : {}),
        },
      ],
      notes: [
        'A workspace that requires app approval sends the install to its admins first. In Enterprise Grid, only an org admin can install org-wide.',
        "To install the app in other Slack workspaces, click **Activate Public Distribution** under the app's **Manage Distribution**.",
      ],
      fields: [
        ...(saved.length
          ? [
              {
                name: 'token',
                label: 'Configuration token',
                options: [
                  ...saved.map(({ id, label }) => ({ value: id, label })),
                  { value: 'new', label: 'Paste a new token' },
                ],
              },
            ]
          : []),
        {
          ...(when ? { when } : {}),
          name: 'refreshToken',
          label: 'Refresh token',
          hint: 'Starts with xoxe-1-.',
          placeholder: 'xoxe-1-…',
          required: true,
        },
      ],
      submit: 'Create Slack app',
    };
  },
  async createCallback(req, { publicUrl, state, definition, fetch: request, tokens }) {
    if (!tokens) throw new Error('Configuration token storage is unavailable');
    const form = new URLSearchParams(await req.text());
    let id = form.get('token');
    if (!id || id === 'new') {
      const refreshToken = form.get('refreshToken');
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
      const value = {
        workspace: rotated.workspace,
        user: rotated.user,
        workspaceName: rotated.workspace,
        credentials: rotated,
      };
      const identity = await slackApi<{ team?: string }>(
        'auth.test',
        {},
        rotated.configToken,
        request,
      ).catch(() => undefined);
      id = await tokens.put({
        ...value,
        workspaceName: identity?.team || value.workspaceName,
      });
    }
    const name = definition.name ?? state.agent;
    const created = await withConfigToken(tokens, id, request, token =>
      createSlackApp(token, agentManifest(publicUrl, name, definition), request),
    );
    return {
      platformAppId: created.appId,
      name,
      credentials: { ...created, configTokenId: id, scopes: agentScopes(definition) },
    };
  },
  manifest: (app, { publicUrl, definition }) => agentManifest(publicUrl, app.name, definition),
  async update(
    app,
    credentials,
    { publicUrl, definition, fetch: request, saveCredentials, tokens },
  ) {
    const current = credentials as SlackAppCredentials;
    if (!current.configTokenId || !tokens) throw new IntegrationError('no-refresh-token');
    await withConfigToken(tokens, current.configTokenId, request, token =>
      slackApi(
        'apps.manifest.update',
        {
          app_id: current.appId,
          manifest: JSON.stringify(agentManifest(publicUrl, app.name, definition)),
        },
        token,
        request,
      ),
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
  async installCallback(req, { app, credentials, publicUrl, fetch: request, tokens }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new IntegrationError('missing-code');
    const result = await oauthCallback(
      code,
      credentials as SlackAppCredentials,
      publicUrl,
      request,
    );
    const tokenId = (credentials as SlackAppCredentials).configTokenId;
    if (tokens && tokenId && !result.org)
      await tokens.use(tokenId, (pair, save) => save(pair, result.name));
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

const SCOPES = [
  'app_mentions:read',
  'channels:history',
  'groups:history',
  'im:history',
  'channels:read',
  'groups:read',
  'im:read',
  'mpim:read',
  'users:read',
  'users:read.email',
  'files:read',
  'usergroups:read',
  'reactions:read',
  'reactions:write',
  'commands',
  'links:read',
  'links:write',
];
/** Both modes can reply, react and upload files, and `dm` reads group DMs. */
export function slackAppScopes(
  tools: Preset | string[] = 'write',
  events: string[] = [],
): string[] {
  return [
    ...SCOPES,
    ...(events.includes('dm') ? ['mpim:history'] : []),
    'chat:write', 'files:write', 'im:write', 'assistant:write',
    ...((Array.isArray(tools) ? tools.includes('write') : tools === 'write')
      ? ['channels:join', 'channels:manage', 'groups:write', 'mpim:write', 'usergroups:write']
      : []),
  ];
}
const APP_EVENTS: Record<string, string[]> = {
  mention: ['app_mention'],
  dm: ['message.im', 'message.mpim'],
  channel: ['message.channels', 'message.groups'],
};
/** Events that make conversations; reactions in them steer the task, so each subscribes `reaction_added` too. */
const CONVERSATION_EVENTS = ['mention', 'dm', 'channel'];
/** Slack manifest agent events for catalog event names, plus the workspace grants of an org install, the Home tab and shared links. */
export function slackAppEvents(events: string[]): string[] {
  const converses = events.some(event => CONVERSATION_EVENTS.includes(event));
  return [
    ...new Set([
      ...events.flatMap(event => APP_EVENTS[event] ?? []),
      ...(converses ? ['reaction_added'] : []),
    ]),
    'team_access_granted',
    'team_access_revoked',
    'app_uninstalled',
    'tokens_revoked',
    'app_home_opened',
    'link_shared',
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
