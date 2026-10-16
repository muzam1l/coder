import process from 'node:process';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { runnerOptions } from './remove';

export const commandRunnerDefault = command({
  name: 'runner default',
  globalFlags: { cwd: false },
  args: 1,
  required: ['<id>'],
  help: {
    usage: 'coder runner default <id> [--server [url]] [--json]',
    summary: 'Use this runner by default within its scope.',
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: runnerOptions,
  async run({ options, args: [id] }) {
    const { runners } = await import('../../runner');
    return runners.default(id, options);
  },
  print: result => process.stdout.write(`Default runner ${result.name}.\n`),
});
