/** Teams apps: the user's own single-tenant Azure Bot, bound to its directory by an Entra sign-in from that directory. */
import { escapeHtml, htmlResponse } from '../../utils/html';
import { credentialsPage, idClaims, postedFields, tokenGrant } from '../setup';
import type { IntegrationApp } from '../types';

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
  createPage({ publicUrl, state }) {
    return credentialsPage(publicUrl, 'teams', state, {
      title: 'Connect Microsoft Teams',
      steps: [
        'In the Azure portal, create an Azure Bot of type Single Tenant with a new app registration.',
        `Set its messaging endpoint to ${base(publicUrl)}/hooks/teams?app= followed by the Microsoft App ID, and turn on the Microsoft Teams channel.`,
        `In the app registration, add the web redirect URI ${base(publicUrl)}/install/teams/callback and create a client secret.`,
        'In the Teams Developer Portal, create a Teams app for the bot and install it in your organization.',
        'Fill in the Microsoft App ID, the client secret, and the directory (tenant) ID.',
      ],
      fields: [
        ['appId', 'Microsoft App ID'],
        ['appPassword', 'Client secret'],
        ['tenantId', 'Directory (tenant) ID'],
      ],
    });
  },
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
    if (!code) throw new Error('Microsoft sent no authorization code');
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
    if (claims.tid !== tenantId)
      throw new Error('That account belongs to another Microsoft directory than the bot');
    const domain = String(claims.preferred_username ?? '').split('@')[1] || tenantId;
    return {
      platformInstallId: tenantId,
      account: { login: domain },
      response: htmlResponse(
        `<title>Connected</title><p>Connected Microsoft Teams for ${escapeHtml(domain)}.</p>`,
      ),
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
