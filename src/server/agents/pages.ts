/** What Coder shows on a platform: an agent's home page and the installer's welcome. */
import type { Integration, LinkedMember, Page } from '../../integrations/types';

/** An agent as a platform shows it: its current version. */
export interface AgentSummary {
  slug: string;
  name: string;
  description?: string;
  /** Platforms its definition wires, with the events on each. */
  listens: Array<{ integration: string; name: string; events: string[] }>;
}

/** How people reach the app on `integration`, from the events it listens to there. */
function ways(integration: Integration, handle: string, events: string[]) {
  const use =
    typeof integration.use === 'function' ? integration.use(events, true) : integration.use;

  return use?.replaceAll('{handle}', handle);
}

const listening = (integration: Integration, agent?: AgentSummary) =>
  agent?.listens.find(entry => entry.integration === integration.id)?.events ?? [];

/** The app's home page: what the agent is, how to use it here, the viewer's own account, and links to it and to Coder. */
export function homePage(
  integration: Integration,
  urls: { home: string; dash: string },
  name: string,
  agent: AgentSummary | undefined,
  viewer?: { linked?: LinkedMember },
): Page {
  const slug = agent?.slug ?? name;
  const events = listening(integration, agent);
  const use = ways(integration, name, events);
  const listens = events.map(event => integration.events[event]?.description ?? event);
  const login = viewer?.linked?.login;
  const account = viewer && {
    title: `${integration.name} account`,
    ...(viewer.linked
      ? { text: login ? `Connected as @${login}.` : 'Connected.' }
      : {
          text: 'Not connected.',
          link: {
            id: 'connect',
            label: `Connect ${integration.name}`,
            url: `${urls.dash}/settings/connections?connect=${encodeURIComponent(integration.id)}`,
          },
        }),
  };

  return {
    title: agent?.name ?? name,
    ...(agent?.description ? { text: agent.description } : {}),
    sections: [
      ...(use ? [{ title: 'Use it here', text: use }] : []),
      ...(listens.length ? [{ title: 'Listens to', text: listens.join('\n') }] : []),
      ...(account ? [account] : []),
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
