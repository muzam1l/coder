/** `coder credentials add --env <NAME>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, str } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { credentialOptions } from './remove';

export const commandCredentialsAdd = command({
  name: 'credentials add',
  globalFlags: { cwd: false },
  help: {
    usage:
      'coder credentials add --env <NAME> [--value <secret|->] [--workspace] [--no-check] [--server [url]]',
    summary:
      'Store the key of one environment variable, encrypted on the server, as your own or with --workspace for every member. A key saved for that variable in the same scope is replaced. Where the server has subscription sign-in on, CLAUDE_CODE_OAUTH_TOKEN takes your own claude setup-token output.',
    examples: [
      [
        'ANTHROPIC_API_KEY=sk-... coder credentials add --env ANTHROPIC_API_KEY',
        'your own Claude key, read from the environment',
      ],
      [
        'OPENAI_API_KEY=sk-... coder credentials add --env OPENAI_API_KEY --workspace',
        "a workspace key every member's tasks can use",
      ],
      [
        'pbpaste | coder credentials add --env OPENROUTER_API_KEY --value -',
        'a key for custom models, value from stdin',
      ],
    ],
    flags: [
      ['--env <NAME>', 'the variable tasks read the key as (reads that variable by default)'],
      [
        '--value <secret|->',
        'literal values land in shell history and are visible to other processes; use - for stdin or prefer environment variables',
      ],
      ['--workspace', 'a workspace key; owners and admins only'],
      ['--no-check', 'skip the provider key check'],
      CREDENTIAL_SERVER_FLAG,
    ],
  },
  options: {
    ...credentialOptions,
    env: str,
    value: str,
    'no-check': flag,
  },
  run: async ({ options }) => {
    const { addCredential } = await import('../../core/remote');
    return addCredential({ ...options, noCheck: options['no-check'] });
  },
  print: (result, { options }) =>
    process.stdout.write(
      `${result.replaced ? 'Replaced' : 'Added'} ${options.workspace ? 'workspace' : 'personal'} ${outStyle.bold(result.name)}.\n`,
    ),
});
