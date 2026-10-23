/** What an agent is: the `agent.json` schema, how a repo runs it (`agents` in config), and the settings it resolves to. */
import * as z from 'zod/mini';

import {
  accessSchema,
  mcpEntrySchema,
  modelSpecSchema,
  schemaIssues,
  splitEngineSpec,
  strictestAccess,
  type Access,
} from '../core/config';
import { markRepositoryMcp } from '../core/mcp';
import { INTEGRATIONS } from '../integrations';
import type { Integration } from '../integrations/types';
import type {
  Agent,
  AgentDefinition,
  AgentDefinitionIntegration,
  AgentEvent,
  AgentEventOptions,
  AgentUsage,
} from './types';

const slug = z.string().check(z.regex(/^[a-z0-9][a-z0-9_-]*$/i, 'agent or flow name'));

const eventOptionsSchema = z.strictObject({
  match: z.optional(z.string().check(z.minLength(1))),
});

// A refinement, not a union, so a wrong value gets this one error.
const eventValueSchema = z
  .unknown()
  .check(
    z.refine(
      value => value === true || eventOptionsSchema.safeParse(value).success,
      'events take a list of names, or a map of each name to true or { "match": "<regex>" }',
    ),
  );

const definitionIntegrationSchema = z.strictObject({
  events: z.optional(z.union([z.array(z.string()), z.record(z.string(), eventValueSchema)])),
});

const agentDefinitionSchema = z.strictObject({
  // Editors point `$schema` at the published schema; the loader ignores it.
  $schema: z.optional(z.string()),
  name: z.optional(z.string().check(z.minLength(1))),
  description: z.optional(z.string()),
  runner: z.optional(z.string().check(z.minLength(1))),
  model: z.optional(modelSpecSchema),
  access: z.optional(accessSchema),
  mcp: z.optional(z.record(slug, mcpEntrySchema)),
  integrations: z._default(z.record(z.string(), definitionIntegrationSchema), {}),
});

const usageIntegrationSchema = z.strictObject({
  allowedEvents: z.optional(z.array(z.string())),
});

const agentUsageSchema = z.strictObject({
  connections: z.optional(z.array(z.string())),
  model: z.optional(modelSpecSchema),
  access: z.optional(accessSchema),
  integrations: z.optional(z.record(z.string(), usageIntegrationSchema)),
  disabled: z.optional(z.boolean()),
});

const agentsUsageSchema = z.record(slug, z.union([z.boolean(), agentUsageSchema]));

/** A stored definition carries the repository marker from its last parse; it is derived again, never read. */
function withoutMarkers(json: unknown): unknown {
  const mcp = (json as { mcp?: unknown } | null)?.mcp;
  if (!mcp || typeof mcp !== 'object') return json;

  return {
    ...(json as object),
    mcp: Object.fromEntries(
      Object.entries(mcp).map(([name, entry]) => {
        if (!entry || typeof entry !== 'object') return [name, entry];
        const { repository: _marker, ...rest } = entry as Record<string, unknown>;
        return [name, rest];
      }),
    ),
  };
}

/** Keys `agent.json` once had, with the key that took their place. */
const REPLACED: Record<string, string> = { permissions: 'access' };

/** A definition's issues in plain words, each naming its field and what to change. */
const problemsOf = (issues: ReadonlyArray<z.core.$ZodIssue>) =>
  issues.flatMap(issue =>
    issue.code === 'unrecognized_keys' && !issue.path.length
      ? issue.keys.map(key =>
          REPLACED[key]
            ? `${key} was replaced by ${REPLACED[key]}, remove ${key}`
            : `${key} is not an agent setting, remove it`,
        )
      : schemaIssues([issue]),
  );

/** Keys a stored definition has that Coder renamed, with their new name, or no longer reads; the editor fixes them. */
export function staleKeys(json: unknown): { renamed?: Record<string, string>; unknown?: string[] } {
  const keys = json && typeof json === 'object' ? Object.keys(json) : [];
  const stale = keys.filter(key => !(key in agentDefinitionSchema.shape));
  const renamed = Object.fromEntries(
    stale.filter(key => REPLACED[key]).map(key => [key, REPLACED[key]!]),
  );
  const unknown = stale.filter(key => !REPLACED[key]);

  return {
    ...(Object.keys(renamed).length ? { renamed } : {}),
    ...(unknown.length ? { unknown } : {}),
  };
}

/** What keeps a definition from loading, one line per problem; none when it is valid. */
export function definitionProblems(json: unknown): string[] {
  const parsed = agentDefinitionSchema.safeParse(withoutMarkers(json));
  return parsed.success ? [] : problemsOf(parsed.error.issues);
}

export function parseAgentDefinition(
  id: string,
  json: unknown,
  repository = true,
): AgentDefinition {
  const parsed = agentDefinitionSchema.safeParse(withoutMarkers(json));
  if (!parsed.success)
    throw new Error(
      `Invalid agent definition "${id}": ${problemsOf(parsed.error.issues).join('; ')}`,
    );
  const { $schema: _ignored, ...definition } = parsed.data;
  markRepositoryMcp(definition.mcp, repository);
  return definition as AgentDefinition;
}

export function parseAgentsUsage(json: unknown): Record<string, boolean | AgentUsage> {
  if (json === undefined) return {};
  const parsed = agentsUsageSchema.safeParse(json);
  if (!parsed.success)
    throw new Error(`Invalid agents usage: ${schemaIssues(parsed.error.issues).join('; ')}`);
  return Object.fromEntries(
    Object.entries(parsed.data).map(([id, usage]) => {
      if (typeof usage === 'boolean' || !usage.model) return [id, usage];
      const { model, ...rest } = usage;

      return [id, { ...rest, ...splitEngineSpec(model) }];
    }),
  );
}

/** Usage as `agents.<id>` in config takes it: its engine, model and effort as one `model` spec. */
export function usageEntry({ engine, model, effort, ...rest }: AgentUsage) {
  return engine || model
    ? { ...rest, model: [engine, model, effort].filter(Boolean).join('/') }
    : rest;
}

/** Event names a definition wires for one integration. */
export function definitionEvents(wiring: AgentDefinitionIntegration | undefined): string[] {
  if (!wiring?.events) return [];
  return Array.isArray(wiring.events) ? wiring.events : Object.keys(wiring.events);
}

/** Options for one wired event; `undefined` when the definition does not wire it. */
export function eventOptions(
  wiring: AgentDefinitionIntegration | undefined,
  type: string,
): AgentEventOptions | undefined {
  if (!wiring?.events) return undefined;
  if (Array.isArray(wiring.events)) return wiring.events.includes(type) ? {} : undefined;
  if (!Object.prototype.hasOwnProperty.call(wiring.events, type)) return undefined;
  const value = wiring.events[type]!;
  return value === true ? {} : value;
}

/** The definition with each match set on every integration that has its event; an empty regex clears it. */
export function withMatches(
  definition: AgentDefinition,
  matches: Record<string, string>,
): AgentDefinition {
  const integrations = Object.fromEntries(
    Object.entries(definition.integrations).map(([id, wiring]) => {
      const events = wiring.events ?? [];
      const map = Array.isArray(events) ? Object.fromEntries(events.map(e => [e, true])) : events;
      if (!Object.keys(map).some(event => event in matches)) return [id, wiring];
      const next = Object.entries(map).map(([event, value]) =>
        event in matches
          ? [event, matches[event] ? { match: matches[event] } : true]
          : [event, value],
      );
      return [id, { ...wiring, events: Object.fromEntries(next) }];
    }),
  );

  return { ...definition, integrations };
}

export function validateAgents(
  agents: Agent[],
  integrations: Record<string, Integration>,
): string[] {
  const errors: string[] = [];
  const known = Object.keys(integrations).sort().join(', ') || 'none';
  for (const agent of agents) {
    for (const [integrationId, wiring] of Object.entries(agent.definition.integrations)) {
      const prefix = `agents.${agent.id}.integrations.${integrationId}`;
      const integration = integrations[integrationId];
      if (!integration) {
        errors.push(`${prefix}: unknown integration; valid: ${known}`);
        continue;
      }
      const valid = Object.keys(integration.events).sort().join(', ') || 'none';
      for (const event of definitionEvents(wiring)) {
        if (!(event in integration.events))
          errors.push(`${prefix}.events.${event}: unknown event; valid: ${valid}`);
        const match = eventOptions(wiring, event)?.match;
        if (match !== undefined) {
          try {
            new RegExp(match);
          } catch {
            errors.push(`${prefix}.events.${event}.match: invalid regex`);
          }
        }
      }
    }
    for (const [integrationId, scope] of Object.entries(agent.usage?.integrations ?? {})) {
      const prefix = `agents.${agent.id}.integrations.${integrationId}`;
      const integration = integrations[integrationId];
      if (!integration) {
        errors.push(`${prefix}: unknown integration; valid: ${known}`);
        continue;
      }
      const valid = Object.keys(integration.events).sort().join(', ') || 'none';
      for (const event of scope.allowedEvents ?? []) {
        if (!(event in integration.events))
          errors.push(`${prefix}.allowedEvents: unknown event "${event}"; valid: ${valid}`);
      }
    }
  }
  return errors;
}

/** The agent's access: the definition's, lowered to read-only by its usage or the task's. */
export function agentAccess(agent: Pick<Agent, 'definition' | 'usage'>, task?: Access): Access {
  return strictestAccess(agent.definition.access, agent.usage?.access, task);
}

/** Effective events: the definition's, capped by the repo's `allowedEvents` when set. */
export function resolveEvents(agent: Agent, integrationId: string): string[] {
  const used = definitionEvents(agent.definition.integrations[integrationId]);
  const allow = agent.usage?.integrations?.[integrationId]?.allowedEvents;
  return allow === undefined ? used : used.filter(event => allow.includes(event));
}

/** Engine settings a task runs with: the usage's model choice, else the definition's. */
export function effectiveSettings(agent: {
  definition?: Pick<AgentDefinition, 'model'>;
  usage?: AgentUsage;
}): {
  engine?: string;
  model?: string;
  effort?: AgentUsage['effort'];
} {
  const { engine, model, effort } = agent.usage ?? {};
  if (engine || model) return { engine, model, effort };

  return agent.definition?.model ? splitEngineSpec(agent.definition.model) : {};
}

/** Effective tools for every integration the agent declares and the catalog knows. */
export function declaredTools(agent: Agent, access?: Access): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const id of Object.keys(agent.definition.integrations)) {
    const integration = INTEGRATIONS[id];
    if (integration) result[id] = integration.tools.presets[agentAccess(agent, access)];
  }
  return result;
}

/** Whether this one agent handles the event, and with which tools per integration. */
export function matchAgent(
  event: AgentEvent,
  agent: Agent,
  access?: Access,
): { tools: Record<string, string[]> } | undefined {
  const integration = INTEGRATIONS[event.integration];
  if (!integration) return undefined;
  if (!resolveEvents(agent, event.integration).includes(event.type)) return undefined;
  const options = eventOptions(agent.definition.integrations[event.integration], event.type);
  if (!options) return undefined;
  if (options.match !== undefined && !new RegExp(options.match).test(event.text)) return undefined;

  return { tools: declaredTools(agent, access) };
}

/** Local `coder agent run` helper: every agent the event matches. */
export function matchAgents(event: AgentEvent, agents: Agent[]) {
  return agents.flatMap(agent => {
    const match = matchAgent(event, agent);
    return match ? [{ agent, ...match }] : [];
  });
}
