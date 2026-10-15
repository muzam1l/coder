/** One task per conversation: its record, the messages the agent has not seen, and the batches that turn a burst into one steer or one resume. */
import { randomUUID } from 'node:crypto';

import type { SerializedThread } from 'chat';

import { definitionEvents } from '../../agent/definition';
import { eventPrompt, reactionsPrompt, SINCE_LIMIT } from '../../core/prompts';
import type { Agent, AgentApp, AgentEvent, TaskContext } from '../../agent/types';
import type { ConversationFacts, Integration, SinceMessage } from '../../integrations/types';
import type { ServerContext } from '../context';
import type { TaskStatus } from '../store/types';
import { continueTask, MAX_PROMPT_CHARS, TaskInputError } from './create';
import { kick } from './kick';
import { localTask, resumeLocalTask } from './local';
import { ACTIVE_STATES, addInbox, BatchClaimLost, readInbox, type BatchAdmission } from './queue';
import { conversationKey } from './thread';

export const CONVERSATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** A stopped task waits this long after the last message before it resumes, so a burst wakes it once. */
export const STEER_BATCH_MS = 5000;
/** Reactions in a running task's conversation are gathered this long before they go in as one steer. */
export const REACTION_BATCH_MS = 30_000;
/** A crashed sender releases its reservation after this lease. */
export const BATCH_LEASE_MS = 30_000;
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
  if (ctx.store.conversationState) return ctx.store.conversationState(key);
  const [record, unseen, batch] = await Promise.all([
    conversation(ctx, event),
    ctx.store.get<Unseen>('delivery', `since:${key}`),
    ctx.store.get<Batch>('delivery', `batch:${key}`),
  ]);
  const status = record && (await ctx.store.get('task', record.taskId));

  return { record, unseen, batch, ...(status?.task.flow === 'default' ? { status } : {}) };
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

export interface Reaction {
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

/** The conversation's record, when a task was started in it. */
export async function conversation(
  ctx: ServerContext,
  event: AgentEvent,
): Promise<Conversation | undefined> {
  return event.chat ? ctx.store.get<Conversation>('delivery', keyOf(event)) : undefined;
}

/** The conversation's task, when it still exists and takes steers; a review task never does. */
export async function conversationTask(
  ctx: ServerContext,
  event: AgentEvent,
): Promise<TaskStatus | undefined> {
  const record = await conversation(ctx, event);
  const status = record && (await ctx.store.get('task', record.taskId));

  return status?.task.flow === 'default' ? status : undefined;
}

/** Remembers a conversation's task and its root message, so later messages steer it and reactions on the root are recognized. */
export async function rememberConversation(
  ctx: ServerContext,
  event: AgentEvent,
  taskId: string,
  now: number,
): Promise<void> {
  const thread = event.chat?.thread;
  if (!thread) return;
  const record: Conversation = {
    at: now,
    taskId,
    ...(event.chat?.message ? { seen: event.chat.message.id } : {}),
  };
  const root = thread.id.slice((thread.channelId?.length ?? -1) + 1);

  await ctx.store.putMany(
    'delivery',
    [
      { id: keyOf(event), value: record },
      {
        id: knownKey(event.appId, event.installationId, channelOf(thread), root),
        value: { at: now },
      },
    ],
    { ttlMs: CONVERSATION_TTL_MS },
  );
}

/** Remembers a message Coder posted, so a reaction on it is recognized. */
export async function rememberPost(
  ctx: ServerContext,
  event: AgentEvent,
  message: string | string[],
  now: number,
): Promise<void> {
  const thread = event.chat?.thread;
  if (!thread) return;
  const messages = [...new Set([message].flat().filter(Boolean))];

  await ctx.store.putMany(
    'delivery',
    messages.map(message => ({
      id: knownKey(event.appId, event.installationId, channelOf(thread), message),
      value: { at: now },
    })),
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
  if (ctx.store.markConversation)
    return ctx.store.markConversation(
      keyOf(event),
      taskId,
      event.chat.message.id,
      now,
      CONVERSATION_TTL_MS,
    );
  const record = await conversation(ctx, event);
  if (record?.taskId !== taskId) return;

  await ctx.store.put(
    'delivery',
    keyOf(event),
    { ...record, at: now, seen: event.chat.message.id },
    { ttlMs: CONVERSATION_TTL_MS },
  );
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
  const through = event.conversation?.unseen;
  if (event.chat && through !== undefined)
    await ctx.store.acknowledgeUnseen(keyOf(event), through.version, through.epoch);
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
  const mention =
    integration.events[event.type]?.on === 'mention' || event.chat?.message?.isMention === true;
  const mustReply = direct || mention || integration.answersEveryPrompt === true;
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

/** Waits until `ms` have passed on the server's clock. */
async function settle(ctx: ServerContext, ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/** Adds to a conversation's batch, becoming its owner; the last writer takes it. */
async function appendBatch<T>(
  ctx: ServerContext,
  key: string,
  owner: string,
  items: T[],
  now: number,
): Promise<void> {
  await ctx.store.appendBatch(key, owner, items, now, BATCH_TTL_MS);
}

/** Reserves the batch while it is delivered; a later owner waits for its acknowledgement. */
async function takeBatch<T>(
  ctx: ServerContext,
  key: string,
  owner: string,
): Promise<Batch<T> | undefined> {
  const events = (ctx.store.batchEvents ??= new EventTarget());
  const name = `${ctx.organizationId}:${key}`;
  for (;;) {
    let wake!: () => void;
    const finished = new Promise<void>(resolve => (wake = resolve));
    events.addEventListener(name, wake, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const batch = await ctx.store.claimBatch(key, owner);
      if (batch !== null) return batch as Batch<T> | undefined;
      timer = setTimeout(wake, BATCH_LEASE_MS);
      await finished;
    } finally {
      clearTimeout(timer);
      events.removeEventListener(name, wake);
    }
  }
}

async function finishBatch(
  ctx: ServerContext,
  key: string,
  owner: string,
  accepted: boolean,
  through?: string,
): Promise<boolean> {
  try {
    return await ctx.store.finishBatch(key, owner, accepted, through);
  } finally {
    ctx.store.batchEvents?.dispatchEvent(new Event(`${ctx.organizationId}:${key}`));
  }
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
): Promise<boolean> {
  if (!ACTIVE_STATES.includes(status.status)) return false;
  // A started local turn that already ended counts as stopped, so a burst after it resumes it once.
  const turn =
    status.status !== 'queued' && runsHere(ctx, status.task)
      ? localTask(ctx.local!.cwd, status.task.id, false)
      : undefined;
  if (turn && !ACTIVE_STATES.includes(turn.status)) return false;

  return Boolean(
    await addInbox(
      ctx,
      status.task.id,
      'steer',
      { text },
      status.generation ?? 0,
      status.task,
      batch,
    ),
  );
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
): Promise<boolean> {
  const { task } = status;
  const context = { mustReply, admissions: { ...task.context?.admissions, ...admissions } };
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
): Promise<void> {
  const key = `batch:${keyOf(event)}`;
  const pending = state ? state.batch : await ctx.store.get<Batch>('delivery', key);
  if (!pending?.items.length && (await steerRunning(ctx, status, eventPrompt([event], user)))) {
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
  await appendBatch(ctx, key, owner, [{ admission: owner, event: compact, user }], now());
  await forgetUnseen(ctx, event);
  detach(
    ctx,
    (async () => {
      await settle(ctx, ctx.config.steerBatchMs ?? STEER_BATCH_MS);
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
          const steered = await steerRunning(ctx, fresh, text, { key, owner, through: admission });
          const accepted =
            steered ||
            (await resume(
              ctx,
              fresh,
              text,
              chunk.some(steer => steer.event.mustReply === true),
              { [kindOf(key)]: admission },
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
  await appendBatch(ctx, key, owner, [{ ...reaction, admission: owner }], now());
  detach(
    ctx,
    (async () => {
      await settle(ctx, ctx.config.reactionBatchMs ?? REACTION_BATCH_MS);
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
