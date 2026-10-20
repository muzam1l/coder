import { createHmac } from 'node:crypto';

import * as z from 'zod/mini';

import { safeEqual } from '../../utils/crypto';
import type { Integration, OwnEvent } from '../types';
import { canWriteSlack, slackFetch } from './api';
import { slackApp, type SlackAppCredentials } from './app';
import { SLACK_MCP_SERVER_INSTALL, SLACK_PRESETS, slackToolServer } from './tools';

const envelope = z.object({
  type: z.optional(z.string()),
  team_id: z.optional(z.string()),
  enterprise_id: z.optional(z.string()),
  is_enterprise_install: z.optional(z.union([z.boolean(), z.string()])),
  api_app_id: z.optional(z.string()),
  challenge: z.optional(z.string()),
  authorizations: z.optional(
    z.array(
      z.object({
        user_id: z.optional(z.string()),
        team_id: z.optional(z.nullable(z.string())),
        enterprise_id: z.optional(z.nullable(z.string())),
        is_enterprise_install: z.optional(z.boolean()),
      }),
    ),
  ),
});

/** An org-ready app's workspace grants. */
const access = z.object({
  enterprise_id: z.optional(z.string()),
  authorizations: z.optional(z.array(z.object({ enterprise_id: z.optional(z.string()) }))),
  event: z.object({
    type: z.enum(['team_access_granted', 'team_access_revoked']),
    team_ids: z.array(z.string()),
  }),
});

const revoked = z.object({
  type: z.enum(['app_uninstalled', 'tokens_revoked']),
  tokens: z.optional(z.object({ bot: z.optional(z.array(z.string())) })),
});

/** The Home tab opened, and links shared under the app's unfurl domain. */
const home = z.object({
  type: z.literal('app_home_opened'),
  user: z.string(),
  tab: z.literal('home'),
});
const shared = z.object({
  type: z.literal('link_shared'),
  channel: z.string(),
  message_ts: z.string(),
  unfurl_id: z.optional(z.string()),
  source: z.optional(z.string()),
  links: z.array(z.object({ url: z.string() })),
});

/** Action ids of buttons that only open a page, such as on the Home tab. */
export const LINK_ACTION = 'link:';
/** Action ids of buttons the app posted whose click the host reads. */
export const CLICK_ACTION = 'click:';
/** Action ids of buttons that ask for text in a modal first; the modal's callback, block and input share `ASK_VIEW`. */
export const ASK_ACTION = 'ask:';
export const ASK_VIEW = 'ask';
const clicks = z.object({
  type: z.literal('block_actions'),
  actions: z.array(z.object({ action_id: z.string() })),
});
const slackUser = z.object({
  id: z.string(),
  username: z.optional(z.string()),
  name: z.optional(z.string()),
});
const buttonClick = z.object({
  user: slackUser,
  channel: z.object({ id: z.string() }),
  message: z.optional(z.object({ ts: z.string(), thread_ts: z.optional(z.string()) })),
  trigger_id: z.optional(z.string()),
  actions: z.tuple([z.object({ action_id: z.string(), value: z.string() })]),
});
const submission = z.object({
  type: z.literal('view_submission'),
  user: slackUser,
  view: z.object({
    callback_id: z.literal(ASK_VIEW),
    private_metadata: z.string(),
    state: z.object({
      values: z.object({
        [ASK_VIEW]: z.object({
          [ASK_VIEW]: z.object({ value: z.optional(z.nullable(z.string())) }),
        }),
      }),
    }),
  }),
});
/** Where an asking button was clicked, kept in its modal until the submission. */
const asking = z.object({
  thread: z.string(),
  message: z.optional(z.string()),
  value: z.string(),
});

const actorOf = (user: z.infer<typeof slackUser>) => {
  const login = user.username ?? user.name;
  return { id: user.id, ...(login ? { login } : {}) };
};

/** A click on a button the app posted, with the thread it is in; an asking button opens its modal instead. */
function clicked(value: unknown): OwnEvent | undefined {
  const click = buttonClick.safeParse(value).data;
  const action = click?.actions[0];
  if (!click || !action) return undefined;
  const thread = click.message?.thread_ts ?? click.message?.ts;
  const at = {
    thread: `slack:${click.channel.id}${thread ? `:${thread}` : ''}`,
    ...(click.message ? { message: click.message.ts } : {}),
  };
  const trigger = click.trigger_id;
  if (action.action_id.startsWith(ASK_ACTION) && trigger)
    return { work: async ctx => (await import('./views')).openAsk(ctx, trigger, at, action.value) };
  if (!action.action_id.startsWith(CLICK_ACTION)) return undefined;

  return { click: { ...at, value: action.value, actor: actorOf(click.user) } };
}

/** An asking button's modal submitted: its click, with the text when there is some. */
function submitted(value: unknown): OwnEvent | undefined {
  const sent = submission.safeParse(value).data;
  let at;
  try {
    at = sent && asking.safeParse(JSON.parse(sent.view.private_metadata)).data;
  } catch {
    return undefined;
  }
  if (!sent || !at) return undefined;
  const text = sent.view.state.values[ASK_VIEW][ASK_VIEW].value?.trim();

  return { click: { ...at, ...(text ? { text } : {}), actor: actorOf(sent.user) } };
}

/** The Events API envelope, a slash command's form, or an interaction's `payload` field, read unverified. */
function fields(raw: string): z.infer<typeof envelope> & {
  event?: unknown;
  team?: { id?: string };
  enterprise?: { id?: string };
} {
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

/** What the integration handles itself, before verification: the Home tab, shared links, interactions, and an org install's workspace grants. */
function ownEvent(
  value: ReturnType<typeof fields>,
  app: string,
  installation?: string,
): OwnEvent | undefined {
  const gone = revoked.safeParse(value.event).data;
  if (gone) {
    const removed = gone.type === 'app_uninstalled' || gone.tokens?.bot?.length;
    return installation && removed ? { uninstalled: `${app}:${installation}` } : { ack: true };
  }
  const opened = home.safeParse(value.event).data;
  if (opened) return { work: async ctx => (await import('./views')).publishHome(ctx, opened.user) };
  const links = shared.safeParse(value.event).data;
  if (links) return { work: async ctx => (await import('./views')).unfurl(ctx, links) };
  const actions = clicks.safeParse(value).data?.actions;
  const click = actions?.length ? clicked(value) : undefined;
  if (click) return click;
  const answer = submitted(value);
  if (answer) return answer;
  if (actions?.length && actions.every(action => action.action_id.startsWith(LINK_ACTION)))
    return { ack: true };
  // Buttons and other interactions come as a form whose payload has its own type.
  if (value.type && value.type !== 'event_callback' && value.type !== 'url_verification')
    return { unhandled: `Slack interaction ${value.type}` };

  const body = access.safeParse(value).data;
  const enterprise = body?.enterprise_id ?? body?.authorizations?.[0]?.enterprise_id;
  if (!body || !enterprise) return undefined;
  const teams = body.event.team_ids;
  return {
    covers: {
      installation: `${app}:${enterprise}`,
      ...(body.event.type === 'team_access_granted' ? { add: teams } : { remove: teams }),
    },
  };
}

/** Slack's v0 request signature, within five minutes. */
function verified(req: Request, raw: string, secret: string | undefined): boolean {
  const at = req.headers.get('x-slack-request-timestamp') ?? '';
  if (!secret || !(Math.abs(Date.now() / 1000 - Number(at)) <= 300)) return false;

  const expected = `v0=${createHmac('sha256', secret).update(`v0:${at}:${raw}`).digest('hex')}`;
  return safeEqual(req.headers.get('x-slack-signature') ?? '', expected);
}

/** The catalog event of a plain Slack message, from its event's `channel_type`. */
export const messageEvent = (channelType?: string) =>
  channelType === 'im' || channelType === 'mpim' ? 'dm' : 'channel';

/** The four-colour Slack mark, for full colour display. */
const SLACK_MARK =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400"><g><path d="M 84.04 252.77 c 0 23.13 -18.89 42.02 -42.02 42.02 S 0 275.9 0 252.77 s 18.89 -42.02 42.02 -42.02 h 42.02 v 42.02 Z" fill="#e3066a"/><path d="M 105.21 252.77 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 v 105.21 c 0 23.13 -18.89 42.02 -42.02 42.02 s -42.02 -18.89 -42.02 -42.02 c 0 0 0 -105.21 0 -105.21 Z" fill="#e3066a"/></g><g><path d="M 147.23 84.04 c -23.13 0 -42.02 -18.89 -42.02 -42.02 S 124.1 0 147.23 0 s 42.02 18.89 42.02 42.02 v 42.02 h -42.02 Z" fill="#00b3ff"/><path d="M 147.23 105.21 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 H 42.02 c -23.13 0 -42.02 -18.89 -42.02 -42.02 s 18.89 -42.02 42.02 -42.02 c 0 0 105.21 0 105.21 0 Z" fill="#00b3ff"/></g><g><path d="M 315.96 147.23 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 -18.89 42.02 -42.02 42.02 h -42.02 v -42.02 Z" fill="#41b658"/><path d="M 294.79 147.23 c 0 23.13 -18.89 42.02 -42.02 42.02 s -42.02 -18.89 -42.02 -42.02 V 42.02 c 0 -23.13 18.89 -42.02 42.02 -42.02 s 42.02 18.89 42.02 42.02 v 105.21 Z" fill="#41b658"/></g><g><path d="M 252.77 315.96 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 -42.02 -18.89 -42.02 -42.02 v -42.02 h 42.02 Z" fill="#fcc003"/><path d="M 252.77 294.79 c -23.13 0 -42.02 -18.89 -42.02 -42.02 s 18.89 -42.02 42.02 -42.02 h 105.21 c 23.13 0 42.02 18.89 42.02 42.02 s -18.89 42.02 -42.02 42.02 h -105.21 Z" fill="#fcc003"/></g></svg>';

/** The simple-icons mark, inlined since that package's index loads every icon. */
const SLACK_ICON =
  'M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z';

/** How people reach the agent in Slack, from the Slack events it listens to; none when nothing wakes it. */
export function slackWays(
  name: string,
  events: string[],
  direct = 'send it a direct message',
): string | undefined {
  const all = [
    events.includes('mention') && `mention @${name} in a channel`,
    events.includes('dm') && direct,
    events.includes('channel') && 'write in a channel it is in',
  ].filter((way): way is string => Boolean(way));
  if (!all.length) return undefined;
  const text = all.length > 1 ? `${all.slice(0, -1).join(', ')}, or ${all.at(-1)}` : all[0]!;

  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

export const slack: Integration = {
  id: 'slack',
  brand: { color: '#E3066A', icon: SLACK_ICON, svg: SLACK_MARK },
  name: 'Slack',
  featured: true,
  description: 'Mentions, direct messages, and channel messages in a Slack workspace',
  installLabel: 'Add to Slack',
  use: (events, here) => slackWays('{handle}', events, here ? 'message it here' : undefined),
  covered: 'Slack workspace',
  sample: 'slack:C0000000000:1700000000.000100',
  prompt: [
    'A conversation is a Slack thread or a whole 1:1 DM. A group DM works like a channel.',
    'conversations_replies reads a thread. conversations_history reads a channel or DM, including DM messages older than your history.',
    'Your final message renders as Markdown with headings, tables, lists, code blocks and quotes.',
    'Mention a person as <@USER_ID>.',
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
    command: { description: '/setup and other slash commands', on: 'command' },
    channel: {
      description:
        'Every message in channels the agent is in. Slack delivers at most 30,000 events per workspace per app per hour.',
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
  target(_req, raw) {
    const value = fields(raw);
    const body = envelope.safeParse(value).data;
    // URL verification names no app and arrives while the app is being created, before the host has its secret.
    if (body?.type === 'url_verification' && body.challenge) return new Response(body.challenge);
    const auth = body?.authorizations?.[0];
    const team = auth?.team_id ?? body?.team_id ?? value.team?.id;
    // An org-wide install is keyed by its Enterprise Grid org and covers the workspaces granted to it.
    const org = String(auth?.is_enterprise_install ?? body?.is_enterprise_install) === 'true';
    const installation = org
      ? (auth?.enterprise_id ?? body?.enterprise_id ?? value.enterprise?.id)
      : team;
    const self = auth?.user_id;
    return body?.api_app_id
      ? {
          app: body.api_app_id,
          ...(installation ? { installation } : {}),
          ...(org && team ? { within: team } : {}),
          ...(self ? { self } : {}),
        }
      : undefined;
  },
  messages: {
    asks: true,
    post: async (place, draft) => (await import('./views')).postMessage(place, draft),
    edit: async (place, ts, draft) => (await import('./views')).editMessage(place, ts, draft),
    direct: async (ctx, user, page) => (await import('./views')).directMessage(ctx, user, page),
  },
  link(event) {
    const thread = /^slack:([^:]+):(\d+)\.(\d+)$/.exec(event.chat?.thread.id ?? '');
    return thread ? `https://slack.com/archives/${thread[1]}/p${thread[2]}${thread[3]}` : undefined;
  },
  ownEvents(req, raw, app, credentials) {
    const target = slack.target(req, raw);
    const own = ownEvent(
      fields(raw),
      app.id,
      target && !(target instanceof Response) ? target.installation : undefined,
    );
    if (!own) return undefined;

    return verified(req, raw, (credentials as SlackAppCredentials | undefined)?.signingSecret)
      ? own
      : { invalid: true };
  },
  adapter: async ctx => (await import('./adapter')).slackAdapter(ctx),
  // Chat SDK routes a 1:1 DM as a mention, and DMs and channels share its message route.
  event(type, thread, message) {
    const channelType = (message.raw as { channel_type?: string }).channel_type;
    return {
      type: thread.isDM ? 'dm' : type === 'mention' ? type : messageEvent(channelType),
      actor: {
        id: message.author.userId,
        ...(message.author.userName ? { login: message.author.userName } : {}),
      },
    };
  },
  requestFetch: slackFetch,
  isUninstalled(error) {
    const code = (error as { data?: { error?: string } } | null)?.data?.error;
    return ['invalid_auth', 'account_inactive', 'token_revoked'].includes(code ?? '');
  },
  conversation: async (event, access) =>
    (await import('./conversation')).slackConversation(event, access),
  auth: {
    canWrite: canWriteSlack,
    async token(installation) {
      if (!installation.token)
        throw new Error(`Slack installation ${installation.id} has no bot token`);
      return installation.token;
    },
  },
};
