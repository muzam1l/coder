/** `coder credentials add --env <NAME>`. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import { outStyle } from '../../tui/output';
import { credentialServerOptions, flag, str } from '../../utils/args';
import { command } from '../../cli';

export const commandCredentialsAdd = command({
  name: 'add',
  description: 'store an API key or subscription for one variable',
  usage:
    'Store the key of one environment variable, encrypted on the server, as your own or with --workspace for every member. A key saved for that variable in the same scope is replaced. Where the server has subscription sign-in on, CLAUDE_CODE_OAUTH_TOKEN takes your own claude setup-token output.',
  access: 'write',
  args: {
    env: str('the variable tasks read the key as (reads that variable by default)', '<NAME>'),
    value: str(
      'literal values land in shell history and are visible to other processes; use - for stdin or prefer environment variables',
      '<secret|->',
    ),
    workspace: flag('a workspace key; owners and admins only'),
    'no-check': flag('skip the provider key check'),
    ...credentialServerOptions,
  },
  globalFlags: { cwd: false },
  cli: {
    examples: [
      'ANTHROPIC_API_KEY=sk-... coder credentials add --env ANTHROPIC_API_KEY  # your own Claude key, read from the environment',
      "OPENAI_API_KEY=sk-... coder credentials add --env OPENAI_API_KEY --workspace  # a workspace key every member's tasks can use",
      'pbpaste | coder credentials add --env OPENROUTER_API_KEY --value -  # a key for custom models, value from stdin',
    ],
  },
  run: async ({ options, tool }) => {
    const { addCredential } = await import('../../core/remote');
    // A tool's stdin is the MCP stream.
    if (tool && options.value === '-')
      throw new CoderError('invalid-option', 'A tool cannot read the key from stdin.', {
        hint: 'Set the variable in the environment, or run it in a terminal',
      });
    return addCredential({ ...options, noCheck: options['no-check'] });
  },
  print: (result, { options }) =>
    process.stdout.write(
      `${result.replaced ? 'Replaced' : 'Added'} ${options.workspace ? 'workspace' : 'personal'} ${outStyle.bold(result.name)}.\n`,
    ),
});
