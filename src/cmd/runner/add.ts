import process from 'node:process';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { str, strList } from '../../utils/args';
import { CoderError } from '../../core/errors';
import { runnerOptions } from './remove';

export const commandRunnerAdd = command({
  name: 'runner add',
  globalFlags: { cwd: false },
  args: 1,
  help: {
    usage:
      'coder runner add <kind> [--name <name>] [--scope <scope>] [--field key=value …] [--server [url]] [--json]',
    summary:
      'Connect a runner. Secret fields read environment variables with key=env:VARIABLE. Adding local prints a pairing command.',
    flags: [
      ['--name <name>', 'runner display name'],
      ['--scope <scope>', 'personal or workspace'],
      ['--field key=value', 'repeat for each field, use env:VARIABLE for secrets'],
      CREDENTIAL_SERVER_FLAG,
    ],
  },
  options: { ...runnerOptions, name: str, scope: str, field: strList },
  async run({ options, args: [kind] }) {
    if (!kind) throw new CoderError('invalid-option', 'Missing runner kind.');
    const { addRunnerFields } = await import('../../runner');
    return addRunnerFields(kind, options);
  },
  print: result =>
    process.stdout.write(
      `${'command' in result ? result.command : `Added ${result.name} (${result.id}).`}\n`,
    ),
});
