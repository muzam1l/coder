/** Linear apps: the user's own OAuth application, workspaces bound by installing it as an app actor. */
import { escapeHtml, htmlResponse } from '../../utils/html';
import { credentialsPage, freshToken, postedFields, tokenGrant } from '../setup';
import type { Installation } from '../../agent/types';
import type { IntegrationApp, IntegrationUserAuth } from '../types';

export interface LinearAppCredentials {
  clientId: string;
  clientSecret: string;
  /** Signs every webhook Linear sends this app. */
  webhookSecret: string;
}

const AUTHORIZE = 'https://linear.app/oauth/authorize';
const TOKEN = 'https://api.linear.app/oauth/token';
const GRAPHQL = 'https://api.linear.app/graphql';
const FIELDS = ['clientId', 'clientSecret', 'webhookSecret'] as const;

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

function authorizeUrl(credentials: unknown, redirect: string, state: string, app: boolean): string {
  const params = new URLSearchParams({
    client_id: (credentials as LinearAppCredentials).clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope: app ? 'read,write,app:mentionable,app:assignable' : 'read',
    state,
    ...(app ? { actor: 'app' } : {}),
  });
  return `${AUTHORIZE}?${params}`;
}

function exchange(req: Request, credentials: unknown, redirect: string, request: typeof fetch) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) throw new Error('Linear sent no authorization code');
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

export const linearApp: IntegrationApp = {
  createPage({ publicUrl, state }) {
    return credentialsPage(publicUrl, 'linear', state, {
      title: 'Connect Linear',
      steps: [
        'In Linear, open Settings, then API, and create a new OAuth application.',
        `Add the callback URLs ${base(publicUrl)}/install/linear/callback and ${base(publicUrl)}/connect/linear/callback.`,
        `Turn on webhooks with the URL ${base(publicUrl)}/hooks/linear?app= followed by the client ID, and select Agent session events.`,
        'Fill in the client ID, the client secret, and the webhook signing secret.',
      ],
      fields: [
        ['clientId', 'Client ID'],
        ['clientSecret', 'Client secret'],
        ['webhookSecret', 'Webhook signing secret'],
      ],
    });
  },
  async createCallback(req, { state, definition }) {
    const credentials: LinearAppCredentials = await postedFields(req, FIELDS);
    return {
      platformAppId: credentials.clientId,
      name: definition.name ?? state.agent,
      credentials,
    };
  },
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
    const { organization } = await linearQuery<{
      organization: { id: string; name: string; urlKey: string };
    }>(token.accessToken, 'query { organization { id name urlKey } }', request);
    return {
      platformInstallId: organization.id,
      account: { login: organization.urlKey },
      token: JSON.stringify(token),
      response: htmlResponse(
        `<title>Connected</title><p>Connected the ${escapeHtml(organization.name)} Linear workspace.</p>`,
      ),
    };
  },
};

/** Linking proves a Linear user by signing in to Linear. */
export const linearUserAuth: IntegrationUserAuth = {
  authorizeUrl: (credentials, { publicUrl, state }) =>
    authorizeUrl(credentials, `${base(publicUrl)}/connect/linear/callback`, state, false),
  async exchange(req, credentials, { publicUrl, fetch: request }) {
    const token = await exchange(
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
    return { id: viewer.id, login: viewer.displayName };
  },
  access: async token => ({ accessToken: token }),
};

/** The workspace's app token; Linear rotates the refresh token, so each refresh is saved. */
export function linearToken(
  installation: Installation,
  credentials: unknown,
  save?: (token: string) => Promise<void>,
): Promise<string> {
  const { clientId, clientSecret } = credentials as LinearAppCredentials;
  return freshToken(
    installation.token,
    refreshToken =>
      tokenGrant(TOKEN, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    save,
  );
}
