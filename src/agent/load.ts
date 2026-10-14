/** Finding agents: the shipped built-ins, `$CODER_HOME/agents` and the repo's `.coder/agents`, joined with their usage. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveWorkspaceConfigFile } from '../core/config';
import { coderHome, resolveWorkspaceRoot } from '../core/state';
import { parseAgentDefinition, parseAgentsUsage, validateAgents } from './definition';
import type { Integration } from '../integrations/types';
import type { Agent, AgentDefinition, AgentUsage } from './types';

/** One definition folder as read from disk or from a remote repo. */
export interface AgentSource {
  json: unknown;
  builtin: boolean;
  repository?: boolean;
  dir?: string;
  /** A built-in marked `"default": true`: tasks that name no agent run it. */
  default?: true;
}

/** Built-in agent folders: `builtin/` next to this module in src, `dist/builtin/` once bundled; a literal URL so bundlers ship the folder. */
function builtinRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [fileURLToPath(new URL('./builtin/', import.meta.url)), here]) {
    if (Object.keys(definitionsIn(candidate)).length) return candidate;
  }
  return here;
}

/** One agent per folder of `base` that holds an `agent.json`. */
function definitionsIn(
  base: string,
  builtin = false,
): Record<string, AgentSource & { dir: string }> {
  const result: Record<string, AgentSource & { dir: string }> = {};
  let ids: string[];
  try {
    ids = fs
      .readdirSync(base, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => e.name);
  } catch {
    return result;
  }
  for (const id of ids) {
    const dir = path.join(base, id);
    const file = path.join(dir, 'agent.json');
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) continue;
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    const preferred = builtin && json.default === true;
    if (builtin) delete json.default;
    result[id] = { json, builtin, dir, ...(preferred ? { default: true as const } : {}) };
  }
  return result;
}

/** Every shipped agent folder holding an agent.json. */
export function builtinDefinitions(): Record<string, AgentSource & { dir: string }> {
  return definitionsIn(builtinRoot(), true);
}

/** The built-in marked `"default": true`, which tasks naming no agent run. */
export function defaultAgent(): string | undefined {
  return Object.entries(builtinDefinitions()).find(([, source]) => source.default)?.[0];
}

/** A built-in declares every platform and event; a server keeps the ones its catalog has. */
function enabledOnly(
  definition: AgentDefinition,
  integrations: Record<string, Integration>,
): AgentDefinition {
  const kept = Object.entries(definition.integrations).flatMap(([id, wiring]) => {
    const known = integrations[id]?.events;
    if (!known) return [];
    const events = Array.isArray(wiring.events)
      ? wiring.events.filter(event => event in known)
      : wiring.events &&
        Object.fromEntries(Object.entries(wiring.events).filter(([event]) => event in known));

    return [[id, { ...wiring, ...(events ? { events } : {}) }]];
  });

  return { ...definition, integrations: Object.fromEntries(kept) };
}

/** Join definitions with usage. Built-ins and repo definitions are enabled unless usage disables them. */
export function agentsFromSources(
  sources: { definitions: Record<string, AgentSource>; usage: unknown; includeDisabled?: boolean },
  integrations: Record<string, Integration>,
  cwd?: string,
): Agent[] {
  const usage = parseAgentsUsage(sources.usage);
  const unknown = Object.keys(usage).filter(id => !(id in sources.definitions));
  if (unknown.length) {
    const ids = Object.keys(sources.definitions).sort().join(', ') || 'none';
    throw new Error(
      `Invalid agents:\n  agents.${unknown.sort().join(', agents.')}: no agent definition; known ids: ${ids}`,
    );
  }
  const agents: Agent[] = [];
  for (const [id, source] of Object.entries(sources.definitions)) {
    const value = usage[id];
    const entry = value === false ? { disabled: true } : value;
    const disabled = typeof entry === 'object' && entry.disabled;
    if (disabled && !sources.includeDisabled) continue;
    let parsed: AgentDefinition;
    try {
      parsed = parseAgentDefinition(id, source.json, source.repository ?? !source.builtin);
    } catch (error) {
      // A disabled agent that does not parse is left out, not blocking the runnable ones.
      if (disabled) continue;
      throw error;
    }
    const definition = source.builtin ? enabledOnly(parsed, integrations) : parsed;
    agents.push({
      id,
      name: definition.name ?? id,
      definition,
      ...(typeof entry === 'object' ? { usage: entry } : {}),
      ...(source.dir ? { dir: source.dir } : {}),
      builtin: source.builtin,
    });
  }
  const errors = validateAgents(
    agents.filter(agent => !agent.usage?.disabled),
    integrations,
  );
  if (errors.length) throw new Error(`Invalid agents:\n  ${errors.join('\n  ')}`);
  return agents;
}

/** Throws when a repo definition reuses a built-in id; built-ins are never shadowed. */
export function assertNotReserved(ids: string[]): void {
  const reserved = ids.filter(id => id in builtinDefinitions()).sort();
  if (reserved.length)
    throw new Error(
      `Invalid agents:\n  agents.${reserved.join(', agents.')}: built-in agent ids are reserved`,
    );
}

/** The repo's `.coder/config.json` and its `agents` usage. */
function repoAgentsUsage(root: string): {
  file: string;
  usage: Record<string, boolean | AgentUsage>;
} {
  const file = resolveWorkspaceConfigFile(resolveWorkspaceRoot(path.resolve(root)));
  const usage = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')).agents ?? {}) : {};

  return { file, usage };
}

/** The repo config file when its `agents.<id>` overrides `disabled` set in the user config. */
export function repoAgentOverride(root: string, id: string, disabled: boolean): string | undefined {
  const { file, usage } = repoAgentsUsage(root);
  const entry = usage[id];
  const repoDisabled = typeof entry === 'boolean' ? !entry : entry?.disabled;

  return repoDisabled === undefined || repoDisabled === disabled ? undefined : file;
}

export async function loadAgents(
  root: string,
  integrations: Record<string, Integration>,
  { includeDisabled = false } = {},
): Promise<Agent[]> {
  root = path.resolve(root);
  const definitions: Record<string, AgentSource> = { ...builtinDefinitions() };
  const home: Record<string, AgentSource> = definitionsIn(coderHome('agents'));
  for (const source of Object.values(home)) source.repository = false;
  const repo = definitionsIn(path.join(root, '.coder', 'agents'));
  assertNotReserved([...Object.keys(home), ...Object.keys(repo)]);
  Object.assign(definitions, home, repo);
  const usage = { ...loadConfig(root).agents };
  // An unknown id in the user config belongs to another repo; in the repo's own config it is a typo.
  const { usage: repoUsage } = repoAgentsUsage(root);
  for (const id of Object.keys(usage))
    if (!(id in definitions) && !(id in repoUsage)) delete usage[id];
  return agentsFromSources({ definitions, usage, includeDisabled }, integrations, root);
}
