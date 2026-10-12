/** `coder connection approve <name>`. */
import process from 'node:process';

import { baseOptions, str } from '../../utils/args';
import { command } from '../../cli';

export const commandConnectionApprove = command({
  name: 'connection approve',
  help: {
    usage: 'coder connection approve <name> [--agent <id>] [--cwd <dir>]',
    summary:
      'Approve an MCP server this repository or one of its agents declares, on this machine. A changed endpoint or command needs approval again.',
    flags: [['--agent <id>', 'select the agent when names have different definitions']],
  },
  options: { ...baseOptions, agent: str },
  args: 1,
  run: async ({ cwd, args: [name], options }) => {
    const { connection } = await import('../../core/connection');
    return connection.approve(name, { cwd, agent: options.agent });
  },
  print: ({ name }) => process.stdout.write(`Approved MCP server "${name}" on this machine.\n`),
});
