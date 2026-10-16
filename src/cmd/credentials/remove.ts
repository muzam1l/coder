/** `coder credentials remove <NAME>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, serverOnly } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';

export const credentialOptions = { json: flag, server: serverOnly, workspace: flag, yes: flag };

export const commandCredentialsRemove = command({
  name: 'credentials remove',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder credentials remove <NAME> [--workspace] [--server [url]] [--json]',
    flags: [['--workspace', 'the workspace key of that variable'], CREDENTIAL_SERVER_FLAG],
  },
  options: credentialOptions,
  args: 1,
  required: ['<NAME>'],
  async run({ options, args: [name] }) {
    const { credentials } = await import('../../core/remote');

    return credentials.remove(name, options);
  },
  print: (_, { args: [name] }) => process.stdout.write(`Removed ${outStyle.bold(name!)}.\n`),
});
