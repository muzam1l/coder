/** `coder credentials remove <label>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, serverOnly } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';

export const credentialOptions = { json: flag, server: serverOnly, workspace: flag, yes: flag };

export const commandCredentialsRemove = command({
  name: 'credentials remove',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder credentials remove <label> [--workspace] [--server [url]] [--json]',
    flags: [['--workspace', 'the workspace credential of that label'], CREDENTIAL_SERVER_FLAG],
  },
  options: credentialOptions,
  args: 1,
  required: ['<label>'],
  async run({ options, args: [label] }) {
    const { credentials } = await import('../../core/remote');

    return credentials.remove(label, options);
  },
  print: (_, { args: [label] }) => process.stdout.write(`Removed ${outStyle.bold(label!)}.\n`),
});
