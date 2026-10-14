/** Block Kit that Coder publishes in Slack: an agent's Home tab and the cards of Coder links. */
import type { AdapterContext, AgentSummary, TaskSummary } from '../types';
import { slackApi } from './app';
import { LINK_ACTION, slack } from './index';

const mrkdwn = (text: string) => ({ type: 'mrkdwn', text });
/** Slack refuses a section text over 3,000 characters. */
const section = (text: string) => ({
  type: 'section',
  text: mrkdwn(text.length > 3000 ? `${text.slice(0, 2999)}…` : text),
});

/** Slack's own escaping for text inside mrkdwn. */
const escaped = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const link = (url: string, text: string) => `<${url}|${escaped(text)}>`;

const STATUS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** A button that opens `url`; Slack still posts the click, which Coder only answers. */
const linkButton = (id: string, url: string, text: string, primary?: boolean) => ({
  type: 'button',
  action_id: `${LINK_ACTION}${id}`,
  text: { type: 'plain_text', text },
  url,
  ...(primary ? { style: 'primary' } : {}),
});

/** How people reach the agent in Slack, from the Slack events it listens to; none when nothing wakes it. */
function ways(name: string, events: string[]): string | undefined {
  const all = [
    events.includes('mention') && `mention @${escaped(name)} in a channel`,
    events.includes('message') && 'message it here',
    events.includes('reaction') && 'react to a message',
  ].filter((way): way is string => Boolean(way));
  if (!all.length) return undefined;
  const text = all.length > 1 ? `${all.slice(0, -1).join(', ')}, or ${all.at(-1)}` : all[0]!;

  return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
}

/** The Home tab: what the agent is, how to use it here, and links to it and to Coder. */
function homeView(
  urls: { home: string; dash: string },
  name: string,
  agent: AgentSummary | undefined,
): Record<string, unknown> {
  const slug = agent?.slug ?? name;
  const events = agent?.listens.find(entry => entry.integration === slack.id)?.events ?? [];
  const listens = events.map(event => slack.events[event]?.description ?? event);

  return {
    type: 'home',
    blocks: [
      section(
        [`*${escaped(agent?.name ?? name)}*`, agent?.description && escaped(agent.description)]
          .filter(Boolean)
          .join('\n'),
      ),
      ...(ways(name, events) ? [section(`*Use it here*\n${ways(name, events)}`)] : []),
      ...(listens.length ? [section(`*Listens to*\n${listens.join('\n')}`)] : []),
      { type: 'divider' },
      {
        type: 'actions',
        elements: [
          linkButton(
            'agent',
            `${urls.dash}/agents/${encodeURIComponent(slug)}/platforms`,
            'Open in Coder',
            true,
          ),
          linkButton('coder', urls.home.replace(/\/$/, ''), 'Make your own agent'),
        ],
      },
    ],
  };
}

/** Publishes the Home tab for the user who opened it. */
export async function publishHome(ctx: AdapterContext, user: string): Promise<void> {
  if (!ctx.publicUrl || !ctx.dashUrl || !ctx.installationId) return;
  const urls = { home: ctx.publicUrl, dash: ctx.dashUrl };
  const view = homeView(urls, ctx.name, await ctx.agent?.());
  await slackApi(
    'views.publish',
    { user_id: user, view },
    await ctx.token(ctx.installationId),
    ctx.fetch,
  );
}

/** The DM to the installer: what the agent is, how to use it, and the model step while one is missing. */
export async function welcome(
  ctx: AdapterContext,
  installer: string,
  { open, setup }: { open: string; setup?: string },
): Promise<void> {
  if (!ctx.installationId) return;
  const agent = await ctx.agent?.();
  const name = agent?.name ?? ctx.name;
  const use = ways(
    ctx.name,
    agent
      ? (agent.listens.find(entry => entry.integration === slack.id)?.events ?? [])
      : ['mention'],
  );
  const blocks = [
    section(
      [`*${escaped(name)} is in your workspace*`, agent?.description && escaped(agent.description)]
        .filter(Boolean)
        .join('\n'),
    ),
    ...(use ? [section(`*Use it*\n${use}`)] : []),
    ...(setup
      ? [section(`*One step left*\nAdd a model so ${escaped(name)} can start working.`)]
      : []),
    {
      type: 'actions',
      elements: [
        ...(setup ? [linkButton('model', setup, 'Add a model', true)] : []),
        linkButton('agent', open, 'Open in Coder', !setup),
      ],
    },
  ];
  await slackApi(
    'chat.postMessage',
    { channel: installer, text: `${name} is in your workspace`, blocks },
    await ctx.token(ctx.installationId),
    ctx.fetch,
  );
}

/** A task's card. */
function taskCard(url: string, task: TaskSummary): Record<string, unknown> {
  const at = Math.floor(task.startedAt / 1000);
  const title = task.title.length > 150 ? `${task.title.slice(0, 149)}…` : task.title;

  return {
    blocks: [
      {
        ...section(`*${link(url, title)}*`),
        fields: [
          mrkdwn(`*Agent*\n${escaped(task.agent)}`),
          mrkdwn(`*Status*\n${STATUS[task.status] ?? task.status}`),
          mrkdwn(`*From*\n${escaped(task.from)}`),
          mrkdwn(
            `*Started*\n<!date^${at}^{date_short_pretty} at {time}|${new Date(task.startedAt).toISOString()}>`,
          ),
        ],
      },
      { type: 'context', elements: [mrkdwn(`Coder task ${escaped(task.id)}`)] },
    ],
  };
}

/** An agent's card. */
function agentCard(url: string, agent: AgentSummary): Record<string, unknown> {
  const platforms = agent.listens.map(entry => entry.name);
  const onlyHere = agent.listens.length === 1 && agent.listens[0]!.integration === slack.id;

  return {
    blocks: [
      {
        ...section(
          [`*${link(url, agent.name)}*`, agent.description && escaped(agent.description)]
            .filter(Boolean)
            .join('\n'),
        ),
        ...(onlyHere
          ? {}
          : { fields: [mrkdwn(`*Listens on*\n${platforms.join(', ') || 'Nothing yet'}`)] }),
      },
      { type: 'context', elements: [mrkdwn('Coder agent')] },
    ],
  };
}

/** The card of one dashboard link: a task or an agent of the installation's workspace, else none. */
async function card(ctx: AdapterContext, dash: URL, url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const root = `${dash.pathname.replace(/\/$/, '')}/`;
  if (parsed.origin !== dash.origin || !parsed.pathname.startsWith(root)) return undefined;
  const [kind, id] = parsed.pathname.slice(root.length).split('/');
  if (!id) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(id);
  } catch {
    return undefined;
  }

  if (kind === 'tasks') {
    const task = await ctx.task?.(key);
    return task && taskCard(url, task);
  }
  if (kind === 'agents') {
    const agent = await ctx.agent?.(key);
    return agent && agentCard(url, agent);
  }
  return undefined;
}

/** `chat.unfurl` for the shared links that point at the workspace's tasks and agents. */
export async function unfurl(
  ctx: AdapterContext,
  shared: {
    channel: string;
    message_ts: string;
    unfurl_id?: string;
    source?: string;
    links: Array<{ url: string }>;
  },
): Promise<void> {
  if (!ctx.dashUrl || !ctx.installationId) return;
  const dash = new URL(ctx.dashUrl);
  const cards = await Promise.all(
    shared.links.map(async ({ url }) => [url, await card(ctx, dash, url)] as const),
  );
  const unfurls = Object.fromEntries(cards.filter(([, value]) => value));
  if (!Object.keys(unfurls).length) return;

  // A link in the composer has no message yet; Slack names it by its unfurl id.
  const where =
    shared.unfurl_id && shared.source
      ? { unfurl_id: shared.unfurl_id, source: shared.source }
      : { channel: shared.channel, ts: shared.message_ts };
  await slackApi(
    'chat.unfurl',
    { ...where, unfurls },
    await ctx.token(ctx.installationId),
    ctx.fetch,
  );
}
