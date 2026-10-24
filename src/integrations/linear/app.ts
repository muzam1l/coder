/** Linear apps: the user's own OAuth application, workspaces bound by installing it as an app actor. */
import { randomUUID } from 'node:crypto';

import { freshToken, postedFields, tokenGrant, type StoredToken } from '../setup';
import {
  IntegrationError,
  type PlatformInstallation,
  type IntegrationApp,
  type IntegrationUserAuth,
} from '../types';

export interface LinearAppCredentials {
  clientId: string;
  clientSecret: string;
  /** Signs every webhook Linear sends this app. */
  webhookSecret: string;
}

const AUTHORIZE = 'https://linear.app/oauth/authorize';
const TOKEN = 'https://api.linear.app/oauth/token';
const REVOKE = 'https://api.linear.app/oauth/revoke';
const GRAPHQL = 'https://api.linear.app/graphql';
const FIELDS = ['clientId', 'clientSecret', 'webhookSecret'] as const;
/** The webhook's resource types, as the form link names them and the application settings label them. */
const RESOURCE_TYPES = {
  Issue: 'Issues',
  Comment: 'Comments',
};

const base = (publicUrl: string) => publicUrl.replace(/\/$/, '');

async function linearQuery<T>(token: string, query: string, request: typeof fetch): Promise<T> {
  const response = await request(GRAPHQL, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  const body = (await response.json().catch(() => ({}))) as { data?: T };
  if (!response.ok || !body.data) throw new Error(`Linear refused the query: ${response.status}`);
  return body.data;
}

function authorizeUrl(
  credentials: unknown,
  redirect: string,
  state: string,
  app: boolean,
  access = false,
): string {
  const params = new URLSearchParams({
    client_id: (credentials as LinearAppCredentials).clientId,
    redirect_uri: redirect,
    response_type: 'code',
    // The app can be picked in @ mentions, never delegated an issue.
    scope: app ? 'read,write,app:mentionable' : access ? 'read,write' : 'read',
    state,
    ...(app ? { actor: 'app' } : {}),
  });
  return `${AUTHORIZE}?${params}`;
}

function exchange(req: Request, credentials: unknown, redirect: string, request: typeof fetch) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) throw new IntegrationError('missing-code');
  const { clientId, clientSecret } = credentials as LinearAppCredentials;
  return tokenGrant(
    TOKEN,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirect,
      client_id: clientId,
      client_secret: clientSecret,
    },
    request,
  );
}

/** Linear's prefilled OAuth application form: name, callback URLs and the webhook. */
function creationLink(publicUrl: string, key: string, name?: string, isPublic?: boolean): string {
  const params = new URLSearchParams(name ? { 'oauth.client_name': name } : {});
  // Public: installable by other Linear workspaces.
  if (isPublic) params.set('distribution', 'public');
  params.set('developer.name', base(publicUrl).replace(/^https?:\/\//, ''));
  params.set('oauth.client_uri', base(publicUrl));
  params.append('oauth.redirect_uris', `${base(publicUrl)}/install/linear/callback`);
  params.append('oauth.redirect_uris', `${base(publicUrl)}/connect/linear/callback`);
  params.set('webhook.enabled', 'true');
  params.set('webhook.url', `${base(publicUrl)}/hooks/linear?app=${key}`);
  for (const type of Object.keys(RESOURCE_TYPES)) params.append('webhook.resourceTypes', type);
  return `https://linear.app/settings/api/applications/new?${params}`;
}

export const linearApp: IntegrationApp = {
  shareable: true,
  createStep: (publicUrl, { name, public: isPublic } = {}, key = randomUUID()) => ({
    intro: 'Linear runs the agent as an app of your own OAuth application.',
    link: creationLink(publicUrl, key, name, isPublic),
    steps: [
      { text: 'Open the link signed in to Linear, check the form and click **Create**.' },
      {
        text: 'Copy the client ID, the client secret and the webhook signing secret into the fields below.',
      },
    ],
    notes: [
      `The link fills in the name, the callback URLs and the webhook${isPublic ? ', and makes the app public so other Linear workspaces can install it' : ''}.`,
      ...(isPublic
        ? []
        : [
            'To install the app in other Linear workspaces, make it public in its Linear settings.',
          ]),
    ],
    hidden: { key },
    fields: [
      {
        name: 'clientId',
        label: 'Client ID',
        placeholder: '9f3c2a7d1e8b4c6a0d5e7f1a2b3c4d5e',
        required: true,
      },
      {
        name: 'clientSecret',
        label: 'Client secret',
        placeholder: '4b1e9c7a2d0f8e3c5a6b9d1f0e2c4a7b',
        required: true,
      },
      {
        name: 'webhookSecret',
        label: 'Webhook signing secret',
        hint: 'shown with the webhook settings',
        placeholder: 'lin_wh_…',
        required: true,
      },
    ],
    submit: 'Create Linear app',
  }),
  // The webhook URL in the prefilled form names the app by `key`, chosen before Linear knows the client ID.
  // Linear's app pages use its own app id, not the client ID; the API page lists them in the current workspace.
  settingsUrl: () => 'https://linear.app/settings/api',
  // Linear has no API to read or change an OAuth application.
  values: (app, { publicUrl, spec }) => ({
    url: 'https://linear.app/settings/api',
    label: 'Open application',
    lines: [
      { text: 'Application name', copy: spec.name },
      { text: 'Callback URL', copy: `${base(publicUrl)}/install/linear/callback` },
      { text: 'Callback URL', copy: `${base(publicUrl)}/connect/linear/callback` },
      {
        text: 'Webhook URL',
        copy: `${base(publicUrl)}/hooks/linear?app=${app.id.slice(app.id.indexOf(':') + 1)}`,
      },
      { text: 'Webhook events', copy: Object.values(RESOURCE_TYPES).join(', ') },
      {
        text: 'Reinstall the app in each workspace after saving, so people can pick it in @ mentions',
      },
    ],
  }),
  async createCallback(req, { spec }) {
    const { key, ...credentials }: LinearAppCredentials & { key: string } = await postedFields(
      req,
      [...FIELDS, 'key'],
    );
    if (!/^[0-9a-f-]{36}$/.test(key)) throw new IntegrationError('invalid-field', 'key');
    return { platformAppId: key, name: spec.name, credentials };
  },
  accountUrl: ({ login }) => `https://linear.app/${encodeURIComponent(login)}`,
  // Revoking the refresh token ends the whole grant (RFC 7009).
  async uninstall(installation, _credentials, { fetch: request }) {
    if (!installation.token) throw new Error('The installation has no token');
    const { accessToken, refreshToken }: StoredToken = JSON.parse(installation.token);
    const response = await request(REVOKE, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(
        refreshToken
          ? { token: refreshToken, token_type_hint: 'refresh_token' }
          : { token: accessToken, token_type_hint: 'access_token' },
      ),
    });
    if (!response.ok) throw new Error(`Linear answered ${response.status} to the revoke`);
  },
  installationUrl: () => 'https://linear.app/settings/applications',
  installUrl(_app, credentials, { publicUrl, state }) {
    return authorizeUrl(credentials, `${base(publicUrl)}/install/linear/callback`, state, true);
  },
  // The workspace is the one the new app token belongs to, as Linear itself answers.
  async installCallback(req, { credentials, publicUrl, fetch: request }) {
    const { idToken: _idToken, ...token } = await exchange(
      req,
      credentials,
      `${base(publicUrl)}/install/linear/callback`,
      request,
    );
    const { organization, viewer } = await linearQuery<{
      organization: { id: string; name: string; urlKey: string };
      viewer: { id: string };
    }>(token.accessToken, 'query { organization { id name urlKey } viewer { id } }', request);
    return {
      platformInstallId: organization.id,
      account: { login: organization.urlKey },
      token: JSON.stringify(token),
      self: viewer.id,
    };
  },
};

/** Linking proves a Linear user by signing in to Linear. */
export const linearUserAuth: IntegrationUserAuth = {
  authorizeUrl: (credentials, { publicUrl, state, access }) =>
    authorizeUrl(credentials, `${base(publicUrl)}/connect/linear/callback`, state, false, !!access),
  async exchange(req, credentials, { publicUrl, fetch: request, access }) {
    const { idToken: _idToken, ...token } = await exchange(
      req,
      credentials,
      `${base(publicUrl)}/connect/linear/callback`,
      request,
    );
    const { viewer } = await linearQuery<{ viewer: { id: string; displayName: string } }>(
      token.accessToken,
      'query { viewer { id displayName } }',
      request,
    );
    return {
      id: viewer.id,
      login: viewer.displayName,
      ...(access ? { token: JSON.stringify(token) } : {}),
    };
  },
  async access(stored, credentials, { fetch: request, now, force }) {
    const { clientId, clientSecret } = credentials as LinearAppCredentials;
    let refreshed: string | undefined;
    const accessToken = await freshToken(
      stored,
      refreshToken =>
        tokenGrant(
          TOKEN,
          {
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: clientId,
            client_secret: clientSecret,
          },
          request,
          now,
        ),
      async token => {
        refreshed = token;
      },
      now,
      force,
    );

    return { accessToken, ...(refreshed ? { refreshed } : {}) };
  },
};

/** The workspace's app token; Linear rotates the refresh token, so each refresh is saved. */
export function linearToken(
  installation: PlatformInstallation,
  credentials: unknown,
  save?: (token: string) => Promise<string | void>,
  request?: typeof fetch,
): Promise<string> {
  const { clientId, clientSecret } = credentials as LinearAppCredentials;
  return freshToken(
    installation.token,
    refreshToken =>
      tokenGrant(
        TOKEN,
        {
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        },
        request,
      ),
    save,
  );
}
