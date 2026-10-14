/** Chat SDK per app and request: the app's adapter, its own slice of chat state, and the handlers that raise Coder events. */
import { createHash } from 'node:crypto';

import { Chat, Message, type SerializedMessage, type SerializedThread, type Thread } from 'chat';

import { definitionEvents, eventOptions } from '../agent/definition';
import { type AgentApp, type AgentEvent, type TaskContext } from '../agent/types';
import { agentWithVersion } from './agents/records';
import type { AdapterContext, ChatRoute, Integration, TokenBound } from '../integrations/types';
import { forInstallation, type ServerContext } from './context';
import { appChatState, LocalChatState } from './store/chat';
import { decryptSecret } from './store/secrets';
import { updateMetadata } from './store';
import { installationToken } from './tasks/context';
import { DELIVERY_TTL_MS, dispatchEvent, type Replies } from './tasks/events';
import { conversationKey } from './tasks/thread';
import { dashPath, organizationSlug } from './auth/account';
import { kick } from './tasks/kick';
import { recordFailure } from './tasks/failures';

const HISTORY_LIMIT = 10;
/** Messages read at most to reach a long thread's end. */
const HISTORY_SCAN = 1000;

/** The installation a webhook names, and its repository when it has one. */
export interface Target {
  id: string;
  repo?: NonNullable<AgentEvent['repo']>;
  /** The app's own platform user. */
  self?: string;
  /** The covered account it happened in. */
  within?: string;
}

/** One of the app's installations in the workspace it is bound to; a removed one is none. */
async function boundInstallation(ctx: ServerContext, app: AgentApp, installationId: string) {
  const key = `${app.id}:${installationId}`;
  const tenant = await forInstallation(ctx, key);
  const installation =
    tenant?.boundInstallation?.installation.id === key
      ? tenant.boundInstallation.installation
      : await tenant?.store.get('installation', key);

  return { tenant, installation: installation?.deletedAt ? undefined : installation };
}

/** A token for one of the app's bound installations; an unbound or removed one gets none. */
async function boundToken(
  ctx: ServerContext,
  app: AgentApp,
  credentials: unknown,
  installationId: string,
  bound?: TokenBound,
): Promise<string> {
  const { tenant, installation } = await boundInstallation(ctx, app, installationId);
  if (!tenant || !installation)
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

/** Whether the app takes a plain message, from its agent's stored definition and without a platform call; a built-in app only when addressed by name, and an unknown agent counts as yes. */
async function hears(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  target: Target,
  text: string,
): Promise<boolean> {
  if (app.builtin) return addressedTo(text, app.agent) !== undefined;
  const type = raisedBy(integration, 'message');
  const tenant = await forInstallation(ctx, `${app.id}:${target.id}`);
  if (!type || !tenant) return false;
  // A local server reads its agents from disk at dispatch.
  if (tenant.local) return true;

  const { record, version } = await agentWithVersion(tenant.store, app.agent);
  if (!record || !version) return true;

  return (
    !record.settings?.disabled &&
    eventOptions(version.definition.integrations[integration.id], type) !== undefined
  );
}

/** Dispatch after the platform has its answer: a failure is logged, kept for the agent's Usage page, and told to its thread. */
export function later(
  ctx: ServerContext,
  app: AgentApp,
  event: AgentEvent,
  work: Promise<unknown>,
  replies?: Replies,
): void {
  const logged = work.catch(error => {
    console.error(`coder server: dispatch failed for ${app.id} event ${event.deliveryId}`, error);

    return recordFailure(
      ctx,
      app,
      error,
      event.installationId,
      event,
      () => replies ?? eventReplies(ctx, app, event),
    );
  });
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
  if (app.builtin && integration.app.builtin !== 'shared') return;
  const key = `${app.id}:${event.installationId}`;
  const tenant = await forInstallation(ctx, key);
  // A workspace's own app only ever serves that workspace.
  if (!tenant || (!app.builtin && tenant.organizationId !== ctx.organizationId)) return;
  const installation =
    tenant.boundInstallation?.installation.id === key
      ? tenant.boundInstallation.installation
      : await tenant.store.get('installation', key);
  // An installation that covers several accounts acts only in the ones granted to it.
  if (installation?.covers && !installation.covers.includes(event.within ?? '')) return;
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
  // Where the platform answers one message, the reply goes to the one that raised the event, not the thread's newest.
  const post = (text: string) =>
    message && thread.adapter.reply ? thread.reply(message, text) : thread.post(text);
  const marks = (
    thread.adapter as { postProblem?(threadId: string, text: string): Promise<unknown> }
  ).postProblem;

  return {
    post,
    problem: text => (marks ? marks.call(thread.adapter, thread.id, text) : post(text)),
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
  if (!event.chat)
    return { post: async () => {}, problem: async () => {}, whisper: async () => {} };
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
  // A shared app hears messages only when its agent is addressed, by its plain name too.
  const address =
    route === 'message' && app.builtin ? addressedTo(message.text, app.agent) : undefined;
  if (route === 'message' && app.builtin && address === undefined) return;
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
    ...(target.within ? { within: target.within } : {}),
    ...(target.repo ? { repo: target.repo } : {}),
    ...extra,
  };
}

/** The workspace a target's installation is bound to, when it may read it: a workspace's own app reads only its own, and an install only its granted accounts. */
async function workspace(ctx: ServerContext, app: AgentApp, target: Target) {
  const { tenant, installation } = await boundInstallation(ctx, app, target.id);
  const allowed =
    (app.builtin || tenant?.organizationId === ctx.organizationId) &&
    (!installation?.covers || installation.covers.includes(target.within ?? ''));

  return installation && allowed ? tenant : undefined;
}

/** The dashboard of `ctx`'s organization, for links an integration posts. */
export async function dashUrl(ctx: ServerContext): Promise<string | undefined> {
  const base = ctx.config.publicUrl?.replace(/\/$/, '');

  return base && `${base}${dashPath(await organizationSlug(ctx))}`;
}

/** What an app's integration gets for one request: tokens, and with a target, its workspace's agents and tasks; `dash` for its links. */
export function adapterContext(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  target?: Target,
  dash?: string,
): AdapterContext {
  return {
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
    installedSelf: async id => (await boundInstallation(ctx, app, id)).installation?.self,
    saveSelf: async (id, self) => {
      const { tenant, installation } = await boundInstallation(ctx, app, id);
      if (!tenant || !installation || installation.self) return;
      await updateMetadata(tenant.store, 'installation', installation.id, { self }).catch(error =>
        console.error(`coder server: could not save ${installation.id}'s app user`, error),
      );
    },
    ...(target
      ? {
          hears: text =>
            hears(ctx, integration, app, target, text).catch(error => {
              console.error(`coder server: could not read ${app.id}'s agent for a message`, error);
              return true;
            }),
          active: async thread => {
            const tenant = await forInstallation(ctx, `${app.id}:${target.id}`);
            const key = conversationKey(app.id, target.id, thread);

            return Boolean(await tenant?.store.get('delivery', key));
          },
          agent: async slug => {
            const tenant = await workspace(ctx, app, target);
            const { record, version } = tenant
              ? await agentWithVersion(tenant.store, slug ?? app.agent)
              : {};
            if (!record || !version) return undefined;
            const { definition } = version;
            const description = record.description ?? definition.description;

            return {
              slug: record.id,
              name: record.name,
              ...(description ? { description } : {}),
              listens: Object.entries(definition.integrations).flatMap(([id, wiring]) => {
                const events = definitionEvents(wiring);
                const known = ctx.integrations[id];
                return known && events.length
                  ? [{ integration: id, name: known.name, events }]
                  : [];
              }),
            };
          },
          task: async id => {
            const tenant = await workspace(ctx, app, target);
            const row = tenant && (await tenant.store.get('task', id));
            if (!row) return undefined;
            const { task } = row;
            const from = task.event?.integration;

            return {
              id: task.id,
              title:
                task.name?.trim() ||
                task.prompt?.trim() ||
                task.event?.text?.trim() ||
                `${task.event?.type ?? 'task'} on ${task.agent}`,
              agent: task.agent,
              status: row.status,
              from: (from && ctx.integrations[from]?.name) || task.source,
              startedAt: row.startedAt ?? row.createdAt,
            };
          },
        }
      : {}),
    privateState: () => new LocalChatState(),
    ...(ctx.config.publicUrl ? { publicUrl: ctx.config.publicUrl } : {}),
    ...(dash ? { dashUrl: dash } : {}),
  };
}

/** A Chat for one app, built per request so no adapter cache outlives it. */
export async function chatFor(ctx: ServerContext, app: AgentApp, target?: Target): Promise<Chat> {
  const integration = ctx.integrations[app.integration];
  if (!integration) throw new Error(`Unknown integration "${app.integration}"`);
  const credentials = decryptSecret(ctx.config, app.credentials);
  const adapter = await integration.adapter(
    adapterContext(ctx, integration, app, credentials, target),
  );
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
  // Dispatch continues after the handler so no webhook waits on it.
  const receive = async (route: ChatRoute, thread: Thread, message: Message, delivery?: string) => {
    const event = chatEvent(integration, app, target, route, thread, message, delivery);
    if (!event) return;
    const replies = threadReplies(thread, message.author, message);
    later(ctx, app, event, deliver(ctx, integration, app, credentials, event, replies), replies);
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
      ...(target.within ? { within: target.within } : {}),
    };
    const replies = { post: whisper, problem: whisper, whisper };
    later(ctx, app, event, deliver(ctx, integration, app, credentials, event, replies), replies);
  });
  return chat;
}
