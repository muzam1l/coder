/** Teams through Chat SDK: Coder verifies Bot Framework tokens as the Teams SDK does, on keys the server holds, and mints the bot's own token. */
import { createTeamsAdapter } from '@chat-adapter/teams';
import { type Adapter, ConsoleLogger } from 'chat';
import { decodeJwt, jwtVerify, type JWTVerifyGetKey } from 'jose';

import type { AdapterContext } from '../types';
import { BOT_SCOPE } from './app';

const LOGIN = 'https://login.microsoftonline.com';
const ENTRA_V1 = 'https://sts.windows.net';
const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
const BOT_FRAMEWORK_KEYS = 'https://login.botframework.com/v1/.well-known/keys';

const normalized = (url: string) => url.replace(/\/$/, '').toLowerCase();

/** The Teams SDK's inbound check: a Bot Framework token for this bot and the activity's connector, or an Entra token from the directory it names. */
export async function verifyTeamsActivity(
  appId: string,
  keys: (url: string) => JWTVerifyGetKey,
  authorization: string | null,
  body: string,
): Promise<boolean> {
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : authorization;
  if (!token) return false;

  const options = {
    audience: [appId, `api://botid-${appId}`, `api://${appId}`],
    algorithms: ['RS256'],
    clockTolerance: 300,
  };
  const { iss, tid } = decodeJwt(token);
  if (typeof iss === 'string' && (iss.startsWith(LOGIN) || iss.startsWith(`${ENTRA_V1}/`))) {
    if (typeof tid !== 'string' || !/^[\w.-]+$/.test(tid)) return false;
    const { payload } = await jwtVerify(
      token,
      keys(`${LOGIN}/${tid}/discovery/v2.0/keys`),
      options,
    );

    return [LOGIN, ENTRA_V1].some(endpoint => payload.iss?.startsWith(`${endpoint}/${tid}/`));
  }

  const { payload } = await jwtVerify(token, keys(BOT_FRAMEWORK_KEYS), {
    ...options,
    issuer: BOT_FRAMEWORK_ISSUER,
  });
  const serviceUrl = (JSON.parse(body) as { serviceUrl?: unknown }).serviceUrl;

  return (
    !serviceUrl ||
    (typeof serviceUrl === 'string' &&
      typeof payload.serviceurl === 'string' &&
      normalized(payload.serviceurl) === normalized(serviceUrl))
  );
}

export function teamsAdapter(ctx: AdapterContext): Adapter {
  const tenant = ctx.installationId;
  if (!tenant) throw new Error('A Teams adapter requires its bound directory');
  if (process.env.CLOUD && process.env.CLOUD !== 'Public')
    throw new Error(
      'The Teams SDK cannot override CLOUD; Coder requires the public Bot Framework cloud',
    );
  return createTeamsAdapter({
    appId: ctx.appId,
    appType: 'SingleTenant',
    appTenantId: tenant,
    // Empty, not absent: TEAMS_API_URL never pins replies elsewhere, and each reply goes to its conversation's verified service URL.
    apiUrl: '',
    userName: ctx.name,
    token: async scope => {
      if (![scope].flat().includes(BOT_SCOPE))
        throw new Error('Coder mints only Bot Framework tokens for Teams');
      if (!tenant) throw new Error('The activity names no Teams directory');
      return ctx.token(tenant);
    },
    // Without the app's credentials (a task's runner, which only posts) no activity is ever accepted.
    webhookVerifier:
      ctx.credentials && ctx.signingKeys
        ? (request, body) =>
            verifyTeamsActivity(
              ctx.appId,
              ctx.signingKeys!,
              request.headers.get('authorization'),
              body,
            )
        : () => false,
    logger: new ConsoleLogger('error'),
  });
}
