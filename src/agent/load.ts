/** Finding agents: the shipped built-ins, `$CODER_HOME/agents` and the repo's `.coder/agents`, joined with their usage. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, resolveWorkspaceConfigFile } from '../core/config';
import { coderHome, resolveWorkspaceRoot } from '../core/state';
import { parseAgentDefinition, parseAgentsUsage, validateAgents } from './definition';
import type { Integration } from '../integrations/types';
import type { Agent } from './types';

/** The built-in agent every server has; it also answers its plain name. */
export const BUILTIN_AGENT = 'coder';

/** One definition folder as read from disk or from a remote repo. */
export interface AgentSource {
  json: unknown;
  builtin: boolean;
  dir?: string;
}

/** Built-in agent folders: `builtin/` next to this module in src, `dist/builtin/` once bundled. */
function builtinRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const candidate of [path.join(here, 'builtin'), here]) {
    if (fs.statSync(path.join(candidate, BUILTIN_AGENT), { throwIfNoEntry: false })?.isDirectory())
      return candidate;
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
    result[id] = {
      json: JSON.parse(fs.readFileSync(file, 'utf8')),
      builtin,
      dir,
    };
  }
  return result;
}

/** Every shipped agent folder holding an agent.json. */
export function builtinDefinitions(): Record<string, AgentSource & { dir: string }> {
  return definitionsIn(builtinRoot(), true);
}

/** Join definitions with usage. Built-ins and repo definitions are enabled unless usage says `false`. */
export function agentsFromSources(
  sources: { definitions: Record<string, AgentSource>; usage: unknown },
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
    const entry = usage[id];
    if (entry === false) continue;
    const definition = parseAgentDefinition(id, source.json);
    agents.push({
      id,
      name: definition.name ?? id,
      definition,
      ...(typeof entry === 'object' ? { usage: entry } : {}),
      ...(source.dir ? { dir: source.dir } : {}),
      builtin: source.builtin,
    });
  }
  const errors = validateAgents(agents, integrations);
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

export async function loadAgents(
  root: string,
  integrations: Record<string, Integration>,
): Promise<Agent[]> {
  root = path.resolve(root);
  const definitions: Record<string, AgentSource> = { ...builtinDefinitions() };
  const home = definitionsIn(coderHome('agents'));
  const repo = definitionsIn(path.join(root, '.coder', 'agents'));
  assertNotReserved([...Object.keys(home), ...Object.keys(repo)]);
  Object.assign(definitions, home, repo);
  const usage = { ...loadConfig(root).agents };
  // An unknown id in the user config belongs to another repo; in the repo's own config it is a typo.
  const repoFile = resolveWorkspaceConfigFile(resolveWorkspaceRoot(root));
  const repoUsage = fs.existsSync(repoFile)
    ? (JSON.parse(fs.readFileSync(repoFile, 'utf8')).agents ?? {})
    : {};
  for (const id of Object.keys(usage))
    if (!(id in definitions) && !(id in repoUsage)) delete usage[id];
  return agentsFromSources({ definitions, usage }, integrations, root);
}
