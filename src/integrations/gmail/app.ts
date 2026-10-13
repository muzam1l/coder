/** Gmail apps: the user's own Google OAuth client and Pub/Sub push subscription, mailboxes bound by Google sign-in. */
import { randomUUID } from 'node:crypto';

import { freshToken, idClaims, postedFields, tokenGrant } from '../setup';
import {
  type CreateStep,
  IntegrationError,
  type Installation,
  type IntegrationApp,
  type IntegrationUserAuth,
} from '../types';

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
  if (!code) throw new IntegrationError('missing-code');
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

/** The form for a Google OAuth client and Pub/Sub push subscription of your own. */
function clientStep(publicUrl: string): CreateStep {
  return {
    intro:
      'Gmail reaches the agent through your own Google OAuth client and a Pub/Sub push subscription.',
    link: 'https://console.cloud.google.com/apis/credentials',
    steps: [
      {
        text: 'In a Google Cloud project you own, enable the Gmail API and the Pub/Sub API under **APIs & Services › Library**.',
        link: 'https://console.cloud.google.com/apis/library/gmail.googleapis.com',
      },
      {
        text: 'Under **Google Auth platform › Clients**, create a client of **Application type › Web application** with these two **Authorized redirect URIs**.',
        link: 'https://console.developers.google.com/auth/clients',
        copy: [
          `${base(publicUrl)}/install/gmail/callback`,
          `${base(publicUrl)}/connect/gmail/callback`,
        ],
      },
      {
        text: 'Create a Pub/Sub topic and give this account the **Pub/Sub Publisher** role on it.',
        link: 'https://console.cloud.google.com/cloudpubsub/topic/create',
        copy: ['gmail-api-push@system.gserviceaccount.com'],
      },
      {
        text: 'Under **Pub/Sub › Subscriptions**, create a subscription on the topic with **Delivery type › Push** and **Enable authentication** on, using a service account of yours. Its **Endpoint URL** is this address followed by the OAuth client ID.',
        link: 'https://console.cloud.google.com/cloudpubsub/subscription',
        copy: [`${base(publicUrl)}/hooks/gmail?app=`],
      },
    ],
    fields: [
      {
        name: 'clientId',
        label: 'OAuth client ID',
        placeholder: '1234567890-abc123.apps.googleusercontent.com',
        required: true,
      },
      {
        name: 'clientSecret',
        label: 'OAuth client secret',
        placeholder: 'GOCSPX-…',
        required: true,
      },
      {
        name: 'topic',
        label: 'Topic',
        hint: 'its full name',
        placeholder: 'projects/my-project/topics/gmail',
        required: true,
      },
      {
        name: 'subscription',
        label: 'Subscription',
        hint: 'its full name',
        placeholder: 'projects/my-project/subscriptions/coder',
        required: true,
      },
      {
        name: 'serviceAccount',
        label: 'Push service account',
        hint: 'the account the subscription authenticates as',
        placeholder: 'gmail-push@my-project.iam.gserviceaccount.com',
        required: true,
      },
      {
        name: 'label',
        label: 'Label ID',
        hint: 'mail with this label reaches the agent',
        placeholder: 'INBOX',
        required: true,
      },
    ],
    submit: 'Create Gmail app',
  };
}

export const gmailApp: IntegrationApp = {
  builtin: 'shared',
  createStep: (publicUrl, { shared } = {}) =>
    shared
      ? {
          intro:
            "This server's shared Google client connects the mailbox when you sign in with Google.",
          link: 'https://accounts.google.com',
          steps: [],
          fields: [],
          submit: 'Connect Gmail',
        }
      : clientStep(publicUrl),
  // On the shared client the agent's app gets its own id; pushes still arrive under the client's.
  async createCallback(req, { publicUrl, state, definition, shared }) {
    const name = definition.name ?? state.agent;
    if (shared)
      return {
        platformAppId: `${(shared as GmailAppCredentials).clientId}/${randomUUID()}`,
        name,
        shared: true,
      };
    const fields = await postedFields(req, FIELDS);
    if (!/^projects\/[^/\s]+\/topics\/[^/\s]+$/.test(fields.topic))
      throw new IntegrationError('invalid-field', 'topic');
    if (!/^projects\/[^/\s]+\/subscriptions\/[^/\s]+$/.test(fields.subscription))
      throw new IntegrationError('invalid-field', 'subscription');
    const credentials: GmailAppCredentials = {
      ...fields,
      audience: gmailHook(publicUrl, fields.clientId),
    };
    return { platformAppId: fields.clientId, name, credentials };
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
    if (!token.refreshToken) throw new IntegrationError('no-refresh-token');
    return {
      platformInstallId: email,
      account: { login: email },
      token: JSON.stringify(token),
    };
  },
};

/** Linking proves a sender owns their address by signing in with Google. */
export const gmailUserAuth: IntegrationUserAuth = {
  authorizeUrl: (credentials, { publicUrl, state, access }) =>
    authorizeUrl(
      credentials,
      `${base(publicUrl)}/connect/gmail/callback`,
      state,
      access ? `openid email ${MAIL_SCOPE}` : 'openid email',
    ),
  async exchange(req, credentials, { publicUrl, fetch: request, access }) {
    const { email, token } = await signIn(
      req,
      credentials,
      `${base(publicUrl)}/connect/gmail/callback`,
      request,
    );
    return { id: email, login: email, ...(access ? { token: JSON.stringify(token) } : {}) };
  },
  async access(stored, credentials, { fetch: request, now }) {
    const { clientId, clientSecret } = credentials as GmailAppCredentials;
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
    );

    return { accessToken, ...(refreshed ? { refreshed } : {}) };
  },
};

/** The mailbox's access token, refreshed with its stored refresh token. */
export function gmailToken(
  installation: Installation,
  credentials: unknown,
  save?: (token: string) => Promise<string | void>,
  request?: typeof fetch,
): Promise<string> {
  const { clientId, clientSecret } = credentials as GmailAppCredentials;
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
