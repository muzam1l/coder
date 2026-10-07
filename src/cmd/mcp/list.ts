/** `coder mcp list`: the configured servers. */
import process from 'node:process';

import { mcpList, type McpConfigEntry } from '../../core/config';
import { formatHints, outStyle, renderTable } from '../../tui/output';
import { baseOptions } from '../../utils/args';
import { command } from '../../cli';

export const commandMcpList = command({
  name: 'mcp list',
  help: {
    usage: 'coder mcp list [--json] [--cwd <dir>]',
    summary: 'List MCP servers from the merged user and repo config.',
  },
  options: baseOptions,
  run: ({ cwd }) => mcpList(cwd),
  print: printMcpList,
});

function printMcpList(servers: Record<string, McpConfigEntry>): void {
  const s = outStyle;
  const names = Object.keys(servers);
  if (!names.length)
    return void process.stdout.write(
      `No MCP servers configured.\n\n${formatHints(['Add a server: coder mcp add <name> -- <command>'], s)}\n`,
    );
  process.stdout.write(
    renderTable(
      [
        { header: 'name', value: r => r.name, paint: c => s.cyan(c) },
        {
          header: 'target',
          value: r => r.entry.url ?? [r.entry.command, ...(r.entry.args ?? [])].join(' '),
          paint: c => s.light(c),
        },
        { header: 'tools', value: r => r.entry.tools?.join(', ') ?? '-', paint: c => s.light(c) },
      ],
      names.map(name => ({ name, entry: servers[name]! })),
      s,
    ),
  );
}
