/** The agent API the CLI and the SDK share: each call works on this repo's agents, or on a Coder server with `server`. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { connect, pushAgents, type ServerOptions } from '../core/remote';
import { CoderError } from '../core/dispatch';
import { runLogin } from '../runner/login';
import { prepareRepo, runTask } from '../runner/task';
import type { ServerAgent, TaskLogLine, TaskStatus } from '../server/store/types';
import type { UsageGroup } from '../server/tasks/usage';
import { execAgent, taskFromEvent } from './exec';
import { INTEGRATIONS } from '../integrations';
import { loadAgents } from './load';
import { matchAgents } from './match';
import { PRESETS, type Agent, type AgentDefinition, type AgentEvent, type Preset } from './types';

/** Where an agent call runs: this repo's agents under `cwd`, or the server named by `server`. */
export type AgentOptions = { cwd?: string } & ServerOptions;

const cwdOf = (opts: { cwd?: string }) => (opts.cwd ? path.resolve(opts.cwd) : process.cwd());

const list = (value?: string | string[]) =>
  (Array.isArray(value) ? value : (value ?? '').split(','))
    .map(item => item.trim())
    .filter(Boolean);

const ID = /^[a-z0-9][a-z0-9_-]*$/;

/** Why `id` cannot be a new agent under `cwd`: its format, or a folder already in use. */
export function agentIdError(cwd: string, id: string): string | undefined {
  if (!ID.test(id))
    return 'Use lowercase letters, digits, - or _, starting with a letter or digit.';
  const dir = path.join(cwd, '.coder', 'agents', id);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0)
    return `${path.relative(cwd, dir)} is not empty; clear it to start over, or edit what is there.`;
  return undefined;
}

export function regexError(value: string): string | undefined {
  try {
    new RegExp(value);
    return undefined;
  } catch {
    return 'Not a valid regular expression.';
  }
}

/** What an interactive `agent init` picked; flags fill these otherwise. */
export interface AgentPicks {
  name?: string;
  integrations: string[];
  events: Record<string, string[]>;
  matches: Record<string, Record<string, string>>;
  tools: Preset;
}

export interface AgentInitOptions {
  cwd?: string;
  name?: string;
  description?: string;
  permissions?: AgentDefinition['permissions'];
  integrations?: string | string[];
  triggers?: string | string[];
  tools?: string;
  /** `event=regex` pairs. */
  match?: string | string[];
  /** Asks for the id when none is given. */
  askId?: (validate: (id: string) => string | undefined) => Promise<string>;
  /** Asks for the picks instead of reading them from the options. */
  askPicks?: (id: string) => Promise<AgentPicks>;
}

function sampleEvent(integration: string, type: string): AgentEvent {
  const sample = INTEGRATIONS[integration]?.sample;
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
async function init(id: string | undefined, opts: AgentInitOptions = {}) {
  const cwd = cwdOf(opts);
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
        integrations: list(opts.integrations).length
          ? list(opts.integrations)
          : [Object.keys(INTEGRATIONS)[0]!],
        events: {},
        matches: {},
        tools: (opts.tools ?? 'comment') as Preset,
      };
  if (!PRESETS.includes(picks.tools))
    throw new CoderError(
      'invalid-option',
      `Unknown preset "${picks.tools}"; valid: ${PRESETS.join(', ')}`,
    );

  const integrations: AgentDefinition['integrations'] = {};
  const wanted = list(opts.triggers);
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
  const flagMatches = Object.fromEntries(
    list(opts.match).map(pair => {
      const at = pair.indexOf('=');
      if (at < 1) throw new CoderError('invalid-option', `Bad --match "${pair}"; use event=regex.`);
      const regex = pair.slice(at + 1);
      if (regexError(regex))
        throw new CoderError(
          'invalid-option',
          `Bad --match for ${pair.slice(0, at)}: ${regexError(regex)}`,
        );
      return [pair.slice(0, at), regex];
    }),
  );
  for (const integrationId of picks.integrations) {
    const names = known(integrationId);
    // --triggers applies to every integration that has the event; otherwise mention or the first.
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
    const match = { ...flagMatches, ...(picks.matches[integrationId] ?? {}) };
    const filtered = events.filter(e => match[e]);
    if (events.length)
      integrations[integrationId] = {
        triggers: filtered.length
          ? Object.fromEntries(events.map(e => [e, match[e] ? { match: match[e]! } : true]))
          : events,
        tools: picks.tools,
      };
  }

  const definition: AgentDefinition = {
    ...(picks.name ? { name: picks.name } : {}),
    ...(opts.description ? { description: opts.description } : {}),
    permissions: opts.permissions ?? 'read-only',
    integrations,
  };
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'agent.json'), `${JSON.stringify(definition, null, 2)}\n`);
  await fsp.writeFile(path.join(dir, 'system.md'), `You are ${picks.name ?? id}.\n`);

  // Sample events live outside the repo; they are fixtures for `coder agent run`, not part of the agent.
  const sampleDir = path.join(os.tmpdir(), 'coder-agent-samples', id);
  const samples: string[] = [];
  for (const [integrationId, wiring] of Object.entries(integrations)) {
    const type = (
      Array.isArray(wiring.triggers) ? wiring.triggers : Object.keys(wiring.triggers ?? {})
    )[0]!;
    await fsp.mkdir(sampleDir, { recursive: true });
    const file = path.join(sampleDir, `sample-${integrationId}-${type}.json`);
    await fsp.writeFile(file, `${JSON.stringify(sampleEvent(integrationId, type), null, 2)}\n`);
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

function since(value: number | string | undefined): number | undefined {
  if (value === undefined || typeof value === 'number') return value;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(\d+)([dh])$/.exec(value);
  if (!match)
    throw new CoderError('invalid-option', 'Invalid --since value.', {
      hint: 'Use 7d, 24h, or milliseconds since epoch',
    });
  return Date.now() - Number(match[1]) * (match[2] === 'd' ? 86_400_000 : 3_600_000);
}

export const agents = {
  /** This repo's agents, or the server's. */
  list: (opts: AgentOptions = {}): Promise<Agent[] | ServerAgent[]> =>
    opts.server !== undefined ? connect(opts).agents.list() : loadAgents(cwdOf(opts), INTEGRATIONS),

  /** One agent in full: a loaded agent here, or the server's record with its current definition. */
  async show(id: string | undefined, opts: AgentOptions = {}) {
    if (!id)
      throw new CoderError('invalid-option', 'Missing agent id.', {
        hint: 'Usage: coder agent show <id>',
      });
    if (opts.server === undefined) {
      const agent = (await loadAgents(cwdOf(opts), INTEGRATIONS)).find(
        candidate => candidate.id === id,
      );
      if (!agent)
        throw new CoderError('invalid-option', `No agent named "${id}".`, {
          hint: 'List agents: coder agent list',
        });
      return agent;
    }
    const api = connect(opts);
    const record = await api.agents.get(id);
    const version = await api.agents.version(id, record.currentVersion);
    return { ...record, definition: version.definition };
  },

  init,

  /** Upload this repo's agents (one, or all when `id` is omitted) to the server. */
  push: (id?: string, opts: AgentOptions = {}) => pushAgents(connect(opts), cwdOf(opts), id),

  /** Run an event (a value or a JSON file) through an agent here, or queue it on the server; `wait` follows its tasks. */
  async run(
    name: string | undefined,
    event: AgentEvent | string | undefined,
    opts: AgentOptions & {
      flow?: string;
      wait?: boolean;
      onLog?: (line: TaskLogLine) => void;
      onDone?: (status: TaskStatus) => void;
    } = {},
  ) {
    if (opts.wait && opts.server === undefined)
      throw new CoderError('invalid-option', '--wait needs --server.', {
        hint: 'Offline runs print their reply as they finish',
      });
    if (!name || !event)
      throw new CoderError('invalid-option', 'Missing agent id or event file.', {
        hint: 'Usage: coder agent run <agent> <event.json>',
      });
    const cwd = cwdOf(opts);
    const value =
      typeof event === 'string'
        ? (JSON.parse(await fsp.readFile(path.resolve(cwd, event), 'utf8')) as AgentEvent)
        : event;

    if (opts.server !== undefined) {
      const api = connect(opts);
      const queued = await api.tasks.create({ agent: name, event: value });
      if (!opts.wait || !queued.tasks.length) return queued;
      const outcomes: TaskStatus[] = [];
      for (const taskId of queued.tasks) {
        const status = await api.tasks.wait(taskId, { onLog: opts.onLog });
        outcomes.push(status);
        opts.onDone?.(status);
      }
      return outcomes;
    }

    const agents = await loadAgents(cwd, INTEGRATIONS);
    const agent = agents.find(candidate => candidate.id === name);
    if (!agent) throw new CoderError('invalid-option', `No agent named "${name}".`);
    const match = matchAgents(value, agents).find(candidate => candidate.agent.id === name);
    const flow = opts.flow ?? match?.flow;
    if (!flow)
      throw new CoderError(
        'invalid-option',
        `Agent "${name}" does not match event "${value.type}".`,
      );
    return execAgent({
      cwd,
      agent: name,
      flow,
      task: {
        ...taskFromEvent(agent, flow, value),
        tools: {},
        ...(match?.permissions ? { permissions: match.permissions } : {}),
      },
      post: false,
    });
  },

  /** Runner form of `agent run --task`: sign an engine in, prepare the repo, or run the task, as the env says. */
  runTask(id: string, opts: { cwd?: string } = {}): Promise<unknown> {
    const cwd = cwdOf(opts);
    if (process.env.CODER_LOGIN) return runLogin(id, cwd);
    return process.env.CODER_PREPARE ? prepareRepo(id, cwd) : runTask(id, cwd);
  },

  /** Usage totals since a time (`7d`, `24h` or epoch ms), from this machine's tasks or the server. */
  async usage(opts: AgentOptions & { since?: number | string; by?: string } = {}) {
    if (opts.by && !['agent', 'installation', 'engine'].includes(opts.by))
      throw new CoderError('invalid-option', 'Invalid --by value.', {
        hint: 'Use agent, installation, or engine',
      });
    const by = opts.by as UsageGroup | undefined;
    if (opts.server !== undefined) return connect(opts).usage({ since: since(opts.since), by });
    // Loaded on use, since the server's task code costs every other command.
    const [{ localUsage }, { usageSummary }] = await Promise.all([
      import('../server/tasks/local'),
      import('../server/tasks/usage'),
    ]);
    return usageSummary(
      localUsage(cwdOf(opts)).map(([, row]) => row),
      since(opts.since) ?? 0,
      by,
    );
  },

  integrations: {
    /** The integration catalog. */
    list: () =>
      Object.entries(INTEGRATIONS).map(([id, integration]) => ({
        id,
        description: integration.description,
        events: Object.keys(integration.events),
        tools: integration.tools.presets.write,
      })),
    /** One integration's events and tool presets. */
    show(id: string | undefined) {
      if (!id)
        throw new CoderError('invalid-option', 'Missing integration id.', {
          hint: 'Usage: coder agent integrations show <id>',
        });
      const integration = INTEGRATIONS[id];
      if (!integration)
        throw new CoderError('invalid-option', `Unknown integration "${id}".`, {
          hint: 'List integrations: coder agent integrations list',
        });
      return {
        id,
        events: Object.fromEntries(
          Object.entries(integration.events).map(([name, spec]) => [name, spec.description]),
        ),
        tools: integration.tools.presets,
      };
    },
  },
};
