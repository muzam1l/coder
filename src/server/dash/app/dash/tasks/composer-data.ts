import type { ServerClient } from '@coder/client';
import type { AgentRow, RunnerRow } from '@coder/client/types';

import { localServer } from '@/api/types';
import { NO_MODELS, modelsByEngine } from '@/app/dash/settings/model-options';
import type { Choice, Defaults, Lists } from './composer';

export const PLACEHOLDER = 'What should the agent do? Type / for flows and reviews.';

export const CHOICE: Choice = {
  repo: '',
  cwd: '',
  agent: '',
  engine: '',
  model: '',
  effort: '',
  permissions: '',
  runner: '',
};

/** No agent picked yet, or one this workspace no longer runs, falls back to the server's default agent, else the first. */
export function usableAgent(choice: Choice, lists: Pick<Lists, 'agents' | 'defaultAgent'>): Choice {
  const ids = lists.agents.map(([id]) => id);
  if (!ids.length || ids.includes(choice.agent)) return choice;

  return { ...choice, agent: lists.defaultAgent ?? ids[0]! };
}

/** The composer's last choice, from its cookie. */
export function savedChoice(cookie: string): Partial<Choice> {
  const raw = cookie.match(/(?:^|; )compose=([^;]*)/)?.[1];
  try {
    return raw ? JSON.parse(decodeURIComponent(raw)) : {};
  } catch {
    return {};
  }
}

/** Defaults first, then by name. */
export const sortedRunners = (rows: RunnerRow[]) =>
  [...rows].sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));

/** Runners as [id, name]; unset is the requester's default, named. */
export const runnerOptions = (rows: RunnerRow[]): [string, string][] => {
  const own = rows.find(row => row.default);
  return [
    ['', own ? `Default · ${own.name}` : 'Default'],
    ...sortedRunners(rows)
      .filter(row => row !== own)
      .map((row): [string, string] => [row.id, row.name]),
  ];
};

/** Every enabled agent as [id, name] with the server's default first; undefined when the read failed. */
export const agentChoices = (
  api: ServerClient,
): Promise<{ agents: [string, string][]; defaultAgent?: string } | undefined> =>
  api.agents.list().then(
    (rows: AgentRow[] | { items: AgentRow[] }) => {
      const enabled = (Array.isArray(rows) ? rows : rows.items)
        .filter(agent => !agent.settings?.disabled)
        .sort((a, b) => Number(b.default === true) - Number(a.default === true));
      const preferred = enabled.find(agent => agent.default)?.id;

      return {
        agents: enabled.map((agent): [string, string] => [agent.id, agent.name]),
        ...(preferred ? { defaultAgent: preferred } : {}),
      };
    },
    () => undefined,
  );

/** No credential can run a task yet; a local server runs on the machine's own sign-ins. */
export const credentialMissing = (api: ServerClient) =>
  Promise.all([
    api.credentials.list().catch(() => undefined),
    api.me().catch(() => undefined),
  ]).then(([credentials, me]) => credentials?.length === 0 && !(me && localServer(me)));

/** What the composer offers and falls back to, read in one go. */
export async function loadComposer(api: ServerClient, agents = agentChoices(api)) {
  const [config, catalog, ids, repos, models, runners, flows, folders] = await Promise.all([
    api.config.get().catch(() => undefined),
    api.integrations.list().catch(() => []),
    agents,
    api.repositories.list().catch(() => []),
    api.models.list().catch(() => NO_MODELS),
    api.runners.list().then(
      rows => rows.items,
      () => [],
    ),
    api.flows.list().catch(() => []),
    api.folders.list().catch(() => undefined),
  ]);
  const data: Lists = {
    agents: ids?.agents ?? [],
    ...(ids?.defaultAgent ? { defaultAgent: ids.defaultAgent } : {}),
    // Built-in agents always exist, so an empty read means every agent is disabled.
    ...(ids && !ids.agents.length ? { agentsOff: true as const } : {}),
    repos: repos.map(entry => entry.repo),
    models: modelsByEngine(models),
    runners: runnerOptions(runners),
    flows: flows.map(flow => flow.name),
    folders,
  };
  const defaults: Defaults = {
    engine: config?.effective.chain?.[0] ?? 'claude',
    engines: config?.effective.engines ?? {},
  };
  return {
    data,
    defaults,
    connectLabel: catalog.find(entry => entry.repositories)?.installLabel ?? 'Connect repositories',
  };
}
