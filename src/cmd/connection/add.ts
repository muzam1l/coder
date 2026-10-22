/** `coder connection add <name>`: a platform account, an API key or an MCP server. */
import process from 'node:process';

import type { ConnectionRow } from '../../client/types';
import { errStyle, outStyle } from '../../tui/output';
import * as z from 'zod/mini';

import type { Access } from '../../core/config';
import { CoderError } from '../../core/errors';
import { flag, serverOptions, str, strList } from '../../utils/args';
import { command } from '../../cli';

/** Shows an OAuth sign-in page and opens it in the browser. */
export async function openSignIn(url: string): Promise<void> {
  const { openUrl } = await import('../../tui/prompt');
  process.stderr.write(`Sign in at ${errStyle.cyan(url)}\n`);
  if (openUrl(url)) process.stderr.write(errStyle.dim('Opened it in your browser. Waiting...\n'));
}

export async function askKey(): Promise<string> {
  const { askSecret } = await import('../../tui/prompt');
  return askSecret('Key');
}

export function describe(row: ConnectionRow): string {
  return row.provider === 'env'
    ? `API key ${row.env}`
    : row.provider === 'mcp'
      ? `MCP server ${row.url ?? row.command}`
      : `${row.provider} account${row.account ? ` ${row.account}` : ''}`;
}

// A tool's stdin is the MCP stream, so it never reads a key.
export async function noKey(): Promise<string> {
  throw new CoderError('invalid-option', 'A tool cannot read a key from stdin or a prompt.', {
    hint: 'Keep the key in an environment variable and pass --env, or run it in a terminal',
  });
}

const addCommand = command({
  name: 'add',
  description: 'connect a platform account, an API key or an MCP server',
  usage:
    'Connect a platform account by its name (OAuth in the browser), an API key that tasks read from --env, or an MCP server at --url or started by the command after `--`. An API key is kept as a credential. A credential already holding the variable is used, else the value comes from that variable here, or from stdin or a prompt. A remote MCP server is checked for OAuth, open access or a key; a needed key is read from stdin or a prompt. With --key, the key goes in --header (default Authorization) or --env. Signing in needs --server.',
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/settings/connections',
      label: 'Add the connection',
      action: 'add',
      args: ['name', 'url', 'access', 'tools', 'me'],
    },
  },
  args: {
    name: z.string().check(
      z.describe('the connection name; a platform name connects that account'),
      z.refine(
        name => !['coder', 'task', 'conversation', 'coder-approval'].includes(name),
        'The names coder, task, conversation and coder-approval are reserved for Coder MCP servers.',
      ),
    ),
    command: strList('a stdio MCP server to start; on the command line, the words after `--`'),
    env: str('the API key variable, or where a stdio server reads its key', '<NAME>'),
    url: str('a remote MCP server (streamable HTTP by default)'),
    header: str('the header a remote server reads its key from (default: Authorization)', '<NAME>'),
    key: flag('read a key from stdin or a prompt, never from a flag value'),
    auth: str(
      'override MCP authentication (default: detected for --url, none for a command)',
      '<oauth|key|none>',
    ),
    access: str(
      'read-only keeps only read-only tools (default: auto, which follows the task)',
      '<read-only|auto>',
    ),
    tools: str('tool allowlist; a read-only stdio server needs one', '<a,b>'),
    credential: str('the credential an API key connection reads', '<id>'),
    me: flag("your own connection instead of the workspace's"),
    ...serverOptions,
  },
  cli: {
    positional: ['name'],
    examples: [
      'GROQ_API_KEY=gsk_... coder connection add groq --env GROQ_API_KEY  # an API key from this shell',
      'pbpaste | coder connection add docs --key --env DOCS_TOKEN -- npx -y docs-mcp  # a stdio server with its key from stdin',
      'coder connection add github --me --server  # your GitHub account on your Coder server',
    ],
  },
  run: async ({ options, args: [name], cwd, tool }) => {
    const { connection } = await import('../../core/connection');
    const key = tool ? noKey : askKey;

    return connection.add(name, {
      ...options,
      cwd,
      command: options.command ?? [],
      auth: options.auth as 'oauth' | 'key' | 'none' | undefined,
      access: options.access as Access | undefined,
      tools: options.tools
        ?.split(',')
        .map(id => id.trim())
        .filter(Boolean),
      key: options.key ? await key() : undefined,
      askKey: key,
      onAuthorize: tool ? undefined : openSignIn,
    });
  },
  print: row => process.stdout.write(`Connected ${outStyle.bold(row.id)}, ${describe(row)}.\n`),
});

// Everything after `--` is the MCP server's command line, never a stray word before it.
const invoke = (argv: string[]) => {
  const dash = argv.indexOf('--');
  return addCommand(
    dash === -1
      ? argv
      : [...argv.slice(0, dash), ...argv.slice(dash + 1).flatMap(word => ['--command', word])],
  );
};
Object.defineProperty(invoke, 'name', { value: addCommand.name, writable: true, enumerable: true });

export const commandConnectionAdd = Object.assign(invoke, addCommand);
