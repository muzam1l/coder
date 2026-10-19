/** `coder credentials remove <NAME>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import * as z from 'zod/mini';

import { credentialServerOptions, flag } from '../../utils/args';
import { command } from '../../cli';

export const commandCredentialsRemove = command({
  name: 'remove',
  description: 'remove the key of one variable',
  usage: 'Remove the key of one environment variable.',
  access: 'write',
  args: {
    NAME: z.string().check(z.describe('the variable')),
    workspace: flag('the workspace key of that variable'),
    ...credentialServerOptions,
  },
  globalFlags: { cwd: false },
  cli: { positional: ['NAME'] },
  async run({ options, args: [name] }) {
    const { credentials } = await import('../../core/remote');

    return credentials.remove(name, options);
  },
  print: (_, { args: [name] }) => process.stdout.write(`Removed ${outStyle.bold(name!)}.\n`),
});
