/** The agent API the CLI and the SDK share: each call works on this repo's agents, or on a Coder server with `server`. */
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { connect, pushAgents, type ServerOptions } from '../core/remote';
import { CoderError } from '../core/dispatch';
import type { ServerAgent, TaskLogLine, TaskStatus } from '../server/store/types';
import type { UsageGroup } from '../server/tasks/usage';
import { matchAgents, usageEntry, withMatches } from './definition';
import { execAgent, taskFromEvent } from './exec';
import { INTEGRATIONS } from '../integrations';
import { init, loadAgents } from './load';
import type { Agent, AgentEvent } from './types';

/** Where an agent call runs: this repo's agents under `cwd`, or the server named by `server`. */
type AgentOptions = { cwd?: string } & ServerOptions;

const cwdOf = (opts: { cwd?: string }) => (opts.cwd ? path.resolve(opts.cwd) : process.cwd());

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
    const record = await api.agents.get(id, { installations: true });
    const version = await api.agents.version(id, record.currentVersion);
    return { ...record, definition: version.definition };
  },

  /** This agent's settings on the server; the ones not given stay. */
  async settings(
    id: string | undefined,
    opts: AgentOptions & {
      model?: string;
      access?: string;
      connections?: string[];
      /** Platform to the events it answers there. */
      events?: Record<string, string[]>;
      instructions?: string;
      /** Event to the regex its text must match; an empty regex clears it. */
      matches?: Record<string, string>;
    },
  ) {
    if (!id)
      throw new CoderError('invalid-option', 'Missing agent id.', {
        hint: 'Usage: coder agent settings <id> --model <name[/effort]|engine/model[/effort]>',
      });
    const change: Record<string, unknown> = Object.fromEntries(
      (['model', 'access'] as const).flatMap(key => (opts[key] ? [[key, opts[key]]] : [])),
    );
    if (opts.connections !== undefined) change.connections = opts.connections;
    const events = Object.entries(opts.events ?? {});
    const matches = opts.matches ?? {};
    const version = opts.instructions !== undefined || Object.keys(matches).length;
    if (!Object.keys(change).length && !events.length && !version)
      throw new CoderError(
        'invalid-option',
        'Give --model, --access, --connections, --events, --instructions or --match.',
      );
    const api = connect(opts);
    const record = await api.agents.get(id);
    if (events.length)
      change.integrations = {
        ...record.settings?.integrations,
        ...Object.fromEntries(
          events.map(([platform, allowedEvents]) => [platform, { allowedEvents }]),
        ),
      };
    // A change that waits for approval leaves the others to go ahead; every wait is told at the end.
    const waiting: CoderError[] = [];
    const held = <T>(work: Promise<T>) =>
      work.catch((error: unknown) => {
        if (!(error instanceof CoderError) || error.code !== 'approval-pending') throw error;
        waiting.push(error);
      });
    // Instructions and matches are the agent's definition: they publish its next version.
    if (version) {
      const current = await api.agents.version(id, record.currentVersion);
      await held(
        api.agents.put(id, {
          definition: withMatches(current.definition, matches),
          systemPrompt: opts.instructions ?? current.systemPrompt,
          ...(current.files ? { files: current.files } : {}),
        }),
      );
    }
    const settings = usageEntry(record.settings ?? {});
    const saved = Object.keys(change).length
      ? await held(api.agents.settings(id, { ...settings, ...change }))
      : undefined;
    if (waiting.length)
      throw new CoderError('approval-pending', waiting.map(error => error.message).join(' '), {
        approval: waiting[0]!.approval,
      });

    return saved ?? api.agents.get(id);
  },

  init,

  /** Upload this repo's agents (one, or all when `id` is omitted) to the server. */
  push: (id?: string, opts: AgentOptions = {}) => pushAgents(connect(opts), cwdOf(opts), id),

  /** Run an event (a value or a JSON file) through an agent here, or queue it on the server; `wait` follows its tasks. */
  async run(
    name: string | undefined,
    event: AgentEvent | string | undefined,
    opts: AgentOptions & {
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
    if (!matchAgents(value, agents).some(candidate => candidate.agent.id === name))
      throw new CoderError(
        'invalid-option',
        `Agent "${name}" does not match event "${value.type}".`,
      );
    return execAgent({
      cwd,
      agent: name,
      flow: 'default',
      task: {
        ...taskFromEvent(agent, value),
        tools: {},
      },
      post: false,
    });
  },

  /** Usage totals since a time in epoch ms, from this machine's tasks or the server. */
  async usage(opts: AgentOptions & { since?: number; by?: string } = {}) {
    if (opts.by && !['agent', 'installation', 'engine'].includes(opts.by))
      throw new CoderError('invalid-option', 'Invalid --by value.', {
        hint: 'Use agent, installation, or engine',
      });
    const by = opts.by as UsageGroup | undefined;
    if (opts.server !== undefined) return connect(opts).usage({ since: opts.since, by });
    // Loaded on use, since the server's task code costs every other command.
    const [{ localUsage }, { usageSummary }] = await Promise.all([
      import('../server/tasks/local'),
      import('../server/tasks/usage'),
    ]);
    return usageSummary(
      localUsage(cwdOf(opts)).map(([, row]) => row),
      opts.since ?? 0,
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
        tools: integration.tools.presets.auto,
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
