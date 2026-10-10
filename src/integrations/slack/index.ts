import * as z from 'zod/mini';

import type { Integration } from '../types';
import { slackApp } from './app';
import { SLACK_READ_METHODS, SLACK_TOOLS, SLACK_WRITE_METHODS } from './tools';

const envelope = z.object({
  type: z.optional(z.string()),
  team_id: z.optional(z.string()),
  api_app_id: z.optional(z.string()),
  challenge: z.optional(z.string()),
  authorizations: z.optional(
    z.array(z.object({ user_id: z.optional(z.string()), team_id: z.optional(z.string()) })),
  ),
});

/** The Events API envelope, a slash command's form, or an interaction's `payload` field, read unverified. */
function fields(raw: string): z.infer<typeof envelope> & { team?: { id?: string } } {
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

/** The four-colour Slack mark; the dashboard shows it full colour. */
const SLACK_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><g><path d="M 84.04 252.77 c 0 23.13 -18.89 42.02 -42.02 42.02 S 0 275.9 0 252.77 s 18.89 -42.02 42.02 -42.02 h 42.02 v 42.02 Z" fill="#e3066a"/><path d="M 105.21 252.77 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 v 105.21 c 0 23.13 -18.89 42.02 -42.02 42.02 s -42.02 -18.89 -42.02 -42.02 c 0 0 0 -105.21 0 -105.21 Z" fill="#e3066a"/></g><g><path d="M 147.23 84.04 c -23.13 0 -42.02 -18.89 -42.02 -42.02 S 124.1 0 147.23 0 s 42.02 18.89 42.02 42.02 v 42.02 h -42.02 Z" fill="#00b3ff"/><path d="M 147.23 105.21 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 H 42.02 c -23.13 0 -42.02 -18.89 -42.02 -42.02 s 18.89 -42.02 42.02 -42.02 c 0 0 105.21 0 105.21 0 Z" fill="#00b3ff"/></g><g><path d="M 315.96 147.23 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 -18.89 42.02 -42.02 42.02 h -42.02 v -42.02 Z" fill="#41b658"/><path d="M 294.79 147.23 c 0 23.13 -18.89 42.02 -42.02 42.02 s -42.02 -18.89 -42.02 -42.02 V 42.02 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 v 105.21 Z" fill="#41b658"/></g><g><path d="M 252.77 315.96 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 -42.02 -18.89 -42.02 -42.02 v -42.02 h 42.02 Z" fill="#fcc003"/><path d="M 252.77 294.79 c -23.13 0 -42.02 -18.89 -42.02 -42.02 s 18.89 -42.02 42.02 -42.02 h 105.21 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 h -105.21 Z" fill="#fcc003"/></g></svg>';

/** The simple-icons mark, inlined since that package's index loads every icon. */
const SLACK_ICON =
  'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z';

export const slack: Integration = {
  id: 'slack',
  brand: { color: '#E3066A', icon: SLACK_ICON, svg: SLACK_MARK },
  name: 'Slack',
  description: 'Mentions, messages, and reactions in a Slack workspace',
  installLabel: 'Add to Slack',
  sample: 'slack:C0000000000:1700000000.000100',
  hint: 'Do not use Markdown headings. Use short paragraphs and code spans, and reply only in the thread where you were addressed.',
  events: {
    mention: { description: 'Slack app mention', on: 'mention', addressed: true },
    command: { description: '/setup and other slash commands', on: 'command' },
    reaction: { description: 'Reaction added', on: 'reaction' },
    message: {
      description: 'Channel, group, or direct message',
      on: 'message',
      noisy: true,
      addressed: true,
    },
  },
  tools: {
    presets: {
      observe: Object.keys(SLACK_READ_METHODS),
      comment: [...Object.keys(SLACK_READ_METHODS), ...Object.keys(SLACK_WRITE_METHODS)],
      // Slack has no code-writing actions.
      write: [...Object.keys(SLACK_READ_METHODS), ...Object.keys(SLACK_WRITE_METHODS)],
    },
    serve: SLACK_TOOLS,
  },
  get app() {
    return slackApp;
  },
  target(_req, raw) {
    const body = envelope.safeParse(fields(raw)).data;
    // URL verification names no app and arrives while the app is being created, before Coder has its secret.
    if (body?.type === 'url_verification' && body.challenge) return new Response(body.challenge);
    const team = body?.authorizations?.[0]?.team_id ?? body?.team_id ?? fields(raw).team?.id;
    const self = body?.authorizations?.[0]?.user_id;
    return body?.api_app_id
      ? { app: body.api_app_id, ...(team ? { installation: team } : {}), ...(self ? { self } : {}) }
      : undefined;
  },
  adapter: async ctx => (await import('./adapter')).slackAdapter(ctx),
  reactionId: reaction => (reaction.raw as { event_ts?: string }).event_ts,
  auth: {
    async token(installation) {
      if (!installation.token)
        throw new Error(`Slack installation ${installation.id} has no bot token`);
      return installation.token;
    },
  },
};
