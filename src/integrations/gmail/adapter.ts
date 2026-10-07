/** Gmail through Chat SDK: one bound mailbox per adapter, Google's push tokens verified, Coder's refreshed access token. */
import { GmailAdapter, type GmailAdapterConfig } from '@chat-adapter/gmail';
import {
  createGmailWebhookVerifier,
  GmailWebhookError,
  type GmailWebhookOptions,
} from '@chat-adapter/gmail/webhook';
import { type Adapter, ConsoleLogger, type WebhookOptions } from 'chat';

import type { AdapterContext } from '../types';
import type { GmailAppCredentials } from './app';

/** Answers a verified push at once and synchronizes the mailbox as the host's background work. */
class BackgroundGmailAdapter extends GmailAdapter {
  private readonly verify: ReturnType<typeof createGmailWebhookVerifier>;

  constructor(
    config: GmailAdapterConfig,
    push: GmailWebhookOptions,
    private readonly isBound?: AdapterContext['isBound'],
  ) {
    super(config);
    this.verify = createGmailWebhookVerifier(push);
  }

  override async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const notification = await this.verify(request).catch((error: unknown) => {
      if (error instanceof GmailWebhookError)
        return new Response(error.message, { status: error.status });
      throw error;
    });
    if (notification instanceof Response) return notification;
    if (notification.emailAddress !== this.userName)
      return new Response('Unexpected Gmail mailbox', { status: 403 });
    if (!this.isBound || !(await this.isBound(notification.emailAddress)))
      return new Response('Gmail mailbox is not bound', { status: 403 });
    if (options?.waitUntil) options.waitUntil(this.sync());
    else await this.sync();
    return new Response(null, { status: 204 });
  }
}

export function gmailAdapter(ctx: AdapterContext): Adapter {
  const credentials = ctx.credentials as GmailAppCredentials | undefined;
  const mailbox = ctx.installationId;
  if (!mailbox) throw new Error('A Gmail adapter serves one bound mailbox');
  // Without the app's credentials (a task's runner, which only posts) no notification is ever accepted.
  const push: GmailWebhookOptions = credentials
    ? {
        subscription: credentials.subscription,
        audience: credentials.audience,
        serviceAccountEmail: credentials.serviceAccount,
      }
    : { subscription: 'projects/none/subscriptions/none', webhookVerifier: () => false };
  return new BackgroundGmailAdapter(
    {
      mailbox,
      labelId: credentials?.label ?? 'INBOX',
      accessToken: () => ctx.token(mailbox),
      topicName: credentials?.topic ?? '',
      subscription: push.subscription,
      pubsubAudience: push.audience ?? '',
      pubsubServiceAccountEmail: push.serviceAccountEmail ?? '',
      ...(push.webhookVerifier ? { webhookVerifier: push.webhookVerifier } : {}),
      replyAll: false,
      fetch: ctx.fetch,
      logger: new ConsoleLogger('error'),
    },
    push,
    ctx.isBound,
  );
}
