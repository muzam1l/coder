/** `coder credentials add <label>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, str, strList } from '../../utils/args';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { credentialOptions } from './remove';

export const commandCredentialsAdd = command({
  name: 'credentials add',
  globalFlags: { cwd: false },
  help: {
    usage:
      'coder credentials add [label] --engine <claude|codex|custom> --env <NAME> [--env <NAME> ...] [--value <secret|->] [--workspace] [--no-check] [--default] [--server [url]]',
    summary:
      'Store an API key, encrypted on the server, as your personal credential or with --workspace for every member. The value comes from the named environment variable unless --value says otherwise, and is never printed. Without subscription sign-in on the server, CLAUDE_CODE_OAUTH_TOKEN takes your own claude setup-token output.',
    examples: [
      [
        'ANTHROPIC_API_KEY=sk-... coder credentials add --engine claude --env ANTHROPIC_API_KEY',
        'your own API key, read from the environment',
      ],
      [
        'OPENAI_API_KEY=sk-... coder credentials add team --engine codex --env OPENAI_API_KEY --workspace',
        "a workspace key every member's tasks can use",
      ],
      [
        'pbpaste | coder credentials add router --engine custom --env OPENROUTER_API_KEY --value -',
        'any provider, value from stdin',
      ],
    ],
    flags: [
      [
        '--env <NAME>',
        'one environment variable name; repeat for more (reads that variable by default)',
      ],
      ['--engine <name>', 'claude, codex, or custom'],
      [
        '--value <secret|->',
        'literal values land in shell history and are visible to other processes; use - for stdin or prefer environment variables',
      ],
      ['--workspace', 'a workspace credential; owners and admins only'],
      ['--no-check', 'skip the provider credential check'],
      ['--default', 'make this the default for its engine'],
      CREDENTIAL_SERVER_FLAG,
    ],
  },
  options: {
    ...credentialOptions,
    engine: str,
    env: strList,
    value: str,
    'no-check': flag,
    default: flag,
  },
  args: 1,
  run: async ({ options, args: [label] }) => {
    const { addCredential } = await import('../../core/remote');
    return addCredential(label, {
      ...options,
      env: options.env ?? [],
      noCheck: options['no-check'],
    });
  },
  print: (result, { options }) =>
    process.stdout.write(
      `Added ${options.workspace ? 'workspace' : 'personal'} credential ${outStyle.bold(result.label)}.\n`,
    ),
});
