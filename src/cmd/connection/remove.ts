/** `coder connection rm <name>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import * as z from 'zod/mini';

import { flag, serverOptions } from '../../utils/args';
import { command } from '../../cli';

export const commandConnectionRemove = command({
  name: 'rm',
  description: 'remove a connection',
  usage: [
    'Remove a connection. The credential a task secret reads stays.',
    "With --personal, the asking member's own connection of that name.",
  ].join(' '),
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/settings/connections',
      label: 'Remove the connection',
      action: 'delete',
      args: ['name'],
      button: 'Remove',
    },
  },
  args: {
    name: z.string().check(z.describe('the connection')),
    personal: flag("the asking member's own connection instead of the workspace's"),
    ...serverOptions,
  },
  cli: { positional: ['name'] },
  run: async ({ options, args: [name], cwd }) => {
    const { connection } = await import('../../core/connection');
    return connection.remove(name, { ...options, cwd });
  },
  print: row => process.stdout.write(`Removed ${outStyle.bold(row.id)}.\n`),
});
