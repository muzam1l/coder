/** Teams apps: the user's own single-tenant Azure Bot, bound to its directory by an Entra sign-in from that directory. */
import { idClaims, postedFields, tokenGrant } from '../setup';
import { IntegrationError, type IntegrationApp } from '../types';

export interface TeamsAppCredentials {
  /** The bot's Microsoft App ID, its Entra app registration's client ID. */
  appId: string;
  appPassword: string;
  /** The directory the single-tenant bot belongs to. */
  tenantId: string;
}

const LOGIN = 'https://login.microsoftonline.com';
/** The only scope Coder mints for a bot: posting through the Bot Framework. */
export const BOT_SCOPE = 'https://api.botframework.com/.default';
const FIELDS = ['appId', 'appPassword', 'tenantId'] as const;

const base = (publicUrl: string) => publicUrl.replace(/\/$/, '');

export const teamsApp: IntegrationApp = {
  builtin: 'own',
  createStep: publicUrl => ({
    intro: 'Teams runs the agent as your own single-tenant Azure Bot.',
    link: 'https://portal.azure.com',
    steps: [
      {
        text: 'In the Azure portal, go to **Create a resource › Azure Bot › Create** and make an Azure Bot of type **Single Tenant** with a new app registration.',
        link: 'https://portal.azure.com',
      },
      {
        text: 'Set **Azure Bot › Settings › Configuration › Messaging endpoint** to this address followed by the Microsoft App ID, then turn on **Azure Bot › Settings › Channels › Microsoft Teams**.',
        copy: [`${base(publicUrl)}/hooks/teams?app=`],
      },
      {
        text: 'In the app registration, add this redirect URI under **Authentication › Redirect URI configuration › Add Redirect URI › Web**, then create a client secret under **Certificates & secrets › Client secrets › New client secret**.',
        link: 'https://entra.microsoft.com',
        copy: [`${base(publicUrl)}/install/teams/callback`],
      },
      {
        text: 'In the Teams Developer Portal, go to **Apps › New app** to create a Teams app for the bot, then publish it to your organization under **Publish › Publish to org**.',
        link: 'https://dev.teams.microsoft.com',
      },
    ],
    fields: [
      {
        name: 'appId',
        label: 'Microsoft App ID',
        placeholder: '00000000-0000-0000-0000-000000000000',
        required: true,
      },
      {
        name: 'appPassword',
        label: 'Client secret',
        hint: "the secret's value, not its ID",
        placeholder: 'abc8Q~…',
        required: true,
      },
      {
        name: 'tenantId',
        label: 'Directory (tenant) ID',
        hint: "on the app registration's overview",
        placeholder: '00000000-0000-0000-0000-000000000000',
        required: true,
      },
    ],
    submit: 'Create Teams app',
  }),
  async createCallback(req, { state, definition }) {
    const credentials: TeamsAppCredentials = await postedFields(req, FIELDS);
    return { platformAppId: credentials.appId, name: definition.name ?? state.agent, credentials };
  },
  installUrl(_app, credentials, { publicUrl, state }) {
    const { appId, tenantId } = credentials as TeamsAppCredentials;
    const params = new URLSearchParams({
      client_id: appId,
      response_type: 'code',
      redirect_uri: `${base(publicUrl)}/install/teams/callback`,
      scope: 'openid profile',
      state,
    });
    return `${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/authorize?${params}`;
  },
  // The bot serves one directory; a sign-in from that directory binds it.
  async installCallback(req, { credentials, publicUrl, fetch: request }) {
    const code = new URL(req.url).searchParams.get('code');
    if (!code) throw new IntegrationError('missing-code');
    const { appId, appPassword, tenantId } = credentials as TeamsAppCredentials;
    const { idToken } = await tokenGrant(
      `${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`,
      {
        grant_type: 'authorization_code',
        code,
        client_id: appId,
        client_secret: appPassword,
        redirect_uri: `${base(publicUrl)}/install/teams/callback`,
        scope: 'openid profile',
      },
      request,
    );
    const claims = idClaims(idToken, appId);
    if (claims.tid !== tenantId) throw new IntegrationError('wrong-account');
    const domain = String(claims.preferred_username ?? '').split('@')[1] || tenantId;
    return {
      platformInstallId: tenantId,
      account: { login: domain },
    };
  },
};

/** A Bot Framework token for the bot's own directory, minted with its client secret. */
export async function teamsToken(credentials: unknown): Promise<string> {
  const { appId, appPassword, tenantId } = credentials as TeamsAppCredentials;
  const token = await tokenGrant(`${LOGIN}/${encodeURIComponent(tenantId)}/oauth2/v2.0/token`, {
    grant_type: 'client_credentials',
    client_id: appId,
    client_secret: appPassword,
    scope: BOT_SCOPE,
  });
  return token.accessToken;
}
