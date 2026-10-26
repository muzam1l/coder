/** Comments come through the Chat SDK adapter, loaded on first use; the host verifies and parses every other webhook itself. */
import { createHmac } from 'node:crypto';

import type { LinearAdapter } from '@chat-adapter/linear';
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  SerializedThread,
  WebhookOptions,
} from 'chat';

import { safeEqual } from '../../utils/crypto';
import type {
  AdapterContext,
  OwnEvent,
  PlatformApp,
  PlatformEvent,
  TypingOptions,
  WebhookTarget,
} from '../types';
import type { LinearAppCredentials } from './app';

const DAY_MS = 24 * 60 * 60 * 1000;
const typingKey = (threadId: string) => `linear:typing:${threadId}`;

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

export function linearTarget(req: Request, raw: string): WebhookTarget | undefined {
  const app = new URL(req.url).searchParams.get('app');
  let body: {
    type?: unknown;
    organizationId?: unknown;
    data?: { issue?: { teamId?: unknown; team?: { id?: unknown } } };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const organization = body.organizationId;
  // A comment's issue team, unknown (`''`) when the payload names none, until `space` asks Linear; unknown counts as private.
  const issue = body.data?.issue;
  const team = issue?.teamId ?? issue?.team?.id;
  return app && typeof organization === 'string'
    ? {
        app,
        installation: organization,
        ...(body.type === 'Comment'
          ? { space: { kind: 'team' as const, id: typeof team === 'string' ? team : '' } }
          : {}),
      }
    : undefined;
}

type Issue = {
  id?: string;
  title?: string;
  description?: string | null;
  teamId?: string;
  state?: { name?: string };
  labels?: Array<{ id?: string; name?: string }>;
  priorityLabel?: string;
  assignee?: { name?: string } | null;
  delegateId?: string | null;
  botActor?: unknown;
};

/** A Linear webhook with the fields read here: the app's revocation and Issue changes. */
type Webhook = {
  type?: string;
  action?: string;
  organizationId?: string;
  oauthClientId?: string;
  actor?: { id?: string; type?: string; name?: string } | null;
  data?: Issue;
  /** An update's previous values, a key for each property it changed. */
  updatedFrom?: Record<string, unknown> & { labelIds?: string[] };
};

/** Whether `text` @-mentions the app by name. */
const mentions = (text: string, name: string) =>
  new RegExp(`(^|[^\\w-])@${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\w-])`, 'i').test(
    text,
  );

/** What an issue update changed that an agent acts on, a line each; removed labels and reordering are not. */
function changes(issue: Issue, before: NonNullable<Webhook['updatedFrom']>): string[] {
  const added = (issue.labels ?? []).filter(
    label => before.labelIds && label.id && !before.labelIds.includes(label.id),
  );

  return [
    'stateId' in before && issue.state?.name && `Moved to ${issue.state.name}`,
    added.length > 0 && `Labeled ${added.map(label => label.name).join(', ')}`,
    'priority' in before && issue.priorityLabel && `Priority ${issue.priorityLabel}`,
    'assigneeId' in before &&
      (issue.assignee?.name ? `Assigned to ${issue.assignee.name}` : 'Unassigned'),
    ('title' in before || 'description' in before) && 'Edited',
  ].filter((line): line is string => Boolean(line));
}

/** An Issue webhook as the `issue` event, or `mention` when it delegates the issue to the app; only people's changes count, so the agent never answers itself. */
function issueEvent(
  req: Request,
  body: Webhook,
  app: PlatformApp,
  self?: string,
): PlatformEvent | undefined {
  const issue = body.data;
  if (body.type !== 'Issue' || body.actor?.type !== 'user' || !body.actor.id) return;
  if (!issue?.id || issue.botActor || !body.organizationId) return;
  const about = [issue.title, issue.description].filter(Boolean).join('\n\n');
  const delegated = Boolean(
    self &&
    issue.delegateId === self &&
    (body.action === 'create' || (body.updatedFrom && 'delegateId' in body.updatedFrom)),
  );
  const before = body.action === 'update' ? body.updatedFrom : undefined;
  const changed = before ? changes(issue, before) : [];
  // A change carries the description only when it edited it, so an old ask there isn't repeated.
  const edited = before && ('title' in before || 'description' in before);
  const text =
    delegated || body.action === 'create'
      ? about
      : changed.length
        ? `${changed.join('\n')}\n\n${edited ? about : (issue.title ?? '')}`
        : '';
  if (!text) return;
  const thread: SerializedThread = {
    _type: 'chat:Thread',
    adapterName: 'linear',
    channelId: `linear:${issue.id}`,
    id: `linear:${issue.id}`,
    isDM: false,
  };

  return {
    integration: 'linear',
    type: delegated ? 'mention' : 'issue',
    appId: app.id,
    installationId: body.organizationId,
    deliveryId: req.headers.get('linear-delivery') ?? '',
    actor: { id: body.actor.id, ...(body.actor.name ? { login: body.actor.name } : {}) },
    text,
    ...(!delegated && body.action === 'create' && mentions(about, app.name)
      ? { mentioned: true as const }
      : {}),
    ...(issue.teamId ? { space: { kind: 'team' as const, id: issue.teamId } } : {}),
    chat: { thread },
  };
}

/** Every signed webhook but comments, which the Chat SDK adapter verifies and handles. */
export function linearOwnEvents(
  req: Request,
  raw: string,
  app: PlatformApp,
  credentials: unknown,
  self?: string,
): OwnEvent | undefined {
  const body = JSON.parse(raw) as Webhook;
  if (body.type === 'Comment') return undefined;
  const secret = (credentials as { webhookSecret?: string }).webhookSecret;
  if (!verifyLinearWebhook(raw, req.headers.get('linear-signature'), secret))
    return { invalid: true };
  if (body.type === 'OAuthApp')
    return body.action === 'revoked' &&
      body.organizationId &&
      body.oauthClientId === app.id.slice('linear:'.length)
      ? { uninstalled: `${app.id}:${body.organizationId}` }
      : { invalid: true };
  const event = issueEvent(req, body, app, self);

  return event ? { events: [event] } : { ack: true };
}

/** Linear comments through Chat SDK: the host verifies the webhook signature, then mints the workspace's app token. */
export async function linearAdapter(ctx: AdapterContext): Promise<Adapter> {
  const [{ LinearAdapter }, { ConsoleLogger, defaultEmojiResolver }] = await Promise.all([
    import('@chat-adapter/linear'),
    import('chat'),
  ]);

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

    /** The app user's handle, kept a day in Chat state. */
    private async handle(): Promise<string> {
      const state = this.chat!.getState();
      const key = `linear:handle:${this.botUserId}`;
      const known = await state.get<string>(key);
      if (known) return known;
      const { displayName } = await this.getClient().user(this.botUserId);
      await state.set(key, displayName, DAY_MS);

      return displayName;
    }

    // New and edited comments; a mention of the app user, typed by handle or picked as its profile link, reads as `@<name>`.
    protected override async onCommentEvent(
      payload: Parameters<LinearAdapter['onCommentEvent']>[0],
      options?: WebhookOptions,
    ): Promise<void> {
      const { data } = payload;
      const chat = this.chat;
      const edit = payload.action === 'update';
      if ((!edit && payload.action !== 'create') || !chat || !data.issueId || !data.user) return;
      const { issueId, user } = data;

      await this.withWebhookInstallation(payload.organizationId, async () => {
        const handle = /@|\/profiles\//.test(data.body)
          ? await this.handle().catch(error => {
              console.error('coder server: could not read the Linear app user', error);
              return undefined;
            })
          : undefined;
        const self = handle?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const mention =
          self &&
          new RegExp(
            `https://linear\\.app/[^/\\s]+/profiles/${self}(?![\\w-])|(?<![\\w-])@${self}(?![\\w-])`,
            'gi',
          );
        const body = mention ? data.body.replace(mention, `@${this.userName}`) : data.body;
        const message = this.parseMessage({
          kind: 'comment',
          organizationId: payload.organizationId,
          comment: {
            id: data.id,
            body,
            issueId,
            parentId: data.parentId ?? undefined,
            createdAt: data.createdAt,
            updatedAt: data.updatedAt,
            url: payload.url ?? undefined,
            user: {
              type: 'user',
              id: user.id,
              displayName: /\/profiles\/([^/?#]+)/.exec(user.url)?.[1] ?? '',
              fullName: user.name,
              email: user.email,
              avatarUrl: user.avatarUrl ?? undefined,
            },
          },
        });
        const threadId = this.encodeThreadId({ issueId, commentId: data.parentId || data.id });

        if (edit) void chat.processMessageUpdated({ adapter: this, threadId, message }, options);
        else void chat.processMessage(this, threadId, message, options);
      });
    }

    private bound<T>(work: () => Promise<T>): Promise<T> {
      if (this.requestContext.getStore()) return work();
      if (!this.organization) return Promise.reject(new Error('No Linear workspace to post for'));
      return this.withInstallation(this.organization, work);
    }

    override postMessage(threadId: string, message: AdapterPostableMessage) {
      return this.bound(() => super.postMessage(threadId, message));
    }

    override editMessage(threadId: string, messageId: string, message: AdapterPostableMessage) {
      return this.bound(() => super.editMessage(threadId, messageId, message));
    }

    override addReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
      return this.bound(() =>
        super.addReaction(threadId, messageId, defaultEmojiResolver.toGChat(emoji)),
      );
    }

    // Typing is a 👀 on the asking comment, or the issue, kept in Chat state until the reply removes it.
    override startTyping(threadId: string, _status?: string, options?: TypingOptions) {
      const { issueId, commentId } = this.decodeThreadId(threadId);
      const comment = options?.messageId ?? commentId;

      return this.bound(async () => {
        await this.ensureValidToken();
        const { reaction } = await this.getClient().createReaction({
          ...(comment ? { commentId: comment } : { issueId }),
          emoji: '👀',
        });
        await this.chat
          ?.getState()
          .appendToList(typingKey(threadId), reaction.id, { ttlMs: DAY_MS });
      });
    }

    async endTyping(threadId: string) {
      const state = this.chat?.getState();
      const added = (await state?.getList<string>(typingKey(threadId))) ?? [];
      if (!added.length) return;
      await state!.delete(typingKey(threadId));

      await this.bound(async () => {
        await this.ensureValidToken();
        await Promise.all(added.map(id => this.getClient().deleteReaction(id)));
      });
    }
  }

  const secret = (ctx.credentials as LinearAppCredentials | undefined)?.webhookSecret;
  const organization = ctx.installationId;
  return new BoundLinearAdapter(
    {
      mode: 'comments',
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
