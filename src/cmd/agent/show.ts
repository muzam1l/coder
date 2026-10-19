/** `coder agent show <id>`: one agent's settings and events. */
import path from 'node:path';
import process from 'node:process';

import type { agents } from '../../agent';
import { outStyle, renderTable } from '../../tui/output';
import { serverOptions, str } from '../../utils/args';
import { command } from '../../cli';
import { isLocal } from './list';

type AgentDetail = Awaited<ReturnType<typeof agents.show>>;

/** A repo agent names its folder relative to `cwd`. */
function agentDetail(agent: AgentDetail, cwd: string) {
  if (!isLocal(agent))
    return {
      id: agent.id,
      name: agent.name,
      source: agent.source,
      definition: agent.definition,
      ...(agent.settings ? { usage: agent.settings } : {}),
    };
  return {
    id: agent.id,
    name: agent.name,
    source: agent.builtin ? 'builtin' : 'repo',
    ...(agent.dir && !agent.builtin ? { dir: path.relative(cwd, agent.dir) } : {}),
    definition: agent.definition,
    ...(agent.usage ? { usage: agent.usage } : {}),
  };
}

function printAgentDetail(detail: ReturnType<typeof agentDetail>): void {
  const s = outStyle;
  const { definition: def, usage } = detail;
  const dir = 'dir' in detail ? detail.dir : undefined;
  const facts: [string, string | undefined][] = [
    ['name', detail.name],
    ['source', dir ? `${detail.source} (${dir})` : detail.source],
    ['description', def.description],
    ['permissions', usage?.permissions ?? def.permissions],
    ['access', usage?.access === 'read' || def.access === 'read' ? 'Read-only' : 'Read-write'],
    ['engine', usage?.engine ?? def.engine],
    ['model', usage?.model ?? def.model],
    ['effort', usage?.effort ?? def.effort],
  ];
  const width = Math.max(...facts.map(([k]) => k.length)) + 2;

  for (const [key, value] of facts)
    if (value) process.stdout.write(`${s.dim(key.padEnd(width))}${value}\n`);

  type Row = { id: string; events: string };
  const rows: Row[] = Object.entries(def.integrations).map(([integrationId, wiring]) => {
    const cap = usage?.integrations?.[integrationId];
    const events = Array.isArray(wiring.events) ? wiring.events : Object.keys(wiring.events ?? {});
    const allowed = cap?.allowedEvents
      ? events.filter(e => cap.allowedEvents!.includes(e))
      : events;
    return { id: integrationId, events: allowed.join(', ') || '-' };
  });

  process.stdout.write(
    `\n${renderTable<Row>(
      [
        { header: 'integration', value: r => r.id, paint: c => s.cyan(c) },
        { header: 'events', value: r => r.events },
      ],
      rows,
      { style: s, border: true },
    )}`,
  );
}

export const commandAgentShow = command({
  name: 'show',
  description: 'one agent in full: settings, integrations, events, tools',
  usage:
    'Describe one agent as it will run here, or its active version on a server: its settings, access and per-integration events.',
  access: 'read',
  args: { id: str('the agent'), ...serverOptions },
  cli: {
    positional: ['id'],
    examples: ['coder agent show coder  # what the built-in agent listens to and may do'],
  },
  run: async ({ options, args: [id], cwd }) => {
    const { agents } = await import('../../agent');
    return agents.show(id, { ...options, cwd, organization: options.workspace });
  },
  json: (agent, { cwd }) => agentDetail(agent, cwd),
  print: (agent, { cwd }) => printAgentDetail(agentDetail(agent, cwd)),
});
