/** Chat SDK per app and request: the app's adapter, its own slice of chat state, and the handlers that raise Coder events. */
import { createHash } from 'node:crypto';

import { Chat, Message, type SerializedMessage, type SerializedThread, type Thread } from 'chat';

import { BUILTIN_AGENT } from '../agent/load';
import type { AgentApp, AgentEvent, TaskContext } from '../agent/types';
import type { ChatRoute, Integration, TokenBound } from '../integrations/types';
import { appOwner, forInstallation, scoped, type ServerContext } from './context';
import { appChatState, LocalChatState } from './store/chat';
import { decryptSecret } from './store/secrets';
import { installationToken } from './tasks/context';
import { DELIVERY_TTL_MS, dispatchEvent, type Replies } from './tasks/events';
import { kick } from './tasks/kick';

const HISTORY_LIMIT = 10;
/** Messages read at most to reach a long thread's end. */
const HISTORY_SCAN = 1000;

/** The installation a webhook names, and its repository when it has one. */
export interface Target {
  id: string;
  repo?: NonNullable<AgentEvent['repo']>;
  /** The app's own platform user. */
  self?: string;
}

/** A token for one of the app's bound installations; an unbound or removed one gets none. */
async function boundToken(
  ctx: ServerContext,
  app: AgentApp,
  credentials: unknown,
  installationId: string,
  bound?: TokenBound,
): Promise<string> {
  const key = `${app.id}:${installationId}`;
  const tenant = await forInstallation(ctx, key);
  const installation =
    tenant?.boundInstallation?.installation.id === key
      ? tenant.boundInstallation.installation
      : await tenant?.store.get('installation', key);
  if (!tenant || !installation || installation.deletedAt)
    throw new Error(
      `${app.integration} installation ${installationId} is not bound to this server`,
    );

  return installationToken(
    tenant,
    ctx.integrations[app.integration]!,
    installation,
    credentials,
    bound,
  );
}

/** A thread or message as a task keeps it: no raw platform payload, and no message id that carries a reply URL. */
function stored<T extends SerializedThread | SerializedMessage>(value: T): T {
  if (value._type === 'chat:Thread') return { ...value, currentMessage: undefined } as T;
  const { raw: _raw, replyTo: _replyTo, ...message } = value as SerializedMessage;
  return { ...message, raw: null, id: message.id.startsWith('ephemeral:') ? '' : message.id } as T;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The integration's event a Chat SDK handler raises. */
const raisedBy = (integration: Integration, route: ChatRoute) =>
  Object.keys(integration.events).find(name => integration.events[name]!.on === route);

// A handle ends at anything but a word character, a hyphen, or a dot inside a longer name.
const END = '(?![\\w-]|\\.\\w)';
const tidy = (text: string) => text.replace(/[ \t]{2,}/g, ' ').trim();

/** Text with every `@name` removed, or `undefined` when none is mentioned. */
function unmentioned(text: string, names: string[]): string | undefined {
  const stripped = names.reduce(
    (rest, name) => rest.replace(new RegExp(`(^|[^\\w-])@${escape(name)}${END}`, 'gi'), '$1'),
    text,
  );
  return stripped === text ? undefined : tidy(stripped);
}

/** Text addressed to `name` by `@name` anywhere or `name` as its first word, with the address removed. */
export function addressedTo(text: string, name: string): string | undefined {
  const mentioned = unmentioned(text, [name]);
  if (mentioned !== undefined) return mentioned;
  const leading = new RegExp(`^\\s*${escape(name)}${END}[\\s,:;!.?-]*`, 'i');
  return leading.test(text) ? tidy(text.replace(leading, '')) : undefined;
}

/** Dispatch after the platform has its answer: a failure is logged with its app and event, since nothing else will see it. */
export function later(
  ctx: ServerContext,
  app: AgentApp,
  event: AgentEvent,
  work: Promise<unknown>,
): void {
  const logged = work.catch(error =>
    console.error(`coder server: dispatch failed for ${app.id} event ${event.deliveryId}`, error),
  );
  if (ctx.waitUntil) ctx.waitUntil(logged);
}

/** One event into the workspace its installation is bound to, answered in its thread; a queued task is kicked once it lands. */
export async function deliver(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  event: AgentEvent,
  replies: Replies,
): Promise<string | undefined> {
  const tenant = await forInstallation(ctx, `${app.id}:${event.installationId}`);
  // A workspace's own app only ever serves that workspace.
  if (!tenant || (!app.builtin && tenant.organizationId !== ctx.organizationId)) return;
  const dispatched = await dispatchEvent(
    tenant,
    integration,
    app,
    credentials,
    event,
    ctx.now ?? Date.now,
    replies,
  );
  await dispatched.work;
  if (dispatched.taskId) await kick(tenant, true, false, true);
  return dispatched.taskId;
}

/** Replies through a Chat SDK thread: public posts, and private ones only where the platform has them. */
export function threadReplies(
  thread: Thread,
  user?: Message['author'] | string,
  message?: Message | string,
): Replies {
  return {
    // Where the platform answers one message (Gmail), the reply goes to the one that raised the event, not the thread's newest.
    post: text =>
      message && thread.adapter.reply ? thread.reply(message, text) : thread.post(text),
    whisper: text =>
      user ? thread.postEphemeral(user, text, { fallbackToDM: false }) : Promise.resolve(null),
    // Oldest first through every page: an adapter's newest-first read may stop at its first page (Slack's at 200).
    async recent() {
      const messages: NonNullable<TaskContext['messages']> = [];
      let read = 0;
      for await (const message of thread.allMessages) {
        messages.push({
          user: message.author.userName || message.author.userId,
          text: message.text,
          ts: message.metadata.dateSent.toISOString(),
        });
        if (messages.length > HISTORY_LIMIT) messages.shift();
        if (++read === HISTORY_SCAN) break;
      }
      return messages;
    },
  };
}

/** Replies in the thread of an event that did not come through the adapter: GitHub pull requests, events sent by an admin. */
export async function eventReplies(
  ctx: ServerContext,
  app: AgentApp,
  event: AgentEvent,
): Promise<Replies> {
  if (!event.chat) return { post: async () => {}, whisper: async () => {} };
  const chat = await chatFor(ctx, app, {
    id: event.installationId,
    ...(event.repo ? { repo: event.repo } : {}),
  });
  await chat.initialize();
  return threadReplies(
    chat.thread(event.chat.thread.id),
    event.actor.id || undefined,
    event.chat.message?.id || undefined,
  );
}

/** A Chat SDK message as the integration's event, or nothing when no event of the app's integration fits it; `delivery` names it within its thread. */
function chatEvent(
  integration: Integration,
  app: AgentApp,
  target: Target,
  route: ChatRoute,
  thread: Thread,
  message: Message,
  delivery = message.id,
): AgentEvent | undefined {
  // The built-in agent hears messages only when addressed, by its plain name too.
  const address =
    route === 'message' && app.agent === BUILTIN_AGENT
      ? addressedTo(message.text, BUILTIN_AGENT)
      : undefined;
  if (route === 'message' && app.agent === BUILTIN_AGENT && address === undefined) return;
  const type = raisedBy(integration, address === undefined ? route : 'mention');
  // Agents never wake agents; Chat already drops the app's own messages.
  if (!type || message.author.isBot === true) return;
  const extra: Partial<AgentEvent> | undefined = integration.event
    ? integration.event(type, thread, message, app)
    : {};
  if (!extra) return;
  // A mention's text loses the address; anything else keeps its words.
  const mention = (extra.type ?? type) === raisedBy(integration, 'mention');
  const text = !mention
    ? message.text
    : (address ??
      unmentioned(message.text, [app.name, ...(target.self ? [target.self] : [])]) ??
      message.text);
  return {
    integration: integration.id,
    type,
    appId: app.id,
    installationId: target.id,
    deliveryId: createHash('sha256')
      .update(`${app.id}\n${target.id}\n${thread.id}\n${delivery}`)
      .digest('base64url')
      .slice(0, 22),
    actor: {
      id: message.author.userId,
      ...(message.author.userName ? { login: message.author.userName } : {}),
    },
    text,
    chat: { thread: stored(thread.toJSON()), message: stored(message.toJSON()) },
    ...(target.repo ? { repo: target.repo } : {}),
    ...extra,
  };
}

/** A Chat for one app, built per request so no adapter cache outlives it. */
export async function chatFor(ctx: ServerContext, app: AgentApp, target?: Target): Promise<Chat> {
  const integration = ctx.integrations[app.integration];
  if (!integration) throw new Error(`Unknown integration "${app.integration}"`);
  const credentials = decryptSecret(ctx.config, app.credentials);
  const adapter = await integration.adapter({
    fetch: ctx.fetch ?? fetch,
    appId: app.id.slice(integration.id.length + 1),
    name: app.name,
    credentials,
    ...(target ? { installationId: target.id, ...(target.self ? { self: target.self } : {}) } : {}),
    token: (id, bound) =>
      boundToken(ctx, app, credentials, id, {
        ...(target?.repo ? { repo: { owner: target.repo.owner, name: target.repo.name } } : {}),
        ...bound,
      }),
    isBound: async id => {
      const key = `${app.id}:${id}`;
      const tenant = await forInstallation(ctx, key);
      const installation =
        tenant?.boundInstallation?.installation.id === key
          ? tenant.boundInstallation.installation
          : await tenant?.store.get('installation', key);

      return Boolean(
        installation &&
        !installation.deletedAt &&
        (app.builtin || tenant?.organizationId === ctx.organizationId),
      );
    },
  });
  const state = appChatState(ctx.chatState ?? new LocalChatState(), app.id);
  const chat = new Chat({
    userName: app.name,
    adapters: { [integration.id]: adapter },
    state: { ...state, isSubscribed: async () => false },
    // Coder's own task queue orders the work, so a thread is never locked.
    concurrency: 'concurrent',
    dedupeTtlMs: DELIVERY_TTL_MS,
    logger: 'error',
  });
  if (!target) return chat;
  // Dispatch continues after the handler so no webhook waits on it (Teams DMs do).
  const receive = async (route: ChatRoute, thread: Thread, message: Message, delivery?: string) => {
    const event = chatEvent(integration, app, target, route, thread, message, delivery);
    if (event)
      later(
        ctx,
        app,
        event,
        deliver(
          ctx,
          integration,
          app,
          credentials,
          event,
          threadReplies(thread, message.author, message),
        ),
      );
  };
  chat.onNewMention((thread, message) => receive('mention', thread, message));
  chat.onNewMessage(/[\s\S]*/, (thread, message) => receive('message', thread, message));
  chat.onReaction(async reaction => {
    if (!reaction.added) return;
    const identity = integration.reactionId?.(reaction);
    if (!identity) return;
    const message = new Message({
      id: reaction.messageId,
      threadId: reaction.threadId,
      text: reaction.message?.text ?? '',
      formatted: reaction.message?.formatted ?? { type: 'root', children: [] },
      raw: reaction.raw,
      author: reaction.user,
      metadata: reaction.message?.metadata ?? { dateSent: new Date(), edited: false },
      attachments: [],
    });
    await receive(
      'reaction',
      reaction.thread as Thread,
      message,
      `reaction\n${identity}\n${reaction.user.userId}\n${reaction.rawEmoji}`,
    );
  });
  // `/setup` is the one command Coder registers.
  chat.onSlashCommand('/setup', async command => {
    const type = raisedBy(integration, 'command');
    if (!type) return;
    const whisper = (text: string) =>
      command.channel.postEphemeral(command.user, text, { fallbackToDM: false });
    const event: AgentEvent = {
      integration: integration.id,
      type,
      appId: app.id,
      installationId: target.id,
      deliveryId: createHash('sha256')
        .update(
          `${app.id}\n${target.id}\n${command.channel.id}\n${command.triggerId ?? command.text}`,
        )
        .digest('base64url')
        .slice(0, 22),
      actor: {
        id: command.user.userId,
        ...(command.user.userName ? { login: command.user.userName } : {}),
      },
      text: command.text.trim(),
    };
    later(
      ctx,
      app,
      event,
      deliver(ctx, integration, app, credentials, event, { post: whisper, whisper }),
    );
  });
  return chat;
}

/** Renew one bound installation's platform subscription through its adapter, or only catch up on what it missed. */
export async function renewInstallation(
  ctx: ServerContext,
  app: AgentApp,
  installationId: string,
  op: 'renew' | 'sync' = 'renew',
): Promise<void> {
  const integration = ctx.integrations[app.integration];
  if (!integration?.[op]) return;
  const pending: Promise<unknown>[] = [];
  const chat = await chatFor(
    {
      ...ctx,
      waitUntil: work => {
        pending.push(work);
        ctx.waitUntil?.(work);
      },
    },
    app,
    { id: installationId },
  );
  await chat.initialize();
  await integration[op](chat.getAdapter(integration.id));
  while (pending.length) await Promise.all(pending.splice(0));
}

/** The sweep's renewal (or the kick timer's sync) of every live installation that keeps a platform subscription; one failure skips only that one. */
export async function renewInstallations(
  ctx: ServerContext,
  op: 'renew' | 'sync' = 'renew',
): Promise<void> {
  for (const integration of Object.values(ctx.integrations)) {
    if (!integration[op]) continue;
    for (const { key, organizationId } of (await ctx.installations?.(integration.id)) ?? []) {
      const installation = await scoped(ctx, organizationId).store.get('installation', key);
      const owner = installation && (await appOwner(ctx, installation.app));
      if (owner)
        await renewInstallation(owner.ctx, owner.app, key.slice(owner.app.id.length + 1), op).catch(
          () => {},
        );
    }
  }
}
