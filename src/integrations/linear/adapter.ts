/** Linear agent sessions through Chat SDK: the host verifies the webhook signature, then mints the workspace's app token. */
import { LinearAdapter } from '@chat-adapter/linear';
import {
  type Adapter,
  type AdapterPostableMessage,
  type ChatInstance,
  ConsoleLogger,
  defaultEmojiResolver,
  type EmojiValue,
} from 'chat';

import { verifyLinearWebhook } from './api';
import type { AdapterContext } from '../types';
import type { LinearAppCredentials } from './app';

/** Mints nothing before a webhook is verified, and posts outside one (a task's reply) for the bound workspace. */
class BoundLinearAdapter extends LinearAdapter {
  constructor(
    config: ConstructorParameters<typeof LinearAdapter>[0],
    private readonly organization: string | undefined,
    private readonly installedSelf?: AdapterContext['installedSelf'],
    private readonly saveSelf?: AdapterContext['saveSelf'],
  ) {
    super(config);
  }

  // Chat initializes before verifying; the app identity is looked up once the webhook is verified.
  override async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  // The app user stored at install stands in for Linear's viewer query.
  protected override async resolveConnectIdentity(): Promise<void> {
    const self = this.organization && (await this.installedSelf?.(this.organization));
    if (!self) {
      await super.resolveConnectIdentity();
      if (this.defaultBotUserId && this.defaultOrganizationId === this.organization)
        await this.saveSelf?.(this.organization, this.defaultBotUserId);
      return;
    }
    this.defaultBotUserId = self;
    this.defaultOrganizationId = this.organization!;
  }

  private bound<T>(work: () => Promise<T>): Promise<T> {
    if (this.requestContext.getStore()) return work();
    if (!this.organization) return Promise.reject(new Error('No Linear workspace to post for'));
    return this.withInstallation(this.organization, work);
  }

  override postMessage(threadId: string, message: AdapterPostableMessage) {
    return this.bound(() => super.postMessage(threadId, message));
  }

  override addReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
    return this.bound(() =>
      super.addReaction(threadId, messageId, defaultEmojiResolver.toGChat(emoji)),
    );
  }

  override startTyping(threadId: string, status?: string) {
    return this.bound(() => super.startTyping(threadId, status));
  }

  postProgress(threadId: string, text: string) {
    const { agentSessionId } = this.decodeThreadId(threadId);
    if (!agentSessionId) return this.postMessage(threadId, { markdown: text });

    return this.bound(async () => {
      await this.ensureValidToken();
      const result = await this.getClient().createAgentActivity({
        agentSessionId,
        content: { type: 'thought' as never, body: text },
      });
      const activity = await result.agentActivity;
      if (!result.success || !activity) throw new Error('Linear progress activity failed');

      return { id: activity.id };
    });
  }

  /** A `select` elicitation whose pick comes back as a prompt holding the option's value; outside a session, a comment. */
  postElicitation(
    threadId: string,
    body: string,
    options: Array<{ label: string; value: string }>,
  ): Promise<{ id?: string }> {
    const { agentSessionId } = this.decodeThreadId(threadId);
    if (!agentSessionId) return this.postMessage(threadId, { markdown: body });

    return this.bound(async () => {
      await this.ensureValidToken();
      const result = await this.getClient().createAgentActivity({
        agentSessionId,
        content: { type: 'elicitation' as never, body },
        signal: 'select' as never,
        signalMetadata: { options },
      });
      const activity = await result.agentActivity;
      if (!result.success || !activity) throw new Error('Linear elicitation activity failed');

      return { id: activity.id };
    });
  }

  /** An error activity, so Linear shows the session as failed; outside a session, a comment. */
  postProblem(threadId: string, text: string) {
    const { agentSessionId } = this.decodeThreadId(threadId);
    if (!agentSessionId) return this.postMessage(threadId, text);

    return this.bound(async () => {
      await this.ensureValidToken();
      await this.getClient().createAgentActivity({
        agentSessionId,
        content: { type: 'error' as never, body: text },
      });
    });
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
    ctx.installedSelf,
    ctx.saveSelf,
  );
}
