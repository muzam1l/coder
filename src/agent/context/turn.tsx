/** @jsxImportSource contextjsx */
/** An agent turn's messages: events, requests and history. */
import { Data, render } from 'contextjsx';

import { changeDecisionMessage } from '../../core/approvals';
import type { AgentEvent, TaskContext } from '../types';

/** `since` holds at most this many messages; past that the agent is told how many more there are. */
export const SINCE_LIMIT = 50;

/** Whether someone wrote the event: a chat message, or the description of what they opened. */
const written = (event: AgentEvent) => Boolean(event.chat?.message || event.text);

/** An event's actor with the page the platform gave. */
const actorJson = ({ actor }: AgentEvent) => ({
  id: actor.id,
  ...(actor.login ? { handle: actor.login } : {}),
  ...(actor.url ? { url: actor.url } : {}),
});

/** A change nobody wrote, as the platform sent it: its verb, the integration's line, who and its object. */
function changeJson(event: AgentEvent) {
  return {
    event: event.type,
    ...(event.action ? { action: event.action } : {}),
    ...(event.title ? { title: event.title } : {}),
    by: actorJson(event),
    ...(event.url ? { url: event.url } : {}),
    ...(event.payload !== undefined ? { payload: event.payload } : {}),
  };
}

/** One message as the event JSON carries it: id, thread, position, text with the address removed, author, time. */
function messageJson(event: AgentEvent) {
  const message = event.chat?.message;
  if (!message)
    return { text: event.text, author: actorJson(event), ...(event.url ? { url: event.url } : {}) };
  const { author, metadata } = message;

  return {
    id: message.id,
    thread: event.chat!.thread.id,
    ...(event.conversation?.index !== undefined ? { index: event.conversation.index } : {}),
    text: event.text,
    ...(message.isMention ? { mention: true } : {}),
    author: {
      id: author.userId,
      handle: author.userName,
      name: author.fullName,
      ...(author.isBot ? { bot: true } : {}),
      ...(event.actor.url ? { url: event.actor.url } : {}),
    },
    ...(event.url ? { url: event.url } : {}),
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

/** The JSON of one turn: the newest event names the conversation; each event in it is a message, or a change when nobody wrote it. */
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
  const since = unseen.slice(0, SINCE_LIMIT);
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
    ...(events.length > 1
      ? { messages: events.map(each => (written(each) ? messageJson(each) : changeJson(each))) }
      : written(event)
        ? { message: messageJson(event) }
        : { ...changeJson(event), event: event.type }),
    ...(since.length ? { since } : {}),
    ...(more ? { more } : {}),
    ...(user ? { requester: { name: user.name } } : {}),
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

/** Decisions on the task's change requests since the turn before the last ended: a steer that reached the last turn too late is lost when it completes. */
export function decisionsPrompt(context: TaskContext | undefined, prompt: string): string {
  const turns = context?.turns ?? [];
  const since = turns.at(-2)?.finishedAt ?? 0;
  const decided = (context?.approvals ?? []).filter(
    approval =>
      approval.change &&
      turns.length > 0 &&
      (approval.response?.decision === 'accept' || approval.response?.decision === 'decline') &&
      Date.parse(approval.response.answeredAt ?? '') >= since,
  );
  if (!decided.length) return prompt;
  const decisions = render(
    <decisions>
      <Data>{decided.map(changeDecisionMessage).join('\n')}</Data>
    </decisions>,
  );

  return `${decisions}\n\n${prompt}`;
}
