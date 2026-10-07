/** Gmail apps: the user's own Google OAuth client and Pub/Sub push subscription, mailboxes bound by Google sign-in. */
import { escapeHtml, htmlResponse } from '../../utils/html';
import { credentialsPage, freshToken, idClaims, postedFields, tokenGrant } from '../setup';
import type { Installation } from '../../agent/types';
import type { IntegrationApp, IntegrationUserAuth } from '../types';

export interface GmailAppCredentials {
  clientId: string;
  clientSecret: string;
  /** `projects/<project>/topics/<topic>`, where Gmail publishes mailbox changes. */
  topic: string;
  /** `projects/<project>/subscriptions/<name>`, which pushes them to Coder. */
  subscription: string;
  /** The service account the push subscription authenticates as. */
  serviceAccount: string;
  /** The push endpoint, which its tokens name as their audience. */
  audience: string;
  /** The Gmail label whose mail reaches the agent. */
  label: string;
}

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const MAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const FIELDS = [
  'clientId',
  'clientSecret',
  'topic',
  'subscription',
  'serviceAccount',
  'label',
] as const;

const base = (publicUrl: string) => publicUrl.replace(/\/$/, '');

/** The Pub/Sub push endpoint for one app. */
export const gmailHook = (publicUrl: string, clientId: string) =>
  `${base(publicUrl)}/hooks/gmail?app=${encodeURIComponent(clientId)}`;

function authorizeUrl(
  credentials: unknown,
  redirect: string,
  state: string,
  scope: string,
): string {
  const params = new URLSearchParams({
    client_id: (credentials as GmailAppCredentials).clientId,
    redirect_uri: redirect,
    response_type: 'code',
    scope,
    state,
  });
  if (scope.includes(MAIL_SCOPE)) {
    params.set('access_type', 'offline');
    params.set('prompt', 'consent');
  }
  return `${AUTHORIZE}?${params}`;
}

/** The verified Google account a sign-in callback returns, with its tokens. */
async function signIn(req: Request, credentials: unknown, redirect: string, request: typeof fetch) {
  const code = new URL(req.url).searchParams.get('code');
  if (!code) throw new Error('Google sent no authorization code');
  const { clientId, clientSecret } = credentials as GmailAppCredentials;
  const { idToken, ...token } = await tokenGrant(
    TOKEN,
    {
      grant_type: 'authorization_code',
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirect,
    },
    request,
  );
  const claims = idClaims(idToken, clientId);
  if (typeof claims.email !== 'string' || claims.email_verified !== true)
    throw new Error('Google returned no verified email address');
  return { email: claims.email.toLowerCase(), token };
}

export const gmailApp: IntegrationApp = {
  createPage({ publicUrl, state }) {
    return credentialsPage(publicUrl, 'gmail', state, {
      title: 'Connect Gmail',
      steps: [
        'In a Google Cloud project you own, enable the Gmail API and the Pub/Sub API.',
        `Create an OAuth client of type Web application with the redirect URIs ${base(publicUrl)}/install/gmail/callback and ${base(publicUrl)}/connect/gmail/callback.`,
        'Create a Pub/Sub topic and give gmail-api-push@system.gserviceaccount.com the Pub/Sub Publisher role on it.',
        `Add a push subscription to the topic with authentication on, a service account of yours, and the endpoint ${base(publicUrl)}/hooks/gmail?app= followed by the OAuth client ID.`,
        'Fill in the client ID and secret, the full topic and subscription names, the service account email, and the label to watch, such as INBOX.',
      ],
      fields: [
        ['clientId', 'OAuth client ID'],
        ['clientSecret', 'OAuth client secret'],
        ['topic', 'Topic, projects/<project>/topics/<name>'],
        ['subscription', 'Subscription, projects/<project>/subscriptions/<name>'],
        ['serviceAccount', 'Push service account email'],
        ['label', 'Label ID'],
      ],
    });
  },
  async createCallback(req, { publicUrl, state, definition }) {
    const fields = await postedFields(req, FIELDS);
    if (!/^projects\/[^/\s]+\/topics\/[^/\s]+$/.test(fields.topic))
      throw new Error('The topic must be projects/<project>/topics/<name>');
    if (!/^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/.test(fields.subscription))
      throw new Error('The subscription must be projects/<project>/subscriptions/<name>');
    const credentials: GmailAppCredentials = {
      ...fields,
      audience: gmailHook(publicUrl, fields.clientId),
    };
    return { platformAppId: fields.clientId, name: definition.name ?? state.agent, credentials };
  },
  installUrl(_app, credentials, { publicUrl, state }) {
    return authorizeUrl(
      credentials,
      `${base(publicUrl)}/install/gmail/callback`,
      state,
      `openid email ${MAIL_SCOPE}`,
    );
  },
  // The mailbox is the account that signed in, as Google's token endpoint names it.
  async installCallback(req, { credentials, publicUrl, fetch: request }) {
    const { email, token } = await signIn(
      req,
      credentials,
      `${base(publicUrl)}/install/gmail/callback`,
      request,
    );
    if (!token.refreshToken)
      throw new Error(
        "Google sent no refresh token; remove the app's access from the Google account and connect again",
      );
    return {
      platformInstallId: email,
      account: { login: email },
      token: JSON.stringify(token),
      response: htmlResponse(`<title>Connected</title><p>Connected ${escapeHtml(email)}.</p>`),
    };
  },
};

/** Linking proves a sender owns their address by signing in with Google. */
export const gmailUserAuth: IntegrationUserAuth = {
  authorizeUrl: (credentials, { publicUrl, state }) =>
    authorizeUrl(credentials, `${base(publicUrl)}/connect/gmail/callback`, state, 'openid email'),
  async exchange(req, credentials, { publicUrl, fetch: request }) {
    const { email } = await signIn(
      req,
      credentials,
      `${base(publicUrl)}/connect/gmail/callback`,
      request,
    );
    return { id: email, login: email };
  },
  access: async token => ({ accessToken: token }),
};

/** The mailbox's access token, refreshed with its stored refresh token. */
export function gmailToken(
  installation: Installation,
  credentials: unknown,
  save?: (token: string) => Promise<void>,
): Promise<string> {
  const { clientId, clientSecret } = credentials as GmailAppCredentials;
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
