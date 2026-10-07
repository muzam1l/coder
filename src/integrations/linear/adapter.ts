/** Linear agent sessions through Chat SDK: Coder verifies the webhook signature, then mints the workspace's app token. */
import { createHmac } from 'node:crypto';

import { LinearAdapter } from '@chat-adapter/linear';
import { type Adapter, type AdapterPostableMessage, type ChatInstance, ConsoleLogger } from 'chat';

import { safeEqual } from '../../utils/crypto';
import type { AdapterContext } from '../types';
import type { LinearAppCredentials } from './app';

/** Linear's webhook check: an HMAC of the body under the app's secret, sent within the last minute. */
export function verifyLinearWebhook(
  raw: string,
  signature: string | null,
  secret: string | undefined,
  now = Date.now(),
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  if (!safeEqual(Buffer.from(signature, 'hex'), expected)) return false;
  const sent = (JSON.parse(raw) as { webhookTimestamp?: unknown }).webhookTimestamp;
  return typeof sent === 'number' && Math.abs(now - sent) <= 60_000;
}

/** Mints nothing before a webhook is verified, and posts outside one (a task's reply) for the bound workspace. */
class BoundLinearAdapter extends LinearAdapter {
  constructor(
    config: ConstructorParameters<typeof LinearAdapter>[0],
    private readonly organization: string | undefined,
  ) {
    super(config);
  }

  // Chat initializes before verifying; the app identity is looked up once the webhook is verified.
  override async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  private bound<T>(work: () => Promise<T>): Promise<T> {
    if (this.requestContext.getStore()) return work();
    if (!this.organization) return Promise.reject(new Error('No Linear workspace to post for'));
    return this.withInstallation(this.organization, work);
  }

  override postMessage(threadId: string, message: AdapterPostableMessage) {
    return this.bound(() => super.postMessage(threadId, message));
  }

  override startTyping(threadId: string, status?: string) {
    return this.bound(() => super.startTyping(threadId, status));
  }
}

export function linearAdapter(ctx: AdapterContext): Adapter {
  const secret = (ctx.credentials as LinearAppCredentials | undefined)?.webhookSecret;
  const organization = ctx.installationId;
  return new BoundLinearAdapter(
    {
      mode: 'agent-sessions',
      userName: ctx.name,
      // Set, so no LINEAR_* variable redirects the token or replaces the key.
      apiUrl: 'https://api.linear.app/graphql',
      encryptionKey: '',
      accessToken: () =>
        organization
          ? ctx.token(organization)
          : Promise.reject(new Error('The webhook names no Linear workspace')),
      // Without the app's secret (a task's runner, which only posts) no webhook is ever accepted.
      webhookVerifier: (req, body) =>
        verifyLinearWebhook(body, req.headers.get('linear-signature'), secret),
      logger: new ConsoleLogger('error'),
    },
    organization,
  );
}
