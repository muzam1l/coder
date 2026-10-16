/** `coder runner rename <id> <name>`. */
import process from 'node:process';

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
  required: ['<id>', '<name>'],
  async run({ options, args: [id, name] }) {
    const { runners } = await import('../../runner');

    return runners.rename(id, name!, options);
  },
  print: (result, { args: [id] }) =>
    process.stdout.write(`Renamed ${id} to ${outStyle.bold(result.name)}.\n`),
});
