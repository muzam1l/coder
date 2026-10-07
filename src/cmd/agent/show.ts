/** `coder agent show <id>`: one agent's settings, triggers and tools. */
import path from 'node:path';
import process from 'node:process';

import type { agents } from '../../agent';
import { outStyle, renderTable } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { isLocal } from './list';

const serverOptions = { server: optStr, workspace: str, yes: flag };

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
    ['engine', usage?.engine ?? def.engine],
    ['model', usage?.model ?? def.model],
    ['effort', usage?.effort ?? def.effort],
  ];
  const width = Math.max(...facts.map(([k]) => k.length)) + 2;

  for (const [key, value] of facts)
    if (value) process.stdout.write(`${s.dim(key.padEnd(width))}${value}\n`);

  type Row = { id: string; events: string; tools: string };
  const rows: Row[] = Object.entries(def.integrations).map(([integrationId, wiring]) => {
    const cap = usage?.integrations?.[integrationId];
    const events = Array.isArray(wiring.triggers)
      ? wiring.triggers
      : Object.keys(wiring.triggers ?? {});
    const allowed = cap?.allowedEvents
      ? events.filter(e => cap.allowedEvents!.includes(e))
      : events;
    const tools = cap?.allowedTools ?? wiring.tools;
    return {
      id: integrationId,
      events: allowed.join(', ') || '-',
      tools: Array.isArray(tools) ? tools.join(', ') : (tools ?? '-'),
    };
  });

  process.stdout.write(
    `\n${renderTable<Row>(
      [
        { header: 'integration', value: r => r.id, paint: c => s.cyan(c) },
        { header: 'events', value: r => r.events },
        { header: 'tools', value: r => r.tools },
      ],
      rows,
      { style: s, border: true },
    )}`,
  );
}

export const commandAgentShow = command({
  name: 'agent show',
  help: {
    usage: 'coder agent show <id> [--server [url]] [--json] [--cwd <dir>]',
    summary:
      'Describe one agent as it will run here, or its active version on a server: its settings and per-integration triggers and tools.',
    flags: [SERVER_FLAG],
    examples: [['coder agent show coder', 'what the built-in agent listens to and may do']],
  },
  options: { ...baseOptions, ...serverOptions },
  args: 1,
  run: async ({ options, args: [id], cwd }) => {
    const { agents } = await import('../../agent');
    return agents.show(id, { ...options, cwd, organization: options.workspace });
  },
  json: (agent, { cwd }) => agentDetail(agent, cwd),
  print: (agent, { cwd }) => printAgentDetail(agentDetail(agent, cwd)),
});
