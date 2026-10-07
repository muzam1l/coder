import { eventOptions, narrowPermission, resolveEvents, resolveTools } from './definition';
import { INTEGRATIONS } from '../integrations';
import type { Agent, AgentEvent } from './types';

/** Effective tools for every integration the agent declares and the catalog knows. */
function declaredTools(agent: Agent): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const id of Object.keys(agent.definition.integrations)) {
    const integration = INTEGRATIONS[id];
    if (integration) result[id] = resolveTools(agent, id, integration);
  }
  return result;
}

/** Whether this one agent handles the event, and with which flow and tools per integration. */
export function matchAgent(
  event: AgentEvent,
  agent: Agent,
):
  | {
      flow: string;
      tools: Record<string, string[]>;
      permissions?: Agent['definition']['permissions'];
      actAs?: 'requester';
    }
  | undefined {
  const integration = INTEGRATIONS[event.integration];
  if (!integration) return undefined;
  if (!resolveEvents(agent, event.integration).includes(event.type)) return undefined;
  const options = eventOptions(agent.definition.integrations[event.integration], event.type);
  if (!options) return undefined;
  if (options.match !== undefined && !new RegExp(options.match).test(event.text)) return undefined;
  const maximum = agent.usage?.permissions ?? agent.definition.permissions;
  return {
    flow: options.flow ?? 'default',
    tools: declaredTools(agent),
    ...(options.actAs ? { actAs: options.actAs } : {}),
    ...(maximum
      ? { permissions: narrowPermission(maximum, options.permissions) }
      : options.permissions
        ? { permissions: options.permissions }
        : {}),
  };
}

/** Local `coder agent run` helper: every agent the event matches. */
export function matchAgents(event: AgentEvent, agents: Agent[]) {
  return agents.flatMap(agent => {
    const match = matchAgent(event, agent);
    return match ? [{ agent, ...match }] : [];
  });
}
