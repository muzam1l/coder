import process from 'node:process';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { runnerOptions } from './remove';

export const commandRunnerTest = command({
  name: 'runner test',
  globalFlags: { cwd: false },
  args: 1,
  required: ['<id>'],
  help: {
    usage: 'coder runner test <id> [--server [url]] [--json]',
    summary: 'Check the runner connection.',
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: runnerOptions,
  async run({ options, args: [id] }) {
    const { testRunner } = await import('../../runner');
    return testRunner(id, options);
  },
  print: result =>
    process.stdout.write(`${result.ok ? 'OK' : 'Failed'} ${result.detail} (${result.ms} ms).\n`),
});
