/** Agent folders on disk: the shipped built-ins, `$CODER_HOME/agents` and the repo's `.coder/agents`, found, read and scaffolded. */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import coder from './builtin/coder/agent.json' with { type: 'json' };

import { ACCESS, loadConfig, resolveWorkspaceConfigFile, type Access } from '../core/config';
import { CoderError } from '../core/errors';
import { regexError } from '../utils/args';
import { coderHome, resolveWorkspaceRoot } from '../core/state';
import { parseAgentDefinition, parseAgentsUsage, validateAgents } from './definition';
import type { Integration } from '../integrations/types';
import type { Agent, AgentDefinition, AgentEvent, AgentUsage } from './types';

/** One definition folder as read from disk or from a remote repo. */
interface AgentSource {
  json: unknown;
  builtin: boolean;
  repository?: boolean;
  dir?: string;
}

export class AgentLoadError extends Error {}

const BUILTIN_DIR = fileURLToPath(new URL('./builtin/coder/', import.meta.url));
const BUILTINS = {
  coder: {
    json: coder,
    builtin: true,
    dir: BUILTIN_DIR,
    systemPrompt: fs.readFileSync(path.join(BUILTIN_DIR, 'system.md'), 'utf8'),
  },
};

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
    result[id] = { json, builtin, dir };
  }
  return result;
}

/** Every shipped agent folder holding an agent.json. */
export function builtinDefinitions(): Record<
  string,
  AgentSource & { dir: string; systemPrompt: string }
> {
  return BUILTINS;
}

/** Tasks naming no agent run Coder. */
export function defaultAgent(): string | undefined {
  return 'coder';
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
      throw new AgentLoadError(error instanceof Error ? error.message : String(error));
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
  if (errors.length) throw new AgentLoadError(`Invalid agents:\n  ${errors.join('\n  ')}`);
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

type IgnoreRule = { pattern: RegExp; negate: boolean; directory: boolean };

const GLOB: Record<string, string> = {
  '**/': '(?:.*/)?',
  '/**': '/.*',
  '**': '.*',
  '*': '[^/]*',
  '?': '[^/]',
};

/** Common `.gitignore` forms; no character classes or escaped leading `#` and `!`. */
function ignoreRules(text: string): IgnoreRule[] {
  return text.split(/\r?\n/).flatMap(line => {
    let rule = line.trimEnd();
    if (!rule || rule.startsWith('#')) return [];
    const negate = rule.startsWith('!');
    if (negate) rule = rule.slice(1);
    const directory = rule.endsWith('/');
    if (directory) rule = rule.slice(0, -1);
    const glob = rule
      .replace(/^\//, '')
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*\/|\/\*\*$|\*\*|\*|\?/g, token => GLOB[token]!);
    const anchored = rule.includes('/');
    return [
      {
        pattern: new RegExp(anchored ? `^${glob}$` : `^(?:.*/)?${glob}$`),
        negate,
        directory,
      },
    ];
  });
}

const ignored = (rules: IgnoreRule[], name: string, directory: boolean) =>
  rules.reduce(
    (result, rule) =>
      (!rule.directory || directory) && rule.pattern.test(name) ? !rule.negate : result,
    false,
  );

/** Every file under `root`, skipping symlinks and what the rules ignore. */
async function walk(root: string, rules: IgnoreRule[], relative = ''): Promise<string[]> {
  const names: string[] = [];
  for (const entry of await fs.promises.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const name = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory() && !ignored(rules, name, true))
      names.push(...(await walk(root, rules, name)));
    else if (entry.isFile() && !ignored(rules, name, false)) names.push(name);
  }
  return names;
}

/** Files git would add from the folder, or undefined outside a work tree. */
async function gitFiles(root: string): Promise<string[] | undefined> {
  const listed = await promisify(execFile)(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', '.'],
    { maxBuffer: 64 * 1024 * 1024 },
  ).catch(() => undefined);
  return listed?.stdout.split('\0').filter(Boolean);
}

/** Files in an agent folder besides `agent.json` and `system.md`, by relative path; ignored files stay local. */
export async function folderFiles(root: string): Promise<Record<string, string>> {
  const names =
    (await gitFiles(root)) ??
    (await walk(
      root,
      ignoreRules(
        await fs.promises.readFile(path.join(root, '.gitignore'), 'utf8').catch(() => ''),
      ),
    ));
  const result: Record<string, string> = {};
  for (const name of names) {
    if (name === 'agent.json' || name === 'system.md') continue;
    const file = path.join(root, name);
    if ((await fs.promises.lstat(file).catch(() => undefined))?.isFile())
      result[name] = await fs.promises.readFile(file, 'utf8');
  }
  return result;
}

const ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Why `id` cannot be a new agent under `cwd`: its format, or a folder already in use. */
function agentIdError(cwd: string, id: string): string | undefined {
  if (!ID.test(id))
    return 'Use lowercase letters, digits, - or _, starting with a letter or digit.';
  const dir = path.join(cwd, '.coder', 'agents', id);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0)
    return `${path.relative(cwd, dir)} is not empty; clear it to start over, or edit what is there.`;
  return undefined;
}

/** What an interactive `agent init` picked; flags fill these otherwise. */
export interface AgentPicks {
  name?: string;
  integrations: string[];
  events: Record<string, string[]>;
  matches: Record<string, Record<string, string>>;
  access: Access;
}

interface AgentInitOptions {
  cwd?: string;
  name?: string;
  description?: string;
  integrations?: string[];
  events?: string[];
  access?: string;
  /** Event to the regex its text must match. */
  matches?: Record<string, string>;
  /** Asks for the id when none is given. */
  askId?: (validate: (id: string) => string | undefined) => Promise<string>;
  /** Asks for the picks instead of reading them from the options. */
  askPicks?: (id: string) => Promise<AgentPicks>;
}

function sampleEvent(integration: string, type: string, sample?: string): AgentEvent {
  return {
    integration,
    type,
    appId: `${integration}:sample`,
    installationId: 'sample',
    deliveryId: 'sample-1',
    actor: { id: 'user-1', login: 'someone', role: 'member' },
    text: 'Replace me with the text a real event would carry.',
    ...(sample
      ? {
          chat: {
            thread: {
              _type: 'chat:Thread',
              adapterName: integration,
              channelId: sample.slice(0, sample.lastIndexOf(':')),
              id: sample,
              isDM: false,
            },
          },
        }
      : {}),
  };
}

/** Scaffold `.coder/agents/<id>/` from the integration catalog, plus sample events for `agent run`. */
export async function init(id: string | undefined, opts: AgentInitOptions = {}) {
  const { INTEGRATIONS } = await import('../integrations');
  const cwd = path.resolve(opts.cwd ?? '.');
  if (!id && opts.askId) id = await opts.askId(value => agentIdError(cwd, value));
  if (!id)
    throw new CoderError('invalid-option', 'Missing agent id.', {
      hint: 'Usage: coder agent init <id>',
    });
  const problem = agentIdError(cwd, id);
  if (problem)
    throw new CoderError(
      'invalid-option',
      problem.includes('not empty') ? problem : `Agent id "${id}": ${problem}`,
    );
  const dir = path.join(cwd, '.coder', 'agents', id);

  const picks: AgentPicks = opts.askPicks
    ? await opts.askPicks(id)
    : {
        ...(opts.name ? { name: opts.name } : {}),
        integrations: opts.integrations?.length
          ? opts.integrations
          : [Object.keys(INTEGRATIONS)[0]!],
        events: {},
        matches: {},
        access: (opts.access ?? 'auto') as Access,
      };
  if (!ACCESS.includes(picks.access))
    throw new CoderError(
      'invalid-option',
      `Unknown access "${picks.access}"; valid: ${ACCESS.join(', ')}`,
    );

  const integrations: AgentDefinition['integrations'] = {};
  const wanted = opts.events ?? [];
  const known = (id: string) => Object.keys(INTEGRATIONS[id]?.events ?? {});
  for (const integrationId of picks.integrations)
    if (!INTEGRATIONS[integrationId])
      throw new CoderError(
        'invalid-option',
        `Unknown integration "${integrationId}"; valid: ${Object.keys(INTEGRATIONS).join(', ')}`,
      );
  for (const event of wanted)
    if (!picks.integrations.some(id => known(id).includes(event)))
      throw new CoderError('invalid-option', `No chosen integration has event "${event}".`, {
        hint: 'Events per integration: coder agent integrations show <id>',
      });
  for (const [event, regex] of Object.entries(opts.matches ?? {}))
    if (regexError(regex))
      throw new CoderError('invalid-option', `Bad --match for ${event}: ${regexError(regex)}`);
  for (const integrationId of picks.integrations) {
    const names = known(integrationId);
    // --events applies to every integration that has the event; otherwise mention or the first.
    const events =
      picks.events[integrationId] ??
      (wanted.length
        ? wanted.filter(e => names.includes(e))
        : [names.includes('mention') ? 'mention' : names[0]!]);
    for (const event of events)
      if (!names.includes(event))
        throw new CoderError(
          'invalid-option',
          `${integrationId} has no event "${event}"; valid: ${names.join(', ')}`,
        );
    const match = { ...opts.matches, ...(picks.matches[integrationId] ?? {}) };
    const filtered = events.filter(e => match[e]);
    if (events.length)
      integrations[integrationId] = {
        events: filtered.length
          ? Object.fromEntries(events.map(e => [e, match[e] ? { match: match[e]! } : true]))
          : events,
      };
  }

  const definition: AgentDefinition = {
    ...(picks.name ? { name: picks.name } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    access: picks.access,
    integrations,
  };
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'agent.json'), `${JSON.stringify(definition, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'system.md'), '');

  // Sample events live outside the repo; they are fixtures for `coder agent run`, not part of the agent.
  const sampleDir = path.join(os.tmpdir(), 'coder-agent-samples', id);
  const samples: string[] = [];
  for (const [integrationId, wiring] of Object.entries(integrations)) {
    const type = (
      Array.isArray(wiring.events) ? wiring.events : Object.keys(wiring.events ?? {})
    )[0]!;
    await fsp.mkdir(sampleDir, { recursive: true });
    const file = path.join(sampleDir, `sample-${integrationId}-${type}.json`);
    const sample = sampleEvent(integrationId, type, INTEGRATIONS[integrationId]?.sample);
    await fsp.writeFile(file, `${JSON.stringify(sample, null, 2)}\n`);
    samples.push(file);
  }
  return {
    id,
    dir,
    files: ['agent.json', 'system.md'],
    samples,
    integrations: Object.keys(integrations),
  };
}
