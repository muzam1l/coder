/** `coder runner remove <id>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import * as z from 'zod/mini';

import { credentialServerOptions } from '../../utils/args';
import { command } from '../../cli';

export const commandRunnerRemove = command({
  name: 'remove',
  description: 'remove a runner',
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/settings/runners',
      label: 'Remove the runner',
      action: 'delete',
      args: ['id'],
      button: 'Remove',
    },
  },
  args: { id: z.string().check(z.describe('the runner')), ...credentialServerOptions },
  globalFlags: { cwd: false },
  cli: { positional: ['id'] },
  async run({ options, args: [id] }) {
    const { removeRunner } = await import('../../runner');

    return removeRunner(id, options);
  },
  print: (_, { args: [id] }) => process.stdout.write(`Removed ${outStyle.bold(id!)}.\n`),
});
