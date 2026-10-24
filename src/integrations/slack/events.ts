/** Messages come through the Chat SDK adapter, loaded on first use; everything else the host parses and verifies itself. */
import { createHmac } from 'node:crypto';

import type { SlackAdapter, SlackAdapterConfig, SlackEvent } from '@chat-adapter/slack';
import type { Adapter, ChatInstance, Message, StateAdapter, Thread, WebhookOptions } from 'chat';
import * as z from 'zod/mini';

import { safeEqual } from '../../utils/crypto';
import type {
  AdapterContext,
  OwnEvent,
  PlatformApp,
  PlatformEvent,
  Space,
  TypingOptions,
  WebhookTarget,
} from '../types';
import type { SlackAppCredentials } from './app';

const envelope = z.object({
  type: z.optional(z.string()),
  team_id: z.optional(z.string()),
  enterprise_id: z.optional(z.string()),
  is_enterprise_install: z.optional(z.union([z.boolean(), z.string()])),
  api_app_id: z.optional(z.string()),
  challenge: z.optional(z.string()),
  authorizations: z.optional(
    z.array(
      z.object({
        user_id: z.optional(z.string()),
        team_id: z.optional(z.nullable(z.string())),
        enterprise_id: z.optional(z.nullable(z.string())),
        is_enterprise_install: z.optional(z.boolean()),
      }),
    ),
  ),
});

/** An org-ready app's workspace grants. */
const access = z.object({
  enterprise_id: z.optional(z.string()),
  authorizations: z.optional(z.array(z.object({ enterprise_id: z.optional(z.string()) }))),
  event: z.object({
    type: z.enum(['team_access_granted', 'team_access_revoked']),
    team_ids: z.array(z.string()),
  }),
});

const revoked = z.object({
  type: z.enum(['app_uninstalled', 'tokens_revoked']),
  tokens: z.optional(z.object({ bot: z.optional(z.array(z.string())) })),
});

/** The Home tab opened. */
const home = z.object({
  type: z.literal('app_home_opened'),
  user: z.string(),
  tab: z.literal('home'),
});

/** Action ids of buttons that only open a page, such as on the Home tab. */
export const LINK_ACTION = 'link:';
/** Action ids of buttons the app posted whose click the host reads. */
export const CLICK_ACTION = 'click:';
/** Action ids of buttons that ask for text in a modal first; the modal's callback, block and input share `ASK_VIEW`. */
export const ASK_ACTION = 'ask:';
export const ASK_VIEW = 'ask';
const clicks = z.object({
  type: z.literal('block_actions'),
  actions: z.array(z.object({ action_id: z.string() })),
});
const slackUser = z.object({
  id: z.string(),
  username: z.optional(z.string()),
  name: z.optional(z.string()),
});
const buttonClick = z.object({
  user: slackUser,
  channel: z.object({ id: z.string() }),
  message: z.optional(z.object({ ts: z.string(), thread_ts: z.optional(z.string()) })),
  trigger_id: z.optional(z.string()),
  actions: z.tuple([z.object({ action_id: z.string(), value: z.string() })]),
});
const submission = z.object({
  type: z.literal('view_submission'),
  user: slackUser,
  view: z.object({
    callback_id: z.literal(ASK_VIEW),
    private_metadata: z.string(),
    state: z.object({
      values: z.object({
        [ASK_VIEW]: z.object({
          [ASK_VIEW]: z.object({ value: z.optional(z.nullable(z.string())) }),
        }),
      }),
    }),
  }),
});
/** Where an asking button was clicked, kept in its modal until the submission. */
const asking = z.object({
  thread: z.string(),
  message: z.optional(z.string()),
  value: z.string(),
});

const actorOf = (user: z.infer<typeof slackUser>) => {
  const login = user.username ?? user.name;
  return { id: user.id, ...(login ? { login } : {}) };
};

/** A click on a button the app posted, with the thread it is in; an asking button opens its modal instead. */
function clicked(value: unknown): OwnEvent | undefined {
  const click = buttonClick.safeParse(value).data;
  const action = click?.actions[0];
  if (!click || !action) return undefined;
  // A whole 1:1 DM is one conversation, as the adapter names its messages.
  const thread = click.channel.id.startsWith('D')
    ? (click.message?.thread_ts ?? '')
    : (click.message?.thread_ts ?? click.message?.ts);
  const at = {
    thread: `slack:${click.channel.id}${thread !== undefined ? `:${thread}` : ''}`,
    ...(click.message ? { message: click.message.ts } : {}),
  };
  const trigger = click.trigger_id;
  if (action.action_id.startsWith(ASK_ACTION) && trigger)
    return { work: async ctx => (await import('./views')).openAsk(ctx, trigger, at, action.value) };
  if (!action.action_id.startsWith(CLICK_ACTION)) return undefined;

  return { click: { ...at, value: action.value, actor: actorOf(click.user) } };
}

/** An asking button's modal submitted: its click, with the text when there is some. */
function submitted(value: unknown): OwnEvent | undefined {
  const sent = submission.safeParse(value).data;
  let at;
  try {
    at = sent && asking.safeParse(JSON.parse(sent.view.private_metadata)).data;
  } catch {
    return undefined;
  }
  if (!sent || !at) return undefined;
  const text = sent.view.state.values[ASK_VIEW][ASK_VIEW].value?.trim();

  return { click: { ...at, ...(text ? { text } : {}), actor: actorOf(sent.user) } };
}

/** The Events API envelope, a slash command's form, or an interaction's `payload` field, read unverified. */
function fields(raw: string): z.infer<typeof envelope> & {
  event?: unknown;
  team?: { id?: string };
  enterprise?: { id?: string };
} {
  try {
    return JSON.parse(raw);
  } catch {
    const form = new URLSearchParams(raw);
    const payload = form.get('payload');
    if (!payload) return Object.fromEntries(form);
    try {
      return JSON.parse(payload);
    } catch {
      return {};
    }
  }
}

/** A member joining or leaving a conversation the bot is in, or a channel made private or public. */
const membership = z.union([
  z.object({
    type: z.enum(['member_joined_channel', 'member_left_channel']),
    user: z.string(),
    channel: z.string(),
  }),
  z.object({
    type: z.literal('message'),
    subtype: z.enum(['channel_convert_to_private', 'channel_convert_to_public']),
    channel: z.string(),
  }),
]);

/** What the integration handles itself, before verification: the Home tab, interactions, and an org install's workspace grants. */
function ownEvent(
  value: ReturnType<typeof fields>,
  app: string,
  installation?: string,
  account?: string,
): OwnEvent | undefined {
  const changed = membership.safeParse(value.event).data;
  if (changed && installation) {
    const place = { installation, ...(account ? { account } : {}) };
    const channel = { kind: 'channel' as const, id: changed.channel };
    if (changed.type === 'message')
      return {
        space: {
          ...place,
          space: { ...channel, private: changed.subtype === 'channel_convert_to_private' },
        },
      };

    return {
      space: {
        ...place,
        space: channel,
        ...(changed.type === 'member_joined_channel'
          ? { joined: changed.user }
          : { left: changed.user }),
      },
    };
  }
  const gone = revoked.safeParse(value.event).data;
  if (gone) {
    const removed = gone.type === 'app_uninstalled' || gone.tokens?.bot?.length;
    return installation && removed ? { uninstalled: `${app}:${installation}` } : { ack: true };
  }
  const opened = home.safeParse(value.event).data;
  if (opened) return { work: async ctx => (await import('./views')).publishHome(ctx, opened.user) };
  const actions = clicks.safeParse(value).data?.actions;
  const click = actions?.length ? clicked(value) : undefined;
  if (click) return click;
  const answer = submitted(value);
  if (answer) return answer;
  if (actions?.length && actions.every(action => action.action_id.startsWith(LINK_ACTION)))
    return { ack: true };
  // Buttons and other interactions come as a form whose payload has its own type.
  if (value.type && value.type !== 'event_callback' && value.type !== 'url_verification')
    return { unhandled: `Slack interaction ${value.type}` };

  const body = access.safeParse(value).data;
  const enterprise = body?.enterprise_id ?? body?.authorizations?.[0]?.enterprise_id;
  if (!body || !enterprise) return undefined;
  const teams = body.event.team_ids;
  return {
    covers: {
      installation: `${app}:${enterprise}`,
      ...(body.event.type === 'team_access_granted' ? { add: teams } : { remove: teams }),
    },
  };
}

/** Slack's v0 request signature, within five minutes. */
function verified(req: Request, raw: string, secret: string | undefined): boolean {
  const at = req.headers.get('x-slack-request-timestamp') ?? '';
  if (!secret || !(Math.abs(Date.now() / 1000 - Number(at)) <= 300)) return false;

  const expected = `v0=${createHmac('sha256', secret).update(`v0:${at}:${raw}`).digest('hex')}`;
  return safeEqual(req.headers.get('x-slack-signature') ?? '', expected);
}

/** The catalog event of a plain Slack message, from its event's `channel_type`. */
export const messageEvent = (channelType?: string) =>
  channelType === 'im' || channelType === 'mpim' ? 'dm' : 'channel';

/** The conversation a message event came from: a `channel` is public, `group`, `im` and `mpim` are private; a mention names no type. */
function slackSource(event: unknown): Space | undefined {
  const parsed = z
    .object({ channel: z.string(), channel_type: z.optional(z.string()) })
    .safeParse(event).data;
  if (!parsed) return undefined;
  const type = parsed.channel_type;

  return {
    kind: 'channel',
    id: parsed.channel,
    ...(type === 'channel'
      ? { private: false }
      : ['group', 'im', 'mpim'].includes(type ?? '')
        ? { private: true }
        : {}),
  };
}

export function slackTarget(_req: Request, raw: string): WebhookTarget | Response | undefined {
  const value = fields(raw);
  const body = envelope.safeParse(value).data;
  // URL verification names no app and arrives while the app is being created, before the host has its secret.
  if (body?.type === 'url_verification' && body.challenge) return new Response(body.challenge);
  const auth = body?.authorizations?.[0];
  const team = auth?.team_id ?? body?.team_id ?? value.team?.id;
  // An org-wide install is keyed by its Enterprise Grid org and covers the workspaces granted to it.
  const org = String(auth?.is_enterprise_install ?? body?.is_enterprise_install) === 'true';
  const installation = org
    ? (auth?.enterprise_id ?? body?.enterprise_id ?? value.enterprise?.id)
    : team;
  const self = auth?.user_id;
  const space = slackSource(value.event);
  return body?.api_app_id
    ? {
        app: body.api_app_id,
        ...(installation ? { installation } : {}),
        ...(org && team ? { account: team } : {}),
        ...(self ? { self } : {}),
        ...(space ? { space } : {}),
      }
    : undefined;
}

export function slackOwnEvents(
  req: Request,
  raw: string,
  app: PlatformApp,
  credentials: unknown,
): OwnEvent | undefined {
  const target = slackTarget(req, raw);
  const known = target && !(target instanceof Response) ? target : undefined;
  const own = ownEvent(fields(raw), app.id, known?.installation, known?.account);
  if (!own) return undefined;

  return verified(req, raw, (credentials as SlackAppCredentials | undefined)?.signingSecret)
    ? own
    : { invalid: true };
}

/** Chat SDK routes a 1:1 DM as a mention, and DMs and channels share its message route. */
export function slackChatEvent(
  type: string,
  thread: Thread,
  message: Message,
): Pick<PlatformEvent, 'type' | 'actor'> {
  const channelType = (message.raw as { channel_type?: string }).channel_type;
  return {
    type: thread.isDM ? 'dm' : type === 'mention' ? type : messageEvent(channelType),
    actor: {
      id: message.author.userId,
      ...(message.author.userName ? { login: message.author.userName } : {}),
    },
  };
}

/** The archive page of an event's Chat SDK thread. */
export function slackThreadUrl(event: PlatformEvent): string | undefined {
  const thread = /^slack:([^:]+):(\d+)\.(\d+)$/.exec(event.chat?.thread.id ?? '');
  return thread ? `https://slack.com/archives/${thread[1]}/p${thread[2]}${thread[3]}` : undefined;
}

/** Stands in for a workspace's bot token until a Web API call needs it, so a webhook is answered before any token lookup. */
const PENDING = 'coder-pending:';

/** An axios adapter for Slack's Web API client on the host's `fetch`, so hosts and tests see every call; it mints pending tokens. */
function viaFetch(request: typeof fetch, mint: (teamId: string) => Promise<string>) {
  return async (config: {
    url?: string;
    baseURL?: string;
    method?: string;
    headers: { toJSON(): unknown };
    data?: unknown;
  }) => {
    let body = config.data;
    const headers = config.headers.toJSON() as Record<string, string>;
    const form = typeof body === 'string' ? new URLSearchParams(body) : undefined;
    const pending = form?.get('token');
    if (form && pending?.startsWith(PENDING)) {
      form.set('token', await mint(pending.slice(PENDING.length)));
      body = form.toString();
    }
    const bearer = Object.keys(headers).find(name => name.toLowerCase() === 'authorization');
    if (bearer && headers[bearer]!.startsWith(`Bearer ${PENDING}`))
      headers[bearer] = `Bearer ${await mint(headers[bearer]!.slice(`Bearer ${PENDING}`.length))}`;
    const response = await request(new URL(config.url ?? '', config.baseURL), {
      method: config.method?.toUpperCase() ?? 'POST',
      headers,
      body: body as BodyInit | undefined,
    });
    return {
      data: await response.text(),
      status: response.status,
      statusText: response.statusText,
      headers: Object.fromEntries(response.headers),
      config,
      request: {},
    };
  };
}

/** Slack through Chat SDK: the app's signing secret verifies, the host's bound installations hold the bot tokens. */
export async function slackAdapter(ctx: AdapterContext): Promise<Adapter> {
  const [{ SlackAdapter }, { ConsoleLogger }] = await Promise.all([
    import('@chat-adapter/slack'),
    import('chat'),
  ]);

  /** Posts outside a webhook (a reply to an event Chat did not deliver) with the bound workspace's token. */
  class BoundSlackAdapter extends SlackAdapter {
    constructor(
      config: SlackAdapterConfig,
      private readonly outbound?: () => Promise<string>,
      private readonly privateState?: () => StateAdapter,
      private readonly hears?: AdapterContext['hears'],
      private readonly active?: AdapterContext['active'],
      private readonly knows?: AdapterContext['knows'],
    ) {
      super(config);
    }

    /** Set for a thread reply outside the host's conversations: its users are named by id, never looked up. */
    private unnamed = false;

    // A reaction on a message the host does not know is dropped before the thread lookup Chat would spend on it.
    protected override async handleReactionEvent(
      event: Parameters<SlackAdapter['handleReactionEvent']>[0],
      options?: WebhookOptions,
    ): Promise<void> {
      const item = event.item as { type?: string; channel?: string; ts?: string };
      if (this.knows && item.type === 'message' && item.channel && item.ts)
        if (!(await this.knows(item.channel, item.ts))) return;
      return super.handleReactionEvent(event, options);
    }

    // Filtered before Chat looks up the author and mentions: a plain message the host does not take is dropped.
    protected override handleMessageEvent(event: SlackEvent, options?: WebhookOptions): void {
      const plain =
        event.type === 'message' &&
        event.subtype !== 'message_changed' &&
        event.subtype !== 'message_deleted' &&
        event.channel_type !== 'im' &&
        !this.parseMessage(event).isMention;
      if (!plain || !this.hears) return super.handleMessageEvent(event, options);

      const work = (async () => {
        if (!(await this.hears!(messageEvent(event.channel_type), event.text ?? ''))) return;
        this.unnamed =
          Boolean(event.thread_ts) && !(await this.active?.(this.threadIdForMessageEvent(event)));
        super.handleMessageEvent(event, options);
      })();
      options?.waitUntil?.(work);
    }

    protected override lookupUser(userId: string) {
      return this.unnamed
        ? Promise.resolve({ displayName: userId, realName: userId })
        : super.lookupUser(userId);
    }

    override async initialize(chat: ChatInstance): Promise<void> {
      const shared = chat.getState();
      const local = this.privateState?.() ?? shared;
      const state = new Proxy(shared, {
        get(target, key) {
          const method = Reflect.get(target, key);
          if (typeof method !== 'function') return method;
          return (...args: unknown[]) => {
            const owner =
              typeof args[0] === 'string' &&
              /^slack:(?:user:|user-by-name:|thread-participants:)/.test(args[0])
                ? local
                : target;
            return Reflect.apply(Reflect.get(owner, key), owner, args);
          };
        },
      });
      await super.initialize(
        new Proxy(chat, {
          get: (target, key, receiver) =>
            key === 'getState' ? () => state : Reflect.get(target, key, receiver),
        }),
      );
    }

    // A whole DM has no thread, so its status goes on the asking message.
    override startTyping(threadId: string, status?: string, options?: TypingOptions) {
      const { channel, threadTs } = this.decodeThreadId(threadId);
      const target =
        threadTs || !options?.messageId
          ? threadId
          : this.encodeThreadId({ channel, threadTs: options.messageId });

      return super.startTyping(target, status, options);
    }

    protected override markEventDelivered(): void {}

    protected override async isDuplicateEventDelivery(): Promise<boolean> {
      return false;
    }

    protected override getToken(): Promise<string> {
      return this.requestContext.getStore()?.token || !this.outbound
        ? super.getToken()
        : this.outbound();
    }
  }

  const signingSecret = (ctx.credentials as SlackAppCredentials | undefined)?.signingSecret;
  const installationId = ctx.installationId;
  const minted = new Map<string, Promise<string>>();
  const mint = (teamId: string) => {
    if (!minted.has(teamId)) minted.set(teamId, ctx.token(teamId));
    return minted.get(teamId)!;
  };
  // Built without the factory, and every field set, so no SLACK_* variable verifies a request or receives a token.
  return new BoundSlackAdapter(
    {
      userName: ctx.name,
      apiUrl: 'https://slack.com/api/',
      appToken: '',
      socketForwardingSecret: '',
      clientId: '',
      clientSecret: '',
      encryptionKey: '',
      // Without the app's secret (a task's runner, which only posts) no webhook is ever accepted.
      ...(signingSecret
        ? {
            signingSecret,
            // A webhook names its workspace.
            installationProvider: {
              getInstallation: async (teamId: string) => ({
                botToken: `${PENDING}${teamId}`,
                ...(ctx.self ? { botUserId: ctx.self } : {}),
              }),
            },
          }
        : {
            webhookVerifier: () => false,
            botToken: () =>
              installationId
                ? ctx.token(installationId)
                : Promise.reject(new Error('No Slack workspace to post for')),
          }),
      webClientOptions: { adapter: viaFetch(ctx.fetch, mint) as never },
      logger: new ConsoleLogger('error'),
    },
    signingSecret && installationId ? () => mint(installationId) : undefined,
    ctx.privateState,
    ctx.hears,
    ctx.active,
    ctx.knows,
  );
}
