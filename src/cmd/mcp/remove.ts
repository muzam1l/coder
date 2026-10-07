/** `coder mcp remove`: drop a configured server. */
import process from 'node:process';

import { mcpRemove } from '../../core/config';
import { baseOptions, flag } from '../../utils/args';
import { command } from '../../cli';

export const commandMcpRemove = command({
  name: 'mcp remove',
  helpName: 'mcp rm',
  help: {
    usage: 'coder mcp rm <name> [--user] [--cwd <dir>]',
    summary: 'Remove `mcp.<name>` from the repo config (or the user config with --user).',
    flags: [['--user', 'edit ~/.coder config']],
  },
  options: { ...baseOptions, user: flag },
  args: 1,
  run: ({ options, args: [name], cwd }) => mcpRemove(cwd, name, options),
  print: ({ name, file }) => process.stdout.write(`Removed MCP server "${name}" from ${file}.\n`),
});
