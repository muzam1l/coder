import process from 'node:process';

import * as z from 'zod/mini';

import { credentialServerOptions, str, strList } from '../../utils/args';
import { command } from '../../cli';

export const commandRunnerAdd = command({
  name: 'add',
  description: 'connect a runner',
  usage:
    'Connect a runner. Secret fields read environment variables with key=env:VARIABLE. Adding local prints a pairing command.',
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/settings/runners',
      label: 'Add the runner',
      action: 'add',
      args: ['kind', 'name', 'scope'],
    },
  },
  args: {
    kind: z.string().check(z.describe('the runner kind, such as local or http')),
    name: str('runner display name'),
    scope: str('personal or workspace'),
    field: strList('repeat for each field, use env:VARIABLE for secrets', 'key=value'),
    ...credentialServerOptions,
  },
  globalFlags: { cwd: false },
  cli: { positional: ['kind'] },
  async run({ options, args: [kind] }) {
    const { addRunnerFields } = await import('../../runner');
    return addRunnerFields(kind, options);
  },
  print: result =>
    process.stdout.write(
      `${'command' in result ? result.command : `Added ${result.name} (${result.id}).`}\n`,
    ),
});
