/** @jsxImportSource contextjsx */
/** An agent turn's messages: events, requests, history and rollover. */
import { Data, render } from 'contextjsx';

import type { AgentEvent, TaskContext } from '../types';

// Event JSON (agent/exec, server/tasks).

type EventAuthor = { id: string; handle?: string; name?: string };

export type EventJson = {
  event?: string;
  mustReply?: boolean;
  message?: { id?: string; text?: string; author: EventAuthor };
  messages?: Array<{ id?: string; text?: string; author: EventAuthor }>;
  reactions?: Array<{ emoji: string; by: string[] }>;
};

export const unxml = (text: string) =>
  text.replace(
    /&(amp|lt|gt);/g,
    (_, name: 'amp' | 'lt' | 'gt') => ({ amp: '&', lt: '<', gt: '>' })[name],
  );

/** Read event JSON, optionally alongside a turn's history or other text. */
export function eventJsons(prompt = '', embedded = false): EventJson[] | undefined {
  const event = /<event>\n([^]*?)\n<\/event>/g;
  if (!embedded && (!prompt.trimStart().startsWith('<event>') || prompt.replace(event, '').trim()))
    return;
  const events: EventJson[] = [];
  for (const [, body] of prompt.matchAll(event)) {
    try {
      const json = JSON.parse(unxml(body!));
      if (!json || typeof json !== 'object' || Array.isArray(json)) {
        if (!embedded) return;
        continue;
      }
      events.push(json);
    } catch (error) {
      console.error('coder: unreadable event prompt', error);
      if (!embedded) return;
    }
  }

  return events.length ? events : undefined;
}

/** Any event in a turn or its live steers can require a reply. */
export function replyRequired(
  prompt?: string | null,
  fallback?: boolean,
  steers: string[] = [],
): boolean | undefined {
  const asks = [prompt ?? '', ...steers].flatMap(text =>
    (eventJsons(text, true) ?? []).flatMap(json =>
      typeof json.mustReply === 'boolean' ? [json.mustReply] : [],
    ),
  );

  return asks.length ? asks.includes(true) : fallback;
}

/** `since` holds at most this many messages; past that the agent is told how many more there are. */
export const SINCE_LIMIT = 50;

/** One message as the event JSON carries it: id, position, text with the address removed, author, time. */
function messageJson(event: AgentEvent) {
  const message = event.chat?.message;
  if (!message)
    return {
      text: event.text,
      author: { id: event.actor.id, ...(event.actor.login ? { handle: event.actor.login } : {}) },
    };
  const { author, metadata } = message;

  return {
    id: message.id,
    ...(event.conversation?.index !== undefined ? { index: event.conversation.index } : {}),
    text: event.text,
    mention: message.isMention === true,
    author: {
      id: author.userId,
      handle: author.userName,
      name: author.fullName,
      bot: author.isBot === true,
    },
    sentAt: metadata.dateSent,
    ...(metadata.edited ? { edited: true } : {}),
    ...(message.attachments.length
      ? {
          attachments: message.attachments.map(({ type, url, name }) => ({
            type,
            ...(url ? { url } : {}),
            ...(name ? { name } : {}),
          })),
        }
      : {}),
    ...(message.links?.length
      ? { links: message.links.map(({ url, title }) => ({ url, ...(title ? { title } : {}) })) }
      : {}),
  };
}

/** The JSON of one turn: the newest event names the conversation, every event in the turn is a message. */
export function eventJson(
  events: AgentEvent[],
  user?: TaskContext['user'],
): Record<string, unknown> {
  const event = events.at(-1)!;
  const thread = event.chat?.thread;
  const mustReply = events.some(each => each.mustReply);
  // Every event's unseen messages once, without the turn's own.
  const seen = new Set(events.flatMap(each => each.chat?.message?.id ?? []));
  const unseen = events
    .flatMap(each => each.conversation?.since ?? [])
    .filter(({ id, ...message }) => {
      const key = id ?? JSON.stringify(message);
      return !seen.has(key) && Boolean(seen.add(key));
    });
  const since = unseen.slice(0, SINCE_LIMIT).map(({ id: _id, ...message }) => message);
  const more =
    events.reduce((total, each) => total + (each.conversation?.more ?? 0), 0) +
    unseen.length -
    since.length;

  return {
    handle: event.integration,
    event: event.type,
    ...(event.mustReply === undefined && events.length === 1 ? {} : { mustReply }),
    ...(event.repo ? { repository: `${event.repo.owner}/${event.repo.name}` } : {}),
    ...(thread
      ? {
          conversation: {
            id: thread.id,
            dm: thread.isDM,
            ...(thread.channelVisibility ? { visibility: thread.channelVisibility } : {}),
          },
        }
      : {}),
    ...(events.length === 1
      ? { message: messageJson(event) }
      : { messages: events.map(messageJson) }),
    ...(event.promptContext ? { context: event.promptContext } : {}),
    ...(since.length ? { since } : {}),
    ...(more ? { more } : {}),
    ...(user ? { requester: user } : {}),
  };
}

// Turn messages (agent/exec, server/tasks).

/** The user prompt of a platform turn: one `<event>` holding the turn's JSON. */
export function eventPrompt(events: AgentEvent[], user?: TaskContext['user']): string {
  return render(
    <event>
      <Data>{JSON.stringify(eventJson(events, user))}</Data>
    </event>,
  );
}

/** Reactions gathered while a task runs, as one turn: emoji, who, and the message they are on. */
export function reactionsPrompt(
  event: AgentEvent,
  reactions: Array<{ emoji: string; by: string[]; on: string }>,
): string {
  const { message: _message, ...base } = eventJson([event]);
  const json = { ...base, event: 'reactions', mustReply: false, reactions };

  return render(
    <event>
      <Data>{JSON.stringify(json)}</Data>
    </event>,
  );
}

/** A dashboard or CLI prompt; its repository leads it, and a selected pull request is named for the tools. */
export function requestPrompt(prompt: string, repo?: AgentEvent['repo'], pr?: number): string {
  if (!repo) return prompt;
  const pull = pr === undefined ? '' : `\n**Pull request:** ${repo.owner}/${repo.name}#${pr}`;
  return `**Repo:** ${repo.owner}/${repo.name}${pull}\n\n${prompt}`;
}

/** Earlier messages pasted before a turn when the engine conversation holding them is gone. */
export function historyPrompt(
  messages: NonNullable<TaskContext['messages']>,
  prompt: string,
): string {
  if (!messages.length) return prompt;
  const earlier = render(
    <history>
      <Data>{messages.map(m => `${m.user}: ${m.text}`).join('\n')}</Data>
    </history>,
  );

  return `${earlier}\n\n${prompt}`;
}

// Conversation rollover (core/task/worker).

/** The private turn that asks the old conversation for its summary. */
export const SUMMARY_REQUEST = render(
  <summary-request>
    {[
      'Summarize this conversation so a new engine conversation can continue it. Return only the summary: no tools, no reply to the platform.',
      'Use these headings in order, each even if empty: Goal; Decisions; Preferences and constraints; Files and PRs touched; Open items.',
      'Name who asked for or decided each thing. Keep durable facts, including any earlier summary. Leave out details a speaker asked to forget, without quoting them.',
    ]
      .filter(Boolean)
      .join('\n')}
  </summary-request>,
);

/** The new conversation's first turn: the summary and the recent turns word for word, then the turn itself. */
export function rolloverPrompt(
  rollover: { summary: string; recent: string },
  prompt: string,
): string {
  const earlier = render(
    <>
      <summary>
        <Data>{rollover.summary}</Data>
      </summary>
      <recent>
        <Data>{rollover.recent}</Data>
      </recent>
    </>,
  );

  return `${earlier}\n\n${prompt}`;
}
