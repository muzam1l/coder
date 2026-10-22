import type { ServerClient } from '@coder/client';
import type { RunnerRow } from '@coder/client/types';

import { localServer } from '@/api/types';
import { modelsByEngine } from '@/app/dash/[org]/settings/model-options';
import type { Choice, Defaults, Lists } from './composer';
import { DEFAULT_ENGINE } from '@coder/core/types';

export const PLACEHOLDER = 'What should the agent do? Type / for flows and reviews.';

export const CHOICE: Choice = {
  repo: '',
  cwd: '',
  agent: '',
  engine: '',
  model: '',
  effort: '',
  access: 'auto',
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
export const sortedRunners = <T extends Pick<RunnerRow, 'name' | 'default'>>(rows: T[]) =>
  [...rows].sort((a, b) => Number(b.default) - Number(a.default) || a.name.localeCompare(b.name));

/** Runners as [id, name]; unset is the requester's default, named. */
export const runnerOptions = (
  rows: Array<Pick<RunnerRow, 'id' | 'name' | 'default'>>,
): [string, string][] => {
  const own = rows.find(row => row.default);
  return [
    ['', own ? `Default · ${own.name}` : 'Default'],
    ...sortedRunners(rows)
      .filter(row => row !== own)
      .map((row): [string, string] => [row.id, row.name]),
  ];
};

/** No credential can run a task yet; a local server runs on the machine's own sign-ins. */
export const credentialMissing = (api: ServerClient) =>
  Promise.all([
    api.credentials.list({ cursor: '', limit: 1, fields: 'id' }).catch(() => undefined),
    api.me().catch(() => undefined),
  ]).then(([credentials, me]) => credentials?.items.length === 0 && !(me && localServer(me)));

/** What the composer offers and falls back to, read in one request. */
export async function loadComposer(api: ServerClient) {
  const options = await api.composer();
  const preferred = options.agents.find(agent => agent.default)?.id;
  const data: Lists = {
    agents: options.agents.map(({ id, name }): [string, string] => [id, name]),
    ...(preferred ? { defaultAgent: preferred } : {}),
    // Built-in agents always exist, so an empty list means every agent is disabled.
    ...(options.agents.length ? {} : { agentsOff: true as const }),
    models: modelsByEngine(options.models),
    runners: runnerOptions(options.runners),
    flows: options.flows,
    folders: options.folders,
  };
  const defaults: Defaults = { engine: options.engine ?? DEFAULT_ENGINE, engines: options.engines };

  return { data, defaults, connectLabel: options.connectLabel ?? 'Connect repositories' };
}
