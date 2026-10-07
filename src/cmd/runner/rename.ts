/** `coder runner rename <id> <name>`. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import { outStyle } from '../../tui/output';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { runnerOptions } from './remove';

export const commandRunnerRename = command({
  name: 'runner rename',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder runner rename <id> <name> [--server [url]] [--json]',
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: runnerOptions,
  args: 2,
  async run({ options, args: [id, name] }) {
    const { updateRunner } = await import('../../runner');

    if (!id || !name)
      throw new CoderError('invalid-option', 'Usage: coder runner rename <id> <name>');
    return updateRunner(id, { name }, options);
  },
  print: (result, { args: [id] }) =>
    process.stdout.write(`Renamed ${id} to ${outStyle.bold(result.name)}.\n`),
});
