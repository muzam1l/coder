import type { Integration } from '../types';
import {
  canWriteSlack,
  slackConversation,
  slackFetch,
  slackMembers,
  slackSpace,
  slackUninstalled,
  SLACK_MCP_SERVER_INSTALL,
  SLACK_PRESETS,
  slackToolServer,
} from './api';
import { slackApp, slackToken, slackUserAuth, slackWays } from './app';
import {
  slackAdapter,
  slackChatEvent,
  slackOwnEvents,
  slackTarget,
  slackThreadUrl,
} from './events';

/** The four-colour Slack mark, for full colour display. */
const SLACK_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><g><path d="M 84.04 252.77 c 0 23.13 -18.89 42.02 -42.02 42.02 S 0 275.9 0 252.77 s 18.89 -42.02 42.02 -42.02 h 42.02 v 42.02 Z" fill="#e3066a"/><path d="M 105.21 252.77 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 v 105.21 c 0 23.13 -18.89 42.02 -42.02 42.02 s -42.02 -18.89 -42.02 -42.02 c 0 0 0 -105.21 0 -105.21 Z" fill="#e3066a"/></g><g><path d="M 147.23 84.04 c -23.13 0 -42.02 -18.89 -42.02 -42.02 S 124.1 0 147.23 0 s 42.02 18.89 42.02 42.02 v 42.02 h -42.02 Z" fill="#00b3ff"/><path d="M 147.23 105.21 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 H 42.02 c -23.13 0 -42.02 -18.89 -42.02 -42.02 s 18.89 -42.02 42.02 -42.02 c 0 0 105.21 0 105.21 0 Z" fill="#00b3ff"/></g><g><path d="M 315.96 147.23 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 -18.89 42.02 -42.02 42.02 h -42.02 v -42.02 Z" fill="#41b658"/><path d="M 294.79 147.23 c 0 23.13 -18.89 42.02 -42.02 42.02 s -42.02 -18.89 -42.02 -42.02 V 42.02 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 v 105.21 Z" fill="#41b658"/></g><g><path d="M 252.77 315.96 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 -42.02 -18.89 -42.02 -42.02 v -42.02 h 42.02 Z" fill="#fcc003"/><path d="M 252.77 294.79 c -23.13 0 -42.02 -18.89 -42.02 -42.02 s 18.89 -42.02 42.02 -42.02 h 105.21 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 h -105.21 Z" fill="#fcc003"/></g></svg>';

/** The simple-icons mark, inlined since that package's index loads every icon. */
const SLACK_ICON =
  'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z';

export const slack: Integration = {
  id: 'slack',
  brand: { color: '#E3066A', icon: SLACK_ICON, svg: SLACK_MARK },
  name: 'Slack',
  featured: true,
  description: 'Mentions, direct messages, and channel messages in a Slack workspace',
  installLabel: 'Add to Slack',
  use: (events, here) => slackWays('{handle}', events, here ? 'message it here' : undefined),
  covered: 'Slack workspace',
  // A thread inside a 1:1 DM belongs to the whole DM.
  item: thread => thread.replace(/^(slack:D[A-Z0-9]+:).+$/, '$1'),
  sample: 'slack:C0000000000:1700000000.000100',
  prompt: [
    'A conversation is a Slack thread, or a whole 1:1 DM with its threads. A group DM works like a channel.',
    'Replies render as Slack Markdown: headings, lists, tables, code blocks, quotes. Mention a person as <@USER_ID>.',
    'Link pull requests and issues by full URL; a bare number like #123 renders only on GitHub.',
  ].join('\n'),
  // `markdown_text` holds at most 12,000 characters (chat.postMessage).
  replyLimit: 12_000,
  events: {
    mention: {
      description: 'A message that mentions the agent in a channel or group DM.',
      on: 'mention',
      addressed: true,
    },
    dm: {
      description: 'Every message in a direct message or group DM with the agent.',
      on: 'message',
      addressed: true,
    },
    channel: {
      description:
        'Every message in channels the agent is in.',
      on: 'message',
      noisy: true,
      addressed: true,
    },
  },
  tools: {
    presets: SLACK_PRESETS,
    server: slackToolServer,
    install: SLACK_MCP_SERVER_INSTALL,
    installHosts: ['github.com', 'release-assets.githubusercontent.com'],
  },
  hosts: ['slack.com', '*.slack.com'],
  get app() {
    return slackApp;
  },
  target: slackTarget,
  messages: {
    asks: true,
    post: async (place, draft) => (await import('./views')).postMessage(place, draft),
    edit: async (place, ts, draft) => (await import('./views')).editMessage(place, ts, draft),
    direct: async (ctx, user, page) => (await import('./views')).directMessage(ctx, user, page),
  },
  link: slackThreadUrl,
  ownEvents: slackOwnEvents,
  adapter: slackAdapter,
  event: slackChatEvent,
  requestFetch: slackFetch,
  isUninstalled: slackUninstalled,
  conversation: slackConversation,
  auth: {
    canWrite: canWriteSlack,
    members: slackMembers,
    space: slackSpace,
    token: slackToken,
    get user() {
      return slackUserAuth;
    },
  },
};
