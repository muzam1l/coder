/** What Coder shows on a platform: an agent's home page, the installer's welcome, and cards of dashboard links. */
import type { Card, Integration, Page } from '../../integrations/types';

/** An agent as a platform shows it: its current version. */
export interface AgentSummary {
  slug: string;
  name: string;
  description?: string;
  /** Platforms its definition wires, with the events on each. */
  listens: Array<{ integration: string; name: string; events: string[] }>;
}

/** A task as a platform shows it. */
export interface TaskSummary {
  id: string;
  title: string;
  agent: string;
  status: string;
  /** The platform that raised it, or `dashboard`, `cli` or `schedule`. */
  from: string;
  /** Epoch milliseconds; when it was queued if it has not started. */
  startedAt: number;
}

const STATUS: Record<string, string> = {
  queued: 'Queued',
  running: 'Running',
  waiting: 'Needs approval',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** How people reach the app on `integration`, from the events it listens to there. */
function ways(integration: Integration, handle: string, events: string[]) {
  const use =
    typeof integration.use === 'function' ? integration.use(events, true) : integration.use;

  return use?.replaceAll('{handle}', handle);
}

const listening = (integration: Integration, agent?: AgentSummary) =>
  agent?.listens.find(entry => entry.integration === integration.id)?.events ?? [];

/** The app's home page: what the agent is, how to use it here, and links to it and to Coder. */
export function homePage(
  integration: Integration,
  urls: { home: string; dash: string },
  name: string,
  agent: AgentSummary | undefined,
): Page {
  const slug = agent?.slug ?? name;
  const events = listening(integration, agent);
  const use = ways(integration, name, events);
  const listens = events.map(event => integration.events[event]?.description ?? event);

  return {
    title: agent?.name ?? name,
    ...(agent?.description ? { text: agent.description } : {}),
    sections: [
      ...(use ? [{ title: 'Use it here', text: use }] : []),
      ...(listens.length ? [{ title: 'Listens to', text: listens.join('\n') }] : []),
    ],
    links: [
      {
        id: 'agent',
        label: 'Open in Coder',
        url: `${urls.dash}/agents/${encodeURIComponent(slug)}/platforms`,
        primary: true,
      },
      { id: 'coder', label: 'Make your own agent', url: urls.home.replace(/\/$/, '') },
    ],
  };
}

/** The installer's welcome: what the agent is, how to use it, and the model step while one is missing. */
export function welcomePage(
  integration: Integration,
  name: string,
  agent: AgentSummary | undefined,
  { open, setup }: { open: string; setup?: string },
): Page {
  const title = agent?.name ?? name;
  const use = ways(integration, name, agent ? listening(integration, agent) : ['mention']);

  return {
    title: `${title} is in your workspace`,
    ...(agent?.description ? { text: agent.description } : {}),
    sections: [
      ...(use ? [{ title: 'Use it', text: use }] : []),
      ...(setup
        ? [{ title: 'One step left', text: `Add a model so ${title} can start working.` }]
        : []),
    ],
    links: [
      ...(setup ? [{ id: 'model', label: 'Add a model', url: setup, primary: true }] : []),
      { id: 'agent', label: 'Open in Coder', url: open, ...(setup ? {} : { primary: true }) },
    ],
  };
}

/** The card of one dashboard link: a task or an agent of the installation's workspace, else none. */
export async function linkCard(
  integration: Integration,
  dash: string,
  url: string,
  lookup: {
    agent(slug: string): Promise<AgentSummary | undefined>;
    task(id: string): Promise<TaskSummary | undefined>;
  },
): Promise<Card | undefined> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const base = new URL(dash);
  const root = `${base.pathname.replace(/\/$/, '')}/`;
  if (parsed.origin !== base.origin || !parsed.pathname.startsWith(root)) return undefined;
  const [kind, id] = parsed.pathname.slice(root.length).split('/');
  if (!id) return undefined;
  let key: string;
  try {
    key = decodeURIComponent(id);
  } catch {
    return undefined;
  }

  if (kind === 'tasks') {
    const task = await lookup.task(key);
    return (
      task && {
        title: task.title.length > 150 ? `${task.title.slice(0, 149)}…` : task.title,
        url,
        fields: [
          { label: 'Agent', text: task.agent },
          { label: 'Status', text: STATUS[task.status] ?? task.status },
          { label: 'From', text: task.from },
          { label: 'Started', at: task.startedAt },
        ],
        footer: `Coder task ${task.id}`,
      }
    );
  }
  if (kind === 'agents') {
    const agent = await lookup.agent(key);
    if (!agent) return undefined;
    const onlyHere = agent.listens.length === 1 && agent.listens[0]!.integration === integration.id;
    const platforms = agent.listens.map(entry => entry.name);

    return {
      title: agent.name,
      url,
      ...(agent.description ? { text: agent.description } : {}),
      ...(onlyHere
        ? {}
        : { fields: [{ label: 'Listens on', text: platforms.join(', ') || 'Nothing yet' }] }),
      footer: 'Coder agent',
    };
  }
  return undefined;
}
