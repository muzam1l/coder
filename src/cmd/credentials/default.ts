/** `coder credentials default <label>`: the credential tasks run with. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { credentialOptions } from './remove';

export const commandCredentialsDefault = command({
  name: 'credentials default',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder credentials default <label> [--workspace] [--server [url]] [--json]',
    flags: [['--workspace', 'the workspace credential of that label'], CREDENTIAL_SERVER_FLAG],
  },
  options: credentialOptions,
  args: 1,
  required: ['<label>'],
  async run({ options, args: [label] }) {
    const { credentials } = await import('../../core/remote');

    return credentials.default(label, options);
  },
  print: (_, { args: [label] }) => process.stdout.write(`Made default ${outStyle.bold(label!)}.\n`),
});
