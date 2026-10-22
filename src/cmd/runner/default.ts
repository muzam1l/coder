import process from 'node:process';

import * as z from 'zod/mini';

import { credentialServerOptions } from '../../utils/args';
import { command } from '../../cli';

export const commandRunnerDefault = command({
  name: 'default',
  description: 'set the default in its scope',
  usage: 'Use this runner by default within its scope.',
  access: 'write',
  approvalPolicy: 'ask',
  args: { id: z.string().check(z.describe('the runner')), ...credentialServerOptions },
  globalFlags: { cwd: false },
  cli: { positional: ['id'] },
  async run({ options, args: [id] }) {
    const { runners } = await import('../../runner');
    return runners.default(id, options);
  },
  print: result => process.stdout.write(`Default runner ${result.name}.\n`),
});
