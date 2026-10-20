/** A conversation task's tools: reply, react and history. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { defineCommand, type Context } from 'contextjsx';
import * as z from 'zod/mini';

import type { Task } from '../../core/types';
import { history } from '../../core/engines/history';
import { appendTaskDirLog } from '../../core/state';
import { arg, str } from '../../utils/args';
import { eventJsons } from './turn';

/** Posts a reply or reaction to the task's conversation (`CODER_REPLY_URL`); a retry after a network failure reuses the call id, so it posts once. */
async function postToConversation(
  kind: 'reply' | 'react',
  payload: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<{ ok: true }> {
  const url = process.env.CODER_REPLY_URL;
  const token = process.env.CODER_REPLY_TOKEN;
  if (!url || !token) throw new Error('This task has no conversation to post to');
  const body = JSON.stringify({ id: randomUUID(), ...payload });
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await request(`${url}/${kind}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt < 2) continue;
      throw error;
    }
    const answer = (await response.json().catch(() => undefined)) as
      { ok?: boolean; error?: string } | undefined;
    if (!response.ok)
      throw new Error(answer?.error ?? `The conversation ${kind} failed (${response.status})`);

    return { ok: true };
  }
}

/** The task the tools run for, from `CODER_HISTORY_TASK`. */
async function historyTask(): Promise<{ file: string; task: Task }> {
  const file = process.env.CODER_HISTORY_TASK;
  if (!file) throw new Error('CODER_HISTORY_TASK is not set');

  return { file, task: JSON.parse(await fs.readFile(file, 'utf8')) as Task };
}

/** A tool call's context; `fetch` reaches the poster when given. */
type PosterContext = Context & { fetch?: typeof fetch };

/** The conversation tools: reply, react and history. */
export const conversationCommands = [
  defineCommand({
    name: 'reply',
    description:
      'Post a reply now, such as before longer work. Never repeat text you already posted or will put in your final message.',
    args: { text: arg(z.string(), 'Markdown to post.') },
    access: 'write',
    run: async ({ text }, ctx: PosterContext) => {
      const { file, task } = await historyTask();
      if (!task.conversation) throw new Error('Only conversation tasks can reply');
      if (typeof text !== 'string' || !text.trim()) throw new Error('Reply text is required');

      const sent = await postToConversation('reply', { text: text.trim() }, ctx.fetch);
      // The turn's last reply, so the same text as the final message is not posted twice.
      appendTaskDirLog(path.dirname(file), { kind: 'reply', message: text.trim() });

      return sent;
    },
  }),
  defineCommand({
    name: 'react',
    description:
      'React to a message in this conversation with an emoji, by default the one that started your turn.',
    args: {
      emoji: arg(z.string(), 'An emoji name such as thumbsup, or the emoji itself.'),
      message: str('A message id from the conversation.'),
    },
    access: 'write',
    run: async ({ emoji, message: id }, ctx: PosterContext) => {
      const { task } = await historyTask();
      if (!task.conversation) throw new Error('Only conversation tasks can react');
      if (typeof emoji !== 'string' || !emoji.trim()) throw new Error('Emoji is required');
      if (id !== undefined && (typeof id !== 'string' || !id.trim()))
        throw new Error('Message id must be a non-empty string');
      const event = eventJsons(task.currentPrompt ?? task.prompt ?? '', true)?.[0];
      const message = id ?? event?.message?.id ?? event?.messages?.[0]?.id;
      if (event && !message)
        throw new Error('This turn has no message to react to; give a message id');

      return postToConversation(
        'react',
        { emoji: emoji.trim(), ...(message ? { message } : {}) },
        ctx.fetch,
      );
    },
  }),
  defineCommand({
    name: 'history',
    description:
      "Search or read this task's full earlier conversation, including anything compacted out of your context, with your tool calls and results, oldest first. With query, the messages containing that exact text; without, the messages from `from` on.",
    args: {
      query: str(
        'Exact text to find, case-insensitive, 1 to 500 characters: a word or phrase from the message, not a question.',
      ),
      from: arg(
        z.optional(z.number()),
        'Message index to start at; default the oldest, or after the last match.',
      ),
      limit: arg(z.optional(z.number()), 'Messages to return, 1 to 20; default 10.'),
    },
    access: 'read',
    run: async args => history((await historyTask()).task, args),
  }),
];
