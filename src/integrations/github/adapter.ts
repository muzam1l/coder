/** GitHub comments through Chat SDK: the app's webhook secret verifies, Coder mints the installation token. */
import { createGitHubAdapter } from '@chat-adapter/github';
import { type Adapter, ConsoleLogger } from 'chat';

import type { AdapterContext } from '../types';
import type { GithubAppCredentials } from './app';
import { verifyGithubWebhook } from '.';
import { GITHUB_PRESETS } from './tools';

export function githubAdapter(ctx: AdapterContext): Adapter {
  const webhookSecret = (ctx.credentials as GithubAppCredentials | undefined)?.webhookSecret;
  const installationId = ctx.installationId;
  // One mint per request: the adapter asks before every API call.
  let minted: Promise<string> | undefined;
  return createGitHubAdapter({
    userName: ctx.name,
    // Set, so no GITHUB_* variable redirects the token or names a member as the app; no user has id 0.
    apiUrl: 'https://api.github.com',
    botUserId: 0,
    installationToken: () =>
      installationId
        ? (minted ??= ctx.token(installationId, { tools: GITHUB_PRESETS.comment }))
        : Promise.reject(new Error('The webhook names no GitHub installation')),
    // Without the app's secret (a task's runner, which only posts) no webhook is ever accepted.
    webhookVerifier: (req, body) =>
      verifyGithubWebhook(body, req.headers.get('x-hub-signature-256'), webhookSecret),
    logger: new ConsoleLogger('error'),
  });
}
