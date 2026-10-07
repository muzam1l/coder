/** `coder agent list`: this repo's agents, or a server's with --server. */
import process from 'node:process';

import type { Agent } from '../../agent/types';
import type { ServerAgent } from '../../server/store/types';
import { formatHints, outStyle, renderTable } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

export const isLocal = (agent: Agent | ServerAgent): agent is Agent => 'builtin' in agent;

/** A server's agents carry their version. */
const agentRows = (list: Agent[] | ServerAgent[]) =>
  list.map(agent =>
    isLocal(agent)
      ? {
          id: agent.id,
          name: agent.name,
          source: agent.builtin ? 'builtin' : 'repo',
          description: agent.definition.description ?? null,
        }
      : {
          id: agent.id,
          name: agent.name,
          source: agent.source,
          version: agent.currentVersion,
          description: agent.description ?? null,
        },
  );

function printAgents(rows: ReturnType<typeof agentRows>, server: boolean): void {
  if (!rows.length) return void process.stdout.write('No agents configured.\n');
  const s = outStyle;
  process.stdout.write(
    renderTable(
      [
        { header: 'id', value: r => r.id, paint: c => s.cyan(c) },
        { header: 'name', value: r => r.name },
        { header: 'source', value: r => r.source, paint: c => s.light(c) },
        ...(server
          ? [{ header: 'version', value: (r: (typeof rows)[number]) => String(r.version) }]
          : []),
        { header: 'description', value: r => r.description ?? '-' },
      ],
      rows,
      s,
    ),
  );
  if (server) return;
  process.stdout.write(
    `\n${formatHints(
      [
        "An agent's settings, triggers, and tools: coder agent show <id>",
        'Scaffold a new agent in this repo: coder agent init <id>',
      ],
      s,
    )}\n`,
  );
}

export const commandAgentList = command({
  name: 'agent list',
  help: {
    usage: 'coder agent list [--server [url]] [--json] [--cwd <dir>]',
    summary:
      'Without --server, one row per built-in and workspace agent. With --server, list the agent records and current versions owned by that Coder server.',
    flags: [SERVER_FLAG],
  },
  options: { ...baseOptions, ...serverOptions },
  run: async ({ options, cwd }) => {
    const { agents } = await import('../../agent');
    return agents.list({ ...options, cwd, organization: options.workspace });
  },
  json: list => agentRows(list),
  print: (list, { options }) => printAgents(agentRows(list), options.server !== undefined),
});
