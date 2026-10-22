/** Slack app creation from a manifest plus the OAuth install dance for that app. */
import {
  IntegrationError,
  type Access,
  type AppSpec,
  type AppTokens,
  type IntegrationApp,
  type IntegrationAuth,
  type IntegrationUserAuth,
} from '../types';

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
    /** `slackManifestExtras(...)`: the agent view. */
    extras?: { agent_view?: unknown };
  },
): Record<string, unknown> {
  const base = baseUrl(publicUrl);
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
      ...extras,
    },
    oauth_config: {
      redirect_urls: [`${base}/install/slack/callback`, `${base}/connect/slack/callback`],
      scopes: { bot: scopes, user: USER_SCOPES },
    },
    settings: {
      org_deploy_enabled: true,
      is_mcp_enabled: true,
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

/** The bot scopes a spec asks for. */
const specScopes = (spec: AppSpec) => slackAppScopes(spec.access, spec.events);

/** The manifest a spec asks for, named `name`. */
function specManifest(publicUrl: string, name: string, spec: AppSpec) {
  return slackManifest(publicUrl, {
    name,
    description: spec.description,
    scopes: specScopes(spec),
    events: slackAppEvents(spec.events),
    extras: slackManifestExtras(spec),
  });
}

interface SlackConfigToken {
  configToken: string;
  configRefreshToken: string;
  configTokenExpires: number;
  workspace: string;
  user: string;
}

/** `tooling.tokens.rotate`: config tokens expire after 12 hours. */
async function rotateConfigToken(
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
  if (
    !response.ok ||
    !value.ok ||
    !value.token ||
    !value.refresh_token ||
    !value.team_id ||
    !value.user_id
  )
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

/** `oauth.v2.access`: a code exchanged at the redirect it was issued for. */
async function oauthAccess<T>(
  code: string,
  credentials: Pick<SlackAppCredentials, 'clientId' | 'clientSecret'>,
  redirectUri: string,
  request: Fetcher,
): Promise<T & { ok?: boolean; error?: string }> {
  const response = await request('https://slack.com/api/oauth.v2.access', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });
  const value = (await response.json()) as T & { ok?: boolean; error?: string };
  if (!response.ok || !value.ok)
    throw new IntegrationError('platform-error', value.error ?? String(response.status));

  return value;
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
  const value = await oauthAccess<{
    access_token?: string;
    team?: { id?: string; name?: string } | null;
    enterprise?: { id?: string; name?: string } | null;
    is_enterprise_install?: boolean;
    authed_user?: { id?: string };
  }>(code, credentials, `${baseUrl(publicUrl)}/install/slack/callback`, request);
  const org = value.is_enterprise_install === true;
  const owner = org ? value.enterprise : value.team;
  if (!value.access_token || !owner?.id || !owner.name)
    throw new IntegrationError('platform-error');
  return {
    id: owner.id,
    name: owner.name,
    org,
    accessToken: value.access_token,
    ...(value.authed_user?.id ? { installer: value.authed_user.id } : {}),
  };
}

const connectRedirect = (publicUrl: string) => `${baseUrl(publicUrl)}/connect/slack/callback`;

/** A member's own Slack account, by user scopes only; Slack user tokens do not expire unless the app turns on token rotation. */
export const slackUserAuth: IntegrationUserAuth = {
  authorizeUrl(credentials, { publicUrl, state }) {
    const params = new URLSearchParams({
      client_id: (credentials as SlackAppCredentials).clientId,
      user_scope: USER_SCOPES.join(','),
      redirect_uri: connectRedirect(publicUrl),
      state,
    });
    return `https://slack.com/oauth/v2/authorize?${params}`;
  },
  async exchange(req, credentials, { publicUrl, fetch: request }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new IntegrationError('missing-code');
    const { authed_user: user } = await oauthAccess<{
      authed_user?: { id?: string; access_token?: string; token_type?: string };
    }>(code, credentials as SlackAppCredentials, connectRedirect(publicUrl), request);
    if (!user?.id || !user.access_token || user.token_type !== 'user')
      throw new IntegrationError('platform-error');
    // `auth.test` needs no scope and names the token's user.
    const identity = await slackApi<{ user_id?: string; user?: string }>(
      'auth.test',
      {},
      user.access_token,
      request,
    );
    if (identity.user_id !== user.id) throw new IntegrationError('platform-error', 'invalid_auth');

    return {
      id: user.id,
      ...(identity.user ? { login: identity.user } : {}),
      token: JSON.stringify({ accessToken: user.access_token }),
    };
  },
  async access(stored, _credentials, { force }) {
    if (force)
      throw new IntegrationError('platform-error', 'invalid_token', 'Slack refused the user token');

    return { accessToken: (JSON.parse(stored) as { accessToken: string }).accessToken };
  },
};

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
  createStep: (_publicUrl, input) => {
    const saved = input?.saved ?? [];
    const when = saved.length ? { field: 'token', equals: 'new' } : undefined;
    return {
      intro:
        "The Slack app is created with a configuration token and its bot installed in the token's whole workspace.",
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
  async createCallback(req, { publicUrl, spec, fetch: request, tokens }) {
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
    const { name } = spec;
    const created = await withConfigToken(tokens, id, request, token =>
      createSlackApp(token, specManifest(publicUrl, name, spec), request),
    );
    return {
      platformAppId: created.appId,
      name,
      credentials: { ...created, configTokenId: id, scopes: specScopes(spec) },
    };
  },
  manifest: (app, { publicUrl, spec }) => specManifest(publicUrl, app.name, spec),
  async update(app, credentials, { publicUrl, spec, fetch: request, saveCredentials, tokens }) {
    const current = credentials as SlackAppCredentials;
    if (!current.configTokenId || !tokens) throw new IntegrationError('no-refresh-token');
    await withConfigToken(tokens, current.configTokenId, request, token =>
      slackApi(
        'apps.manifest.update',
        {
          app_id: current.appId,
          manifest: JSON.stringify(specManifest(publicUrl, app.name, spec)),
        },
        token,
        request,
      ),
    );
    const scopes = specScopes(spec);
    if (scopes.join() !== current.scopes?.join()) await saveCredentials({ ...current, scopes });
  },
  settingsUrl: (_app, credentials) =>
    `https://api.slack.com/apps/${encodeURIComponent((credentials as SlackAppCredentials).appId)}`,
  async uninstall(installation, credentials, { fetch: request }) {
    const { clientId, clientSecret } = credentials as SlackAppCredentials;
    const token = await slackToken(installation, credentials);
    await slackApi(
      'apps.uninstall',
      { client_id: clientId, client_secret: clientSecret },
      token,
      request,
    );
  },
  installationUrl: () => 'https://slack.com/help/articles/360003125231',
  // Slack's authorize page needs the scopes on the URL; an app created before they were saved asks for the write set.
  installUrl(_app, credentials, { publicUrl, state }) {
    const current = credentials as SlackAppCredentials;
    return oauthInstallUrl(current, publicUrl, state, current.scopes ?? slackAppScopes('auto'));
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
    // The workspace address, for links to it; `auth.test` needs no scope.
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

/** The Slack MCP server's tool scopes a member's Just me connection asks for: search, reads, and sending messages as them. */
const USER_SCOPES = [
  'search:read.public',
  'search:read.private',
  'search:read.mpim',
  'search:read.im',
  'search:read.files',
  'search:read.users',
  'channels:history',
  'groups:history',
  'mpim:history',
  'im:history',
  'channels:read',
  'groups:read',
  'mpim:read',
  'im:read',
  'users:read',
  'users:read.email',
  'files:read',
  'chat:write',
];

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
];
/** Both modes can reply, react and upload files, and `dm` reads group DMs. */
export function slackAppScopes(tools: Access | string[] = 'auto', events: string[] = []): string[] {
  return [
    ...SCOPES,
    ...(events.includes('dm') ? ['mpim:history'] : []),
    'chat:write',
    'files:write',
    'im:write',
    'assistant:write',
    ...((Array.isArray(tools) ? tools.includes('write') : tools === 'auto')
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
/** Slack manifest agent events for catalog event names, plus the workspace grants of an org install and the Home tab. */
export function slackAppEvents(events: string[]): string[] {
  const converses = events.some(event => CONVERSATION_EVENTS.includes(event));
  return [
    ...new Set([
      ...events.flatMap(event => APP_EVENTS[event] ?? []),
      ...(converses ? ['reaction_added', 'member_joined_channel', 'member_left_channel'] : []),
    ]),
    'team_access_granted',
    'team_access_revoked',
    'app_uninstalled',
    'tokens_revoked',
    'app_home_opened',
  ];
}

/** The agent view beyond scopes and events. */
export function slackManifestExtras(spec: Pick<AppSpec, 'name' | 'description'>): {
  agent_view: { agent_description: string };
} {
  return {
    agent_view: { agent_description: spec.description ?? `${spec.name} in your workspace.` },
  };
}

/** How people reach the agent in Slack, from the Slack events it listens to; none when nothing wakes it. */
export function slackWays(
  name: string,
  events: string[],
  direct = 'send it a direct message',
): string | undefined {
  const all = [
    events.includes('mention') && `mention @${name} in a channel`,
    events.includes('dm') && direct,
    events.includes('channel') && 'write in a channel it is in',
  ].filter((way): way is string => Boolean(way));
  if (!all.length) return undefined;
  const text = all.length > 1 ? `${all.slice(0, -1).join(', ')}, or ${all.at(-1)}` : all[0]!;

  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

export const slackToken: IntegrationAuth['token'] = async installation => {
  if (!installation.token)
    throw new Error(`Slack installation ${installation.id} has no bot token`);
  return installation.token;
};
