import type { Integration } from './types';
import { github } from './github';
import { gmail } from './gmail';
import { linear } from './linear';
import { slack } from './slack';
import { teams } from './teams';

export const INTEGRATIONS: Record<string, Integration> = {
  github,
  slack,
  teams,
  gmail,
  linear,
};

/** The catalog a host enables by id, every integration when it names none; an unknown id throws. */
export function enabledIntegrations(ids?: string[]): Record<string, Integration> {
  if (!ids) return INTEGRATIONS;
  const unknown = ids.filter(id => !INTEGRATIONS[id]);
  if (unknown.length)
    throw new Error(
      `Unknown integration ${unknown.join(', ')} in SERVER_INTEGRATIONS; pick from ${Object.keys(INTEGRATIONS).join(', ')}`,
    );
  return Object.fromEntries(ids.map(id => [id, INTEGRATIONS[id]!]));
}

/** The integration that reads repository files, for config kept in a repository. */
export const repositoryReader = (integrations: Record<string, Integration>) =>
  Object.values(integrations).find(integration => integration.repos);
