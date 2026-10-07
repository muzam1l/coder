/** What an agent is: the `agent.json` schema, how a repo runs it (`agents` in config), and the settings it resolves to. */
import * as z from 'zod/mini';

import { mcpEntrySchema, type Permission } from '../core/config';
import type { Integration } from '../integrations/types';
import {
  PRESETS,
  type Agent,
  type AgentDefinition,
  type AgentDefinitionIntegration,
  type AgentEventOptions,
  type AgentUsage,
  type Preset,
} from './types';

const slug = z.string().check(z.regex(/^[a-z0-9][a-z0-9_-]*$/i, 'agent or flow name'));
const effort = z.enum(['low', 'medium', 'high']);
const permissions = z.enum(['read-only', 'workspace-write', 'auto']);
const preset = z.enum(['observe', 'comment', 'write']);
const tools = z.union([preset, z.array(z.string())]);

const eventOptionsSchema = z.strictObject({
  flow: z.optional(slug),
  match: z.optional(z.string().check(z.minLength(1))),
  permissions: z.optional(permissions),
  actAs: z.optional(z.literal('requester')),
});

const definitionIntegrationSchema = z.strictObject({
  triggers: z.optional(
    z.union([
      z.array(z.string()),
      z.record(z.string(), z.union([slug, eventOptionsSchema, z.literal(true)])),
    ]),
  ),
  tools: z.optional(tools),
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
  mcp: z.optional(z.record(slug, mcpEntrySchema)),
  integrations: z._default(z.record(z.string(), definitionIntegrationSchema), {}),
});

const usageIntegrationSchema = z.strictObject({
  allowedTools: z.optional(tools),
  allowedEvents: z.optional(z.array(z.string())),
});

const agentUsageSchema = z.strictObject({
  engine: z.optional(z.string()),
  model: z.optional(z.string()),
  effort: z.optional(effort),
  permissions: z.optional(permissions),
  integrations: z.optional(z.record(z.string(), usageIntegrationSchema)),
});

const agentsUsageSchema = z.record(slug, z.union([z.boolean(), agentUsageSchema]));

function issues(error: {
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>;
}): string {
  return error.issues
    .map(issue => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

export function parseAgentDefinition(id: string, json: unknown): AgentDefinition {
  const parsed = agentDefinitionSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid agent definition "${id}": ${issues(parsed.error)}`);
  const { $schema: _ignored, ...definition } = parsed.data;
  return definition as AgentDefinition;
}

export function parseAgentsUsage(json: unknown): Record<string, boolean | AgentUsage> {
  if (json === undefined) return {};
  const parsed = agentsUsageSchema.safeParse(json);
  if (!parsed.success) throw new Error(`Invalid agents usage: ${issues(parsed.error)}`);
  return parsed.data as Record<string, boolean | AgentUsage>;
}

/** Event names a definition wires for one integration. */
function definitionEvents(wiring: AgentDefinitionIntegration | undefined): string[] {
  if (!wiring?.triggers) return [];
  return Array.isArray(wiring.triggers) ? wiring.triggers : Object.keys(wiring.triggers);
}

/** Options for one wired event; `undefined` when the definition does not wire it. */
export function eventOptions(
  wiring: AgentDefinitionIntegration | undefined,
  type: string,
): AgentEventOptions | undefined {
  if (!wiring?.triggers) return undefined;
  if (Array.isArray(wiring.triggers)) return wiring.triggers.includes(type) ? {} : undefined;
  if (!Object.prototype.hasOwnProperty.call(wiring.triggers, type)) return undefined;
  const value = wiring.triggers[type]!;
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
          errors.push(`${prefix}.triggers.${event}: unknown event; valid: ${valid}`);
        const match = eventOptions(wiring, event)?.match;
        if (match !== undefined) {
          try {
            new RegExp(match);
          } catch {
            errors.push(`${prefix}.triggers.${event}.match: invalid regex`);
          }
        }
      }
      errors.push(...toolErrors(`${prefix}.tools`, wiring.tools, integration));
    }
    for (const [integrationId, scope] of Object.entries(agent.usage?.integrations ?? {})) {
      const prefix = `agents.${agent.id}.integrations.${integrationId}`;
      const integration = integrations[integrationId];
      if (!integration) {
        errors.push(`${prefix}: unknown integration; valid: ${known}`);
        continue;
      }
      errors.push(...toolErrors(`${prefix}.allowedTools`, scope.allowedTools, integration));
      const valid = Object.keys(integration.events).sort().join(', ') || 'none';
      for (const event of scope.allowedEvents ?? []) {
        if (!(event in integration.events))
          errors.push(`${prefix}.allowedEvents: unknown event "${event}"; valid: ${valid}`);
      }
    }
  }
  return errors;
}

function toolErrors(
  prefix: string,
  tools: Preset | string[] | undefined,
  integration: Integration,
): string[] {
  if (tools === undefined) return [];
  if (typeof tools === 'string') {
    return PRESETS.includes(tools)
      ? []
      : [`${prefix}: unknown preset "${tools}"; valid: ${PRESETS.join(', ')}`];
  }
  const valid = new Set(Object.values(integration.tools.presets).flat());
  return tools
    .filter(tool => !valid.has(tool))
    .map(
      tool => `${prefix}: unknown tool "${tool}"; valid: ${[...valid].sort().join(', ') || 'none'}`,
    );
}

function expand(tools: Preset | string[], integration: Integration): string[] {
  if (Array.isArray(tools)) return [...new Set(tools)];
  const through = PRESETS.indexOf(tools);
  return [
    ...new Set(
      PRESETS.slice(0, through + 1).flatMap(preset => integration.tools.presets[preset] ?? []),
    ),
  ];
}

/** Effective tools: what the definition uses, capped by the repo's `allowedTools` when set. */
export function resolveTools(
  agent: Agent,
  integrationId: string,
  integration: Integration,
): string[] {
  const used = expand(
    agent.definition.integrations[integrationId]?.tools ?? 'observe',
    integration,
  );
  const allow = agent.usage?.integrations?.[integrationId]?.allowedTools;
  if (allow === undefined) return used;
  const capped = new Set(expand(allow, integration));
  return used.filter(tool => capped.has(tool));
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
    permissions: agent.usage?.permissions ?? agent.definition.permissions ?? 'read-only',
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
