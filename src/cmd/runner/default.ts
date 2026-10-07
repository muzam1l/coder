import process from 'node:process';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { CoderError } from '../../core/errors';
import { runnerOptions } from './remove';

export const commandRunnerDefault = command({
  name: 'runner default',
  globalFlags: { cwd: false },
  args: 1,
  help: {
    usage: 'coder runner default <id> [--server [url]] [--json]',
    summary: 'Use this runner by default within its scope.',
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: runnerOptions,
  async run({ options, args: [id] }) {
    if (!id) throw new CoderError('invalid-option', 'Missing runner id.');
    const { updateRunner } = await import('../../runner');
    return updateRunner(id, { default: true }, options);
  },
  print: result => process.stdout.write(`Default runner ${result.name}.\n`),
});
