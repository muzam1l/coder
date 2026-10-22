/** One task per conversation: its record, the messages the agent has not seen, and the batches that turn a burst into one steer or one resume. */
import { randomUUID } from 'node:crypto';

import type { SerializedThread } from 'chat';

import { definitionEvents } from '../../agent/definition';
import { eventPrompt, reactionsPrompt, SINCE_LIMIT } from '../../agent/context/turn';
import type { Agent, AgentApp, AgentEvent, TaskContext } from '../../agent/types';
import type { ConversationFacts, Integration, SinceMessage } from '../../integrations/types';
import type { ServerContext } from '../context';
import type { TaskStatus } from '../store/types';
import { continueTask, MAX_PROMPT_CHARS, TaskInputError } from './create';
import { kick } from './kick';
import { localTask, resumeLocalTask } from './local';
import { ACTIVE_STATES, addInbox, BatchClaimLost, readInbox, type BatchAdmission } from './queue';

export const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A stopped task waits this long after the last message before it resumes, so a burst wakes it once. */
const STEER_BATCH_MS = 5000;
/** Reactions in a running task's conversation are gathered this long before they go in as one steer. */
const REACTION_BATCH_MS = 30_000;
/** An unclaimed batch outlives any wait; the next message in its conversation takes it. */
const BATCH_TTL_MS = 60 * 60 * 1000;

/** The task of a conversation and the id of the last message the agent saw there. */
export interface Conversation {
  at: number;
  taskId: string;
  seen?: string;
}

/** Messages past the agent's last turn that Coder received but did not forward, under `since:<conversation>`. */
export interface Unseen {
  messages: (SinceMessage & { sequence?: number })[];
  more: number;
  version?: number;
  epoch?: string;
  acknowledged?: number;
}

export interface ConversationState {
  record?: Conversation;
  unseen?: Unseen;
  status?: TaskStatus;
  batch?: Batch;
}

export async function conversationState(
  ctx: ServerContext,
  event: AgentEvent,
): Promise<ConversationState> {
  if (!event.chat) return {};
  const key = keyOf(event);
  return ctx.store.conversationState(key);
}

/** A burst gathering under `batch:<conversation>` or `reactions:<conversation>`; the last writer owns it. */
export interface Batch<T = unknown> {
  owner: string;
  at: number;
  items: T[];
  more?: number;
  mustReply?: boolean;
  sending?: { owner: string; count: number; until?: number; more?: number; mustReply?: boolean };
}

interface Reaction {
  emoji: string;
  by: string;
  on: string;
}

const keyOf = (event: AgentEvent) =>
  conversationKey(event.appId, event.installationId, event.chat!.thread.id);

type BatchKind = keyof NonNullable<TaskContext['admissions']>;

const kindOf = (key: string) => key.slice(0, key.indexOf(':')) as BatchKind;

/** The platform's own channel id of a thread, as a reaction names it. */
const channelOf = (thread: SerializedThread) =>
  thread.channelId?.slice((thread.adapterName?.length ?? -1) + 1) ?? '';

/** A platform message id as Coder knows it: `known:<app>:<installation>:<channel>:<message>`. */
export function knownKey(
  appId: string,
  installationId: string,
  channel: string,
  message: string,
): string {
  return `known:${appId}:${installationId}:${channel}:${message}`;
}

/** The conversation's task, when it still exists and takes steers; a review task never does. */
export async function conversationTask(
  ctx: ServerContext,
  event: AgentEvent,
): Promise<TaskStatus | undefined> {
  return event.chat ? (await ctx.store.conversationState(keyOf(event))).status : undefined;
}

/** What remembering a conversation writes: its record under the thread key, and its root message as known. */
export function conversationRecord(
  event: AgentEvent,
  taskId: string,
  now: number,
): { key: string; record: Conversation; root: string; ttlMs: number } | undefined {
  const thread = event.chat?.thread;
  if (!thread) return undefined;
  const root = thread.id.slice((thread.channelId?.length ?? -1) + 1);

  return {
    key: keyOf(event),
    record: { at: now, taskId, ...(event.chat?.message ? { seen: event.chat.message.id } : {}) },
    root: knownKey(event.appId, event.installationId, channelOf(thread), root),
    ttlMs: CONVERSATION_TTL_MS,
  };
}

/** Remembers a conversation's task and its root message, so later messages steer it and reactions on the root are recognized. */
export async function rememberConversation(
  ctx: ServerContext,
  event: AgentEvent,
  taskId: string,
  now: number,
): Promise<void> {
  const written = conversationRecord(event, taskId, now);
  if (!written) return;

  await ctx.store.putMany(
    'delivery',
    [
      { id: written.key, value: written.record },
      { id: written.root, value: { at: now } },
    ],
    { ttlMs: CONVERSATION_TTL_MS },
  );
}

/** The known-message keys of messages Coder posted in the event's thread. */
export function knownPosts(event: AgentEvent, message: string | string[]): string[] {
  const thread = event.chat?.thread;
  if (!thread) return [];

  return [...new Set([message].flat().filter(Boolean))].map(message =>
    knownKey(event.appId, event.installationId, channelOf(thread), message),
  );
}

/** Remembers a message Coder posted, so a reaction on it is recognized. */
export async function rememberPost(
  ctx: ServerContext,
  event: AgentEvent,
  message: string | string[],
  now: number,
): Promise<void> {
  await ctx.store.putMany(
    'delivery',
    knownPosts(event, message).map(id => ({ id, value: { at: now } })),
    { ttlMs: CONVERSATION_TTL_MS },
  );
}

async function markSeen(
  ctx: ServerContext,
  event: AgentEvent,
  taskId: string,
  now: number,
): Promise<void> {
  if (!event.chat?.message) return;
  return ctx.store.markConversation(
    keyOf(event),
    taskId,
    event.chat.message.id,
    now,
    CONVERSATION_TTL_MS,
  );
}

/** What `forgetUnseen` acknowledges, as a new task's admission records it. */
export function unseenAcknowledgement(
  event: AgentEvent,
): { key: string; version: number; epoch?: string } | undefined {
  const through = event.conversation?.unseen;
  return event.chat && through !== undefined
    ? {
        key: keyOf(event),
        version: through.version,
        ...(through.epoch ? { epoch: through.epoch } : {}),
      }
    : undefined;
}

/** Records a message of a conversation with a task that reached Coder but not the agent, for the next turn's `since`. */
export async function recordUnseen(
  ctx: ServerContext,
  event: AgentEvent,
  message: SinceMessage,
): Promise<void> {
  await ctx.store.appendUnseen(keyOf(event), message, CONVERSATION_TTL_MS);
}

/** Acknowledges only the unseen snapshot carried by the delivered event. */
export async function forgetUnseen(ctx: ServerContext, event: AgentEvent): Promise<void> {
  const through = unseenAcknowledgement(event);
  if (through) await ctx.store.acknowledgeUnseen(through.key, through.version, through.epoch);
}

/** Whether the app receives every message in this conversation. */
export function everyMessageDelivered(
  integration: Integration,
  app: AgentApp,
  agent: Agent,
): boolean {
  const wired = definitionEvents(agent.definition.integrations[integration.id]);

  return (
    !app.builtin &&
    Object.entries(integration.events).some(([name, spec]) => spec.noisy && wired.includes(name))
  );
}

/** Whether someone asked the agent directly: a mention, a 1:1 direct message or a command. */
export function directAsk(integration: Integration, event: AgentEvent): boolean {
  const on = integration.events[event.type]?.on;

  return (
    on === 'mention' ||
    on === 'command' ||
    event.chat?.thread.isDM === true ||
    event.chat?.message?.isMention === true ||
    event.mentioned === true
  );
}

/** The event as the agent reads it: whether it must reply, where the message sits, and what was said since its last turn. */
export async function describe(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  input: {
    token(): Promise<string | undefined>;
    delivered: boolean;
    existing?: Conversation;
    unseen?: Unseen;
    loaded?: boolean;
  },
): Promise<AgentEvent> {
  const thread = event.chat?.thread;
  if (!thread) return event;
  const direct = thread.isDM === true;
  const mustReply =
    directAsk(integration, event) || integration.answersEveryPrompt?.(event) === true;
  const [unseen, facts] = await Promise.all([
    input.loaded
      ? (input.unseen ?? { messages: [], more: 0 })
      : ctx.store
          .get<Unseen>('delivery', `since:${keyOf(event)}`)
          .then(value => value ?? { messages: [], more: 0 }),
    integration.conversation
      ? integration
          .conversation(event, {
            token: input.token,
            fetch: ctx.fetch ?? fetch,
            delivered: input.delivered,
            ...(input.existing?.seen ? { after: input.existing.seen } : {}),
          })
          .catch((error: unknown): ConversationFacts => {
            console.error(`coder server: ${integration.id} conversation facts failed`, error);

            return {};
          })
      : ({} as ConversationFacts),
  ]);
  // A recorded message the hook fetched again counts once.
  const recorded = new Set(unseen.messages.flatMap(message => message.id ?? []));
  const fetched = new Map(
    facts.since?.flatMap(message => (message.id ? [[message.id, message] as const] : [])),
  );
  const all = [
    ...unseen.messages.map(
      ({ sequence: _sequence, ...message }) => (message.id && fetched.get(message.id)) || message,
    ),
    ...(facts.since ?? []).filter(message => !message.id || !recorded.has(message.id)),
  ];
  const since = all.slice(0, SINCE_LIMIT);
  const more = (facts.since ? 0 : unseen.more) + all.length - since.length;
  // A first turn's position: from the hook, else from the webhook itself; later turns carry `since`.
  const index = input.existing || direct ? undefined : (facts.index ?? event.conversation?.index);

  return {
    ...event,
    mustReply,
    conversation: {
      ...(index !== undefined ? { index } : {}),
      ...(unseen.messages.length || unseen.more
        ? {
            unseen: {
              version: unseen.version ?? unseen.messages.length + unseen.more,
              epoch: unseen.epoch,
            },
          }
        : {}),
      ...(since.length ? { since } : {}),
      ...(more ? { more } : {}),
    },
  };
}

/** Reserves the batch while it is delivered; a later owner waits for its acknowledgement. */
async function takeBatch<T>(
  ctx: ServerContext,
  key: string,
  owner: string,
): Promise<Batch<T> | undefined> {
  for (;;) {
    const batch = await ctx.store.claimBatch(key, owner);
    if (batch !== null) return batch as Batch<T> | undefined;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function finishBatch(
  ctx: ServerContext,
  key: string,
  owner: string,
  accepted: boolean,
  through?: string,
): Promise<boolean> {
  return ctx.store.finishBatch(key, owner, accepted, through);
}

/** The task as it is now, and how many leading items of the claimed batch it already holds: admitted into its record by a steer or resume, or waiting in an inbox entry. */
async function admittedThrough(
  ctx: ServerContext,
  status: TaskStatus,
  key: string,
  items: { admission: string }[],
): Promise<{ fresh: TaskStatus; through: number }> {
  const fresh = (await ctx.store.get('task', status.task.id)) ?? status;
  const kind = kindOf(key);
  const entries = await readInbox(ctx, status.task.id, -1, fresh.generation ?? 0);
  const held = new Set([
    fresh.task.context?.admissions?.[kind],
    ...entries.map(
      entry =>
        (entry.value as { admissions?: TaskContext['admissions'] } | null)?.admissions?.[kind],
    ),
  ]);
  const through = items.reduce(
    (last, item, index) => (held.has(item.admission) ? index + 1 : last),
    0,
  );

  return { fresh, through };
}

/** A steer into a task that still runs; nothing when it stopped first. */
async function steerRunning(
  ctx: ServerContext,
  status: TaskStatus,
  text: string,
  batch?: BatchAdmission,
  asker?: string | null,
): Promise<boolean> {
  if (!ACTIVE_STATES.includes(status.status)) return false;
  // A started local turn that already ended counts as stopped, so a burst after it resumes it once.
  const turn =
    status.status !== 'queued' && runsHere(ctx, status.task)
      ? localTask(ctx.local!.cwd, status.task.id, false)
      : undefined;
  if (turn && !ACTIVE_STATES.includes(turn.status)) return false;

  // A message's author, `null` when unknown; only its owner's messages keep a Just me connection this turn.
  const value = asker === undefined ? { text } : { text, asker };

  return Boolean(await addInbox(ctx, status, 'steer', value, batch));
}

/** Whether the task runs as a CLI task on this local server. */
const runsHere = (ctx: ServerContext, task: TaskStatus['task']) =>
  Boolean(ctx.local) && !task.event?.repo && task.runner === 'local' && !task.runnerId;

/** A stopped task resumes with the same engine history and this turn's reply requirement: locally in place, hosted through `continueTask`; false when another sender resumed it first. */
async function resume(
  ctx: ServerContext,
  status: TaskStatus,
  text: string,
  mustReply: boolean,
  admissions: TaskContext['admissions'],
  asker: string | undefined,
): Promise<boolean> {
  const { task } = status;
  const context = { mustReply, admissions: { ...task.context?.admissions, ...admissions }, asker };
  if (runsHere(ctx, task))
    return resumeLocalTask(ctx, ctx.local!.cwd, task.id, text, undefined, {}, context);
  try {
    await continueTask(
      ctx,
      { ...status, task: { ...task, context: { ...task.context, ...context } } },
      text,
    );
  } catch (error) {
    if (error instanceof TaskInputError && error.status === 409) return false;
    throw error;
  }
  return true;
}

/** Runs the wait and what follows off the request, where the server keeps it alive. */
function detach(ctx: ServerContext, work: Promise<void>): void {
  const logged = work.catch(error =>
    console.error('coder server: conversation batch failed', error),
  );
  if (ctx.waitUntil) ctx.waitUntil(logged);
}

interface Steer {
  admission: string;
  event: AgentEvent;
  user?: TaskContext['user'];
  asker?: string;
}

function steerDelivery(batch: Steer[]): { text: string; count: number } {
  const render = (count: number) =>
    eventPrompt(
      batch.slice(0, count).map(steer => steer.event),
      batch[count - 1]!.user,
    );
  let text = render(1);
  if (text.length > MAX_PROMPT_CHARS) {
    let event = batch[0]!.event;
    const clipped = (length: number) =>
      eventPrompt(
        [{ ...event, text: event.text.slice(0, length) + '\n[message truncated]' }],
        batch[0]!.user,
      );
    if (clipped(0).length > MAX_PROMPT_CHARS)
      event = {
        ...event,
        conversation: {
          ...event.conversation,
          since: undefined,
          more: (event.conversation?.more ?? 0) + (event.conversation?.since?.length ?? 0),
        },
        promptContext: undefined,
        chat: event.chat
          ? {
              thread: event.chat.thread,
              message: event.chat.message
                ? { ...event.chat.message, attachments: [], links: [] }
                : undefined,
            }
          : undefined,
      };
    let low = 0;
    let high = event.text.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (clipped(middle).length <= MAX_PROMPT_CHARS) low = middle;
      else high = middle - 1;
    }

    return { text: clipped(low), count: 1 };
  }
  let count = 1;
  while (count < batch.length) {
    const next = render(count + 1);
    if (next.length > MAX_PROMPT_CHARS) break;
    text = next;
    count++;
  }

  return { text, count };
}

/** A message for a conversation's task: a running task takes it at its next turn; a stopped one resumes once the burst settles, every message in one event. */
export async function steerConversation(
  ctx: ServerContext,
  status: TaskStatus,
  event: AgentEvent,
  user: TaskContext['user'] | undefined,
  now: () => number,
  state?: ConversationState,
  asker?: string,
): Promise<void> {
  const key = `batch:${keyOf(event)}`;
  const pending = state ? state.batch : await ctx.store.get<Batch>('delivery', key);
  if (
    !pending?.items.length &&
    (await steerRunning(ctx, status, eventPrompt([event], user), undefined, asker ?? null))
  ) {
    await forgetUnseen(ctx, event);
    await markSeen(ctx, event, status.task.id, now());
    return;
  }
  const owner = randomUUID();
  const message = event.chat?.message;
  const compact = message
    ? {
        ...event,
        chat: {
          thread: event.chat!.thread,
          message: {
            ...message,
            formatted: { type: 'root' as const, children: [] },
            raw: null,
            attachments: message.attachments.map(({ type, url, name }) => ({
              type,
              ...(url ? { url } : {}),
              ...(name ? { name } : {}),
            })),
          },
        },
      }
    : event;
  await ctx.store.appendBatch(
    key,
    owner,
    [{ admission: owner, event: compact, user, ...(asker ? { asker } : {}) }],
    now(),
    BATCH_TTL_MS,
  );
  await forgetUnseen(ctx, event);
  detach(
    ctx,
    (async () => {
      await new Promise(resolve => setTimeout(resolve, ctx.config.steerBatchMs ?? STEER_BATCH_MS));
      const taken = await takeBatch<Steer>(ctx, key, owner);
      if (!taken) return;
      const batch = taken.items.map((steer, index) =>
        index === taken.items.length - 1
          ? {
              ...steer,
              event: {
                ...steer.event,
                mustReply: steer.event.mustReply || taken.mustReply,
                conversation: {
                  ...steer.event.conversation,
                  more: (steer.event.conversation?.more ?? 0) + (taken.more ?? 0),
                },
              },
            }
          : steer,
      );
      let finished = false;
      let delivered = false;
      let overtaken = false;
      try {
        for (let offset = 0; offset < batch.length;) {
          const { fresh, through } = await admittedThrough(ctx, status, key, batch);
          if (through > offset) {
            delivered = true;
            if (!(await finishBatch(ctx, key, owner, true, batch[through - 1]!.admission))) return;
            offset = through;
            continue;
          }
          const { text, count } = steerDelivery(batch.slice(offset));
          const chunk = batch.slice(offset, offset + count);
          const admission = chunk.at(-1)!.admission;
          const author = chunk.every(steer => steer.asker === chunk[0]!.asker)
            ? chunk[0]!.asker
            : undefined;
          const steered = await steerRunning(
            ctx,
            fresh,
            text,
            { key, owner, through: admission },
            author ?? null,
          );
          const accepted =
            steered ||
            (await resume(
              ctx,
              fresh,
              text,
              chunk.some(steer => steer.event.mustReply === true),
              { [kindOf(key)]: admission },
              chunk.at(-1)!.asker,
            ));
          // A sender past its lease resumed the task first: its turn holds the leading messages, the rest go in as steers.
          if (!accepted && !overtaken) {
            overtaken = true;
            continue;
          }
          if (!accepted) throw new Error('Conversation task did not accept the batch');
          delivered = true;
          if (!steered && !(await finishBatch(ctx, key, owner, true, admission))) return;
          await markSeen(ctx, chunk.at(-1)!.event, status.task.id, now());
          offset += count;
        }
        finished = true;
      } catch (error) {
        if (!(error instanceof BatchClaimLost)) throw error;
      } finally {
        if (!finished) await finishBatch(ctx, key, owner, false);
        if (delivered) await kick(ctx, true, false, true);
      }
    })(),
  );
}

/** A reaction in a conversation whose task runs: gathered with the others for a while, then one steer; a stopped task is left alone. */
export async function reactToConversation(
  ctx: ServerContext,
  event: AgentEvent,
  reaction: Reaction,
  now: () => number,
): Promise<void> {
  const status = await conversationTask(ctx, event);
  if (!status || !ACTIVE_STATES.includes(status.status)) return;
  const key = `reactions:${keyOf(event)}`;
  const owner = randomUUID();
  await ctx.store.appendBatch(key, owner, [{ ...reaction, admission: owner }], now(), BATCH_TTL_MS);
  detach(
    ctx,
    (async () => {
      await new Promise(resolve =>
        setTimeout(resolve, ctx.config.reactionBatchMs ?? REACTION_BATCH_MS),
      );
      const batch = await takeBatch<Reaction & { admission: string }>(ctx, key, owner);
      if (!batch) return;
      let accepted = false;
      try {
        const { fresh, through } = await admittedThrough(ctx, status, key, batch.items);
        const items = batch.items.slice(through);
        if (
          through &&
          !(await finishBatch(ctx, key, owner, true, batch.items[through - 1]!.admission))
        )
          return;
        if (!items.length) {
          accepted = true;
          return;
        }
        const grouped = new Map<string, { emoji: string; by: string[]; on: string }>();
        for (const { emoji, by, on } of items) {
          const group = grouped.get(`${emoji}\n${on}`) ?? { emoji, by: [], on };
          if (!group.by.includes(by)) group.by.push(by);
          grouped.set(`${emoji}\n${on}`, group);
        }
        accepted = await steerRunning(
          ctx,
          fresh,
          reactionsPrompt({ ...event, conversation: { ...event.conversation, more: batch.more } }, [
            ...grouped.values(),
          ]),
          { key, owner, through: items.at(-1)!.admission },
        );
      } catch (error) {
        if (!(error instanceof BatchClaimLost)) throw error;
      } finally {
        if (!accepted) await finishBatch(ctx, key, owner, false);
      }
    })(),
  );
}

// Conversation context the receiver gathers before dispatch.

/** A thread Coder started a task in, so later plain messages there are a conversation. */
export function conversationKey(appId: string, installationId: string, thread: string): string {
  return `thread:${appId}:${installationId}:${thread}`;
}

/** Who asked, best-effort. */
export async function buildContext(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  member?: { id: string; name: string; email: string } | null,
): Promise<TaskContext> {
  const context: TaskContext = {};
  const linked =
    member === undefined && ctx.auth && event.actor.id
      ? await ctx.auth.linkedUser(integration.id, event.actor.id).catch(() => undefined)
      : member;
  if (linked) {
    context.user = { name: linked.name, email: linked.email };
    context.asker = linked.id;
  }

  return context;
}
