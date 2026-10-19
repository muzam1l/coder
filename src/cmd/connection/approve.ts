/** `coder connection approve <name>`. */
import process from 'node:process';

import * as z from 'zod/mini';

import { str } from '../../utils/args';
import { command } from '../../cli';

export const commandConnectionApprove = command({
  name: 'approve',
  description: 'approve a repository MCP server on this machine',
  usage:
    'Approve an MCP server this repository or one of its agents declares, on this machine. A changed endpoint or command needs approval again.',
  access: 'write',
  args: {
    name: z.string().check(z.describe('the MCP server')),
    agent: str('select the agent when names have different definitions', '<id>'),
  },
  cli: { positional: ['name'] },
  run: async ({ cwd, args: [name], options }) => {
    const { connection } = await import('../../core/connection');
    return connection.approve(name, { cwd, agent: options.agent });
  },
  print: ({ name }) => process.stdout.write(`Approved MCP server "${name}" on this machine.\n`),
});
