/** Teams through Chat SDK: the Teams SDK verifies Bot Framework tokens for the app, Coder mints the bot's own token. */
import { createTeamsAdapter } from '@chat-adapter/teams';
import { type Adapter, ConsoleLogger } from 'chat';

import type { AdapterContext } from '../types';
import { BOT_SCOPE } from './app';

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
    ...(ctx.credentials ? {} : { webhookVerifier: () => false }),
    logger: new ConsoleLogger('error'),
  });
}
