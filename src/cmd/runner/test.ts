import process from 'node:process';

import * as z from 'zod/mini';

import { credentialServerOptions } from '../../utils/args';
import { command } from '../../cli';

export const commandRunnerTest = command({
  name: 'test',
  description: 'check a runner connection',
  usage: 'Check the runner connection.',
  access: 'read',
  args: { id: z.string().check(z.describe('the runner')), ...credentialServerOptions },
  globalFlags: { cwd: false },
  cli: { positional: ['id'] },
  async run({ options, args: [id] }) {
    const { testRunner } = await import('../../runner');
    return testRunner(id, options);
  },
  print: result =>
    process.stdout.write(`${result.ok ? 'OK' : 'Failed'} ${result.detail} (${result.ms} ms).\n`),
});
