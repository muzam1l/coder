/** Chat SDK per app and request: the app's adapter, its own slice of chat state, and the handlers that raise Coder events. */
import { createHash } from 'node:crypto';

import { Chat, Message, type SerializedMessage, type SerializedThread, type Thread } from 'chat';

import { definitionEvents, eventOptions } from '../agent/definition';
import { postReplyParts, reactToMessage } from '../agent/exec';
import { type AgentApp, type AgentEvent } from '../agent/types';
import { agentWithVersion } from './agents/records';
import { syncLocalAgents } from './store/local';
import type { AdapterContext, ChatRoute, Integration, TokenBound } from '../integrations/types';
import { forInstallation, type ServerContext } from './context';
import { appChatState, LocalChatState } from './store/chat';
import { decryptSecret } from './store/secrets';
import { updateMetadata } from './store';
import { installationToken, uninstall } from './tasks/context';
import { DELIVERY_TTL_MS, dispatchEvent, type Replies } from './tasks/events';
import { conversationKey } from './tasks/thread';
import { knownKey, reactToConversation, recordUnseen } from './tasks/conversation';
import { dashPath, organizationSlug } from './auth/account';
import { kick } from './tasks/kick';
import { recordFailure } from './tasks/failures';
import { answersShown } from './tasks/approvals';
import { homePage, linkCard, type AgentSummary, type TaskSummary } from './agents/pages';

/** The installation a webhook names, and its repository when it has one. */
export interface Target {
  id: string;
  repo?: NonNullable<AgentEvent['repo']>;
  /** The app's own platform user. */
  self?: string;
  /** The covered account it happened in. */
  within?: string;
  /** The message's position in its conversation, when the webhook states it. */
  index?: number;
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

/** The integration's event a Chat SDK handler raises; where several share a handler, the first, which the integration's `event()` refines. */
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
  type: string,
  text: string,
): Promise<boolean> {
  if (app.builtin) return addressedTo(text, app.agent) !== undefined;
  const tenant = await forInstallation(ctx, `${app.id}:${target.id}`);
  if (integration.events[type]?.on !== 'message' || !tenant) return false;
  // A local server's agents live on disk.
  if (tenant.local)
    await (
      tenant.syncAgent?.(app.agent) ??
      syncLocalAgents(tenant.store, tenant.local.cwd, tenant.integrations, app.agent)
    ).catch(error => console.error('coder server: local agent sync failed', error));

  const { record, version } = await agentWithVersion(tenant.store, app.agent);
  if (!record || !version) return true;

  return (
    !record.settings?.disabled &&
    eventOptions(version.definition.integrations[integration.id], type) !== undefined
  );
}

/** Dispatch after the platform has its answer: a failure is logged, kept for the agent's Usage page, and told to its thread when asked directly. */
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

/** One event into the workspace its installation is bound to, answered in its thread; a queued task is kicked once it lands, after `accepted`. */
export async function deliver(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  event: AgentEvent,
  replies: Replies,
  accepted?: () => Promise<void>,
): Promise<string | undefined> {
  if (app.builtin && !integration.app.shareable) return;
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
  if (!dispatched.taskId) return;

  await accepted?.();
  await kick(tenant, true, false, true);
  return dispatched.taskId;
}

/** Replies through a Chat SDK thread: public posts as Markdown in parts the platform accepts, and private ones only where the platform has them. */
export function threadReplies(
  thread: Thread,
  user?: Message['author'] | string,
  message?: Message | string,
  limit?: number,
  failed?: (error: unknown) => Promise<void>,
): Replies {
  // Where the platform answers one message, the reply goes to the one that raised the event, not the thread's newest.
  const post = async (text: string, progress = false) => {
    const sent = await postReplyParts(thread, text, limit, message, progress).catch(async error => {
      await failed?.(error);
      throw error;
    });

    return { id: sent.at(-1)?.id, ids: sent.map(message => message.id) };
  };
  const marks = (
    thread.adapter as {
      postProblem?(threadId: string, text: string): Promise<{ id?: string } | null | void>;
    }
  ).postProblem;

  return {
    post,
    react: (emoji, target) =>
      reactToMessage(
        thread,
        emoji,
        target ?? (typeof message === 'string' ? message : message?.id),
      ),
    problem: text => (marks ? marks.call(thread.adapter, thread.id, text) : post(text)),
    whisper: text =>
      user ? thread.postEphemeral(user, text, { fallbackToDM: false }) : Promise.resolve(null),
  };
}

/** The Chat SDK thread of an event that did not come through the adapter. */
export async function eventThread(
  ctx: ServerContext,
  app: AgentApp,
  event: AgentEvent,
): Promise<Thread> {
  if (!event.chat) throw new Error('The event has no conversation');
  const chat = await chatFor(ctx, app, {
    id: event.installationId,
    ...(event.repo ? { repo: event.repo } : {}),
  });
  await chat.initialize();

  return chat.thread(event.chat.thread.id);
}

/** Replies in the thread of an event that did not come through the adapter: GitHub pull requests, events sent by an admin. */
export async function eventReplies(
  ctx: ServerContext,
  app: AgentApp,
  event: AgentEvent,
): Promise<Replies> {
  if (!event.chat)
    return { post: async () => {}, problem: async () => {}, whisper: async () => {} };
  return threadReplies(
    await eventThread(ctx, app, event),
    event.actor.id || undefined,
    event.chat.message?.id || undefined,
    ctx.integrations[app.integration]?.replyLimit,
    error => failedPost(ctx, app, event.installationId, error),
  );
}

async function failedPost(ctx: ServerContext, app: AgentApp, installation: string, error: unknown) {
  if (!ctx.integrations[app.integration]?.isUninstalled?.(error)) return;
  const id = `${app.id}:${installation}`;
  const tenant = await forInstallation(ctx, id);
  if (tenant) await uninstall(tenant.store, id, (ctx.now ?? Date.now)());
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
  answers = false,
): AgentEvent | undefined {
  // A shared app hears messages only when its agent is addressed, by its plain name too; an answer to its own approval counts as addressed.
  const address =
    route !== 'message'
      ? undefined
      : answers
        ? message.text
        : app.builtin
          ? addressedTo(message.text, app.agent)
          : undefined;
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
    ...(target.index !== undefined ? { conversation: { index: target.index } } : {}),
    ...(target.within ? { within: target.within } : {}),
    ...(target.repo ? { repo: target.repo } : {}),
    ...extra,
  };
}

/** A message the app does not take, in a conversation with a task: kept for the agent's next turn under `since`. */
async function unseen(
  ctx: ServerContext,
  app: AgentApp,
  target: Target,
  thread: Thread,
  message: Message,
): Promise<void> {
  const tenant = await workspace(ctx, app, target).catch(error => {
    console.error('coder server: conversation workspace lookup failed', error);
    return undefined;
  });
  if (!tenant) return;
  const event: Pick<AgentEvent, 'appId' | 'installationId' | 'chat'> = {
    appId: app.id,
    installationId: target.id,
    chat: { thread: stored(thread.toJSON()) },
  };

  await recordUnseen(tenant, event as AgentEvent, {
    author: message.author.userName || message.author.userId,
    text: message.text,
    sentAt: message.metadata.dateSent.toISOString(),
  }).catch(error => console.error(`coder server: could not keep a message for ${app.id}`, error));
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

/** What an app's integration gets for one request: tokens, and with a target, its home page and link cards; `dash` for their links. */
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
          hears: (type, text) =>
            hears(ctx, integration, app, target, type, text).catch(error => {
              console.error(`coder server: could not read ${app.id}'s agent for a message`, error);
              return true;
            }),
          active: async thread => {
            const tenant = await forInstallation(ctx, `${app.id}:${target.id}`);
            const key = conversationKey(app.id, target.id, thread);

            return Boolean(await tenant?.store.get('delivery', key));
          },
          knows: async (channel, message) => {
            const tenant = await forInstallation(ctx, `${app.id}:${target.id}`);
            const key = knownKey(app.id, target.id, channel, message);

            return Boolean(await tenant?.store.get('delivery', key));
          },
          home: async () => {
            const base = ctx.config.publicUrl;
            if (!base || !dash) return undefined;
            const agent = await agentSummary(ctx, app, target);

            return homePage(integration, { home: base, dash }, app.name, agent);
          },
          preview: async url =>
            dash
              ? linkCard(integration, dash, url, {
                  agent: slug => agentSummary(ctx, app, target, slug),
                  task: id => taskSummary(ctx, app, target, id),
                })
              : undefined,
        }
      : {}),
    privateState: () => new LocalChatState(),
  };
}

/** An agent of the workspace the installation is bound to, the app's own by default. */
export async function agentSummary(
  ctx: ServerContext,
  app: AgentApp,
  target: Target,
  slug?: string,
): Promise<AgentSummary | undefined> {
  const tenant = await workspace(ctx, app, target);
  const { record, version } = tenant ? await agentWithVersion(tenant.store, slug ?? app.agent) : {};
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
      return known && events.length ? [{ integration: id, name: known.name, events }] : [];
    }),
  };
}

/** A task of the workspace the installation is bound to; none for any other. */
async function taskSummary(
  ctx: ServerContext,
  app: AgentApp,
  target: Target,
  id: string,
): Promise<TaskSummary | undefined> {
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
}

/** A Chat for one app, built per request so no adapter cache outlives it. */
export async function chatFor(ctx: ServerContext, app: AgentApp, target?: Target): Promise<Chat> {
  const integration = ctx.integrations[app.integration];
  if (!integration) throw new Error(`Unknown integration "${app.integration}"`);
  const synced = new Map<string, Promise<unknown>>();
  ctx = {
    ...ctx,
    fetch:
      integration.requestFetch?.(ctx.fetch ?? fetch, target?.within ?? target?.id) ?? ctx.fetch,
    syncAgent: slug => {
      if (!synced.has(slug))
        synced.set(slug, syncLocalAgents(ctx.store, ctx.local!.cwd, ctx.integrations, slug));
      return synced.get(slug)!;
    },
  };
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
    const answers =
      route === 'message' && (await answersShown(ctx, app, target, thread.id, message.text));
    const event = chatEvent(integration, app, target, route, thread, message, delivery, answers);
    if (!event) {
      if (message.author.isBot !== true) await unseen(ctx, app, target, thread, message);
      return;
    }
    const replies = threadReplies(thread, message.author, message, integration.replyLimit, error =>
      failedPost(ctx, app, target.id, error),
    );
    later(ctx, app, event, deliver(ctx, integration, app, credentials, event, replies), replies);
  };
  chat.onNewMention((thread, message) => receive('mention', thread, message));
  chat.onNewMessage(/[\s\S]*/, (thread, message) => receive('message', thread, message));
  // An edit steers like a new message.
  chat.onMessageUpdated((thread, message) =>
    receive(
      message.isMention ? 'mention' : 'message',
      thread,
      message,
      `edit\n${message.id}\n${message.metadata.editedAt?.toISOString() ?? ''}`,
    ),
  );
  // Reactions raise no event; those in a running task's conversation are gathered into one steer.
  chat.onReaction(async reaction => {
    if (!reaction.added || reaction.user.isBot === true) return;
    const thread = reaction.thread as Thread;
    const tenant = await workspace(ctx, app, target);
    if (!tenant) return;
    const event: AgentEvent = {
      integration: integration.id,
      type: 'reactions',
      appId: app.id,
      installationId: target.id,
      deliveryId: `reaction-${reaction.messageId}-${reaction.user.userId}-${reaction.rawEmoji}`,
      actor: { id: reaction.user.userId, login: reaction.user.userName },
      text: '',
      chat: { thread: stored(thread.toJSON()) },
      ...(target.within ? { within: target.within } : {}),
    };
    const work = reactToConversation(
      tenant,
      event,
      {
        emoji: `:${reaction.emoji.name}:`,
        by: reaction.user.userName || reaction.user.userId,
        on: reaction.message?.text ?? reaction.messageId,
      },
      ctx.now ?? Date.now,
    );
    later(ctx, app, event, work);
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
