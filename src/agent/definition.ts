/** What an agent is: the `agent.json` schema, how a repo runs it (`agents` in config), and the settings it resolves to. */
import * as z from 'zod/mini';

import { mcpEntrySchema, type Permission } from '../core/config';
import { markRepositoryMcp } from '../core/mcp';
import type { Integration } from '../integrations/types';
import type {
  Agent,
  AgentDefinition,
  AgentDefinitionIntegration,
  AgentEventOptions,
  AgentUsage,
  Preset,
} from './types';

const slug = z.string().check(z.regex(/^[a-z0-9][a-z0-9_-]*$/i, 'agent or flow name'));
const effort = z.enum(['low', 'medium', 'high']);
const permissions = z.enum(['read-only', 'workspace-write', 'auto']);
const access = z.enum(['read', 'write']);

const eventOptionsSchema = z.strictObject({
  flow: z.optional(slug),
  match: z.optional(z.string().check(z.minLength(1))),
  permissions: z.optional(permissions),
  actAs: z.optional(z.literal('requester')),
});

const definitionIntegrationSchema = z.strictObject({
  events: z.optional(
    z.union([
      z.array(z.string()),
      z.record(z.string(), z.union([slug, eventOptionsSchema, z.literal(true)])),
    ]),
  ),
});

const agentDefinitionSchema = z.strictObject({
  // Editors point `$schema` at the published schema; the loader ignores it.
  $schema: z.optional(z.string()),
  name: z.optional(z.string().check(z.minLength(1))),
  description: z.optional(z.string()),
  engine: z.optional(z.string()),
  runner: z.optional(z.string().check(z.minLength(1))),
  model: z.optional(z.string()),
  effort: z.optional(effort),
  permissions: z.optional(permissions),
  access: z.optional(access),
  mcp: z.optional(z.record(slug, mcpEntrySchema)),
  integrations: z._default(z.record(z.string(), definitionIntegrationSchema), {}),
});

const usageIntegrationSchema = z.strictObject({
  allowedEvents: z.optional(z.array(z.string())),
});

const agentUsageSchema = z.strictObject({
  connections: z.optional(z.array(z.string())),
  engine: z.optional(z.string()),
  model: z.optional(z.string()),
  effort: z.optional(effort),
  permissions: z.optional(permissions),
  access: z.optional(access),
  integrations: z.optional(z.record(z.string(), usageIntegrationSchema)),
  disabled: z.optional(z.boolean()),
});

const agentsUsageSchema = z.record(slug, z.union([z.boolean(), agentUsageSchema]));

function issues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

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

export function parseAgentDefinition(
  id: string,
  json: unknown,
  repository = true,
): AgentDefinition {
  const parsed = agentDefinitionSchema.safeParse(withoutMarkers(json));
  if (!parsed.success) throw new Error(`Invalid agent definition "${id}": ${issues(parsed.error)}`);
  const { $schema: _ignored, ...definition } = parsed.data;
  markRepositoryMcp(definition.mcp, repository);
  return definition as AgentDefinition;
}

export function parseAgentsUsage(json: unknown): Record<string, boolean | AgentUsage> {
  if (json === undefined) return {};
  const parsed = agentsUsageSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid agents usage: ${issues(parsed.error)}`);
  return parsed.data as Record<string, boolean | AgentUsage>;
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
  return value === true ? {} : typeof value === 'string' ? { flow: value } : value;
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

/** The agent's one access mode: the definition's, lowered to Read-only by its usage. */
export function agentAccess(agent: Pick<Agent, 'definition' | 'usage'>): Preset {
  return agent.definition.access === 'read' || agent.usage?.access === 'read' ? 'read' : 'write';
}

/** Effective events: the definition's, capped by the repo's `allowedEvents` when set. */
export function resolveEvents(agent: Agent, integrationId: string): string[] {
  const used = definitionEvents(agent.definition.integrations[integrationId]);
  const allow = agent.usage?.integrations?.[integrationId]?.allowedEvents;
  return allow === undefined ? used : used.filter(event => allow.includes(event));
}

/** Engine and permission settings a task runs with: usage overrides definition. */
export function effectiveSettings(agent: Agent): {
  engine?: string;
  model?: string;
  effort?: AgentUsage['effort'];
  permissions: Permission;
} {
  return {
    engine: agent.usage?.engine ?? agent.definition.engine,
    model: agent.usage?.model ?? agent.definition.model,
    effort: agent.usage?.effort ?? agent.definition.effort,
    permissions: agent.usage?.permissions ?? agent.definition.permissions ?? 'auto',
  };
}

const PERMISSION_RANK: Record<Permission, number> = {
  'read-only': 0,
  'workspace-write': 1,
  auto: 2,
};

/** Return `requested` only when it does not broaden `maximum`. */
export function narrowPermission(maximum: Permission, requested?: Permission): Permission {
  return requested && PERMISSION_RANK[requested] <= PERMISSION_RANK[maximum] ? requested : maximum;
}
