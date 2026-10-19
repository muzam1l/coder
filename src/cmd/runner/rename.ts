/** `coder runner rename <id> <name>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import * as z from 'zod/mini';

import { credentialServerOptions } from '../../utils/args';
import { command } from '../../cli';

export const commandRunnerRename = command({
  name: 'rename',
  description: 'rename a runner',
  access: 'write',
  args: {
    id: z.string().check(z.describe('the runner')),
    name: z.string().check(z.describe('its new name')),
    ...credentialServerOptions,
  },
  globalFlags: { cwd: false },
  cli: { positional: ['id', 'name'] },
  async run({ options, args: [id, name] }) {
    const { runners } = await import('../../runner');

    return runners.rename(id, name!, options);
  },
  print: (result, { args: [id] }) =>
    process.stdout.write(`Renamed ${id} to ${outStyle.bold(result.name)}.\n`),
});
