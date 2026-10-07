/** `coder runner remove <id>`. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import { outStyle } from '../../tui/output';
import { flag, serverOnly } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';

export const runnerOptions = { json: flag, server: serverOnly, yes: flag };

export const commandRunnerRemove = command({
  name: 'runner remove',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder runner remove <id> [--server [url]] [--json]',
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: runnerOptions,
  args: 1,
  async run({ options, args: [id] }) {
    const { removeRunner } = await import('../../runner');

    if (!id) throw new CoderError('invalid-option', 'Missing runner id.');
    return removeRunner(id, options);
  },
  print: (_, { args: [id] }) => process.stdout.write(`Removed ${outStyle.bold(id!)}.\n`),
});
