/** `coder connection add <name>`: a platform account, an API key or an MCP server. */
import process from 'node:process';

import type { ConnectionRow } from '../../client/types';
import { errStyle, outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

export const serverOptions = { server: optStr, workspace: str, yes: flag };

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

const addCommand = (serverCommand: string[]) =>
  command({
    name: 'connection add',
    help: {
      usage:
        'coder connection add <name> [--me] [--access read|write] (--env <NAME> | --url <url> [--header <NAME>] | [--env <NAME>] -- <command> [args...]) [--key] [--server [url]]',
      summary:
        'Connect a platform account by its name (OAuth in the browser), an API key that tasks read from --env, or an MCP server at --url or started by the command after `--`. An API key is kept as a credential. A credential already holding the variable is used, else the value comes from that variable here, or from stdin or a prompt. A remote MCP server is checked for OAuth, open access or a key; a needed key is read from stdin or a prompt. With --key, the key goes in --header (default Authorization) or --env. Signing in needs --server.',
      flags: [
        ['--env <NAME>', 'the API key variable, or where a stdio server reads its key'],
        ['--url <url>', 'a remote MCP server (streamable HTTP by default)'],
        ['--transport <http|sse>', 'remote transport (default: http)'],
        [
          '--header <NAME>',
          'the header a remote server reads its key from (default: Authorization)',
        ],
        ['--key', 'read a key from stdin or a prompt, never from a flag value'],
        [
          '--auth <oauth|key|none>',
          'override MCP authentication (default: detected for --url, none for a command)',
        ],
        [
          '--access <read|write>',
          'read keeps only read-only tools (default: read; API keys are write)',
        ],
        ['--tools <a,b>', 'tool allowlist; a read-only stdio server needs one'],
        ['--credential <id>', 'the credential an API key connection reads'],
        ['--me', "your own connection instead of the workspace's"],
        SERVER_FLAG,
      ],
      examples: [
        [
          'GROQ_API_KEY=gsk_... coder connection add groq --env GROQ_API_KEY',
          'an API key from this shell',
        ],
        [
          'pbpaste | coder connection add docs --key --env DOCS_TOKEN --access write -- npx -y docs-mcp',
          'a stdio server with its key from stdin',
        ],
        ['coder connection add github --me --server', 'your GitHub account on your Coder server'],
      ],
    },
    options: {
      ...baseOptions,
      ...serverOptions,
      env: str,
      url: str,
      transport: str,
      header: str,
      key: flag,
      auth: str,
      access: str,
      tools: str,
      credential: str,
      me: flag,
    },
    args: 1,
    run: async ({ options, args: [name], cwd }) => {
      const { connection } = await import('../../core/connection');
      return connection.add(name, {
        ...options,
        cwd,
        command: serverCommand,
        transport: options.transport as 'http' | 'sse' | undefined,
        auth: options.auth as 'oauth' | 'key' | 'none' | undefined,
        access: options.access as 'read' | 'write' | undefined,
        tools: options.tools
          ?.split(',')
          .map(tool => tool.trim())
          .filter(Boolean),
        key: options.key ? await askKey() : undefined,
        askKey,
        onAuthorize: openSignIn,
      });
    },
    print: row => process.stdout.write(`Connected ${outStyle.bold(row.id)}, ${describe(row)}.\n`),
  });

export const commandConnectionAdd = Object.assign((argv: string[]) => {
  // Everything after `--` is the MCP server's command line.
  const dash = argv.indexOf('--');
  return addCommand(dash === -1 ? [] : argv.slice(dash + 1))(
    dash === -1 ? argv : argv.slice(0, dash),
  );
}, addCommand([]));
