/** `coder mcp add`: save a server entry. */
import process from 'node:process';

import { mcpAdd } from '../../core/config';
import { baseOptions, flag, str } from '../../utils/args';
import { command } from '../../cli';

export const printAdded = ({ name, file }: { name: string; file: string }) =>
  process.stdout.write(`Added MCP server "${name}" to ${file}. Attach with --mcp ${name}.\n`);

/** `coder mcp add <name> [--tools a,b] [--user] (--url <url> [--header K=V] | [--env K=V] -- <command> [args...])` */
const addCommand = (serverCommand: string[]) =>
  command({
    name: 'mcp add',
    help: {
      usage:
        'coder mcp add <name> [--tools a,b] [--user] (--url <url> [--header K=V] [--transport http|sse] | [--env K=V] -- <command> [args...])',
      summary:
        'Save an MCP server under `mcp.<name>`: a remote url, or the command to spawn after `--`.',
      flags: [
        ['--url <url>', 'remote server (streamable HTTP by default)'],
        ['--header <K=V,...>', 'request headers for a remote server; values may hold ${VAR}'],
        ['--transport <http|sse>', 'remote transport (default: http)'],
        [
          '--env <K=V,...>',
          'environment for a stdio server; values may hold ${VAR} or ${VAR:-default}',
        ],
        ['--tools <a,b>', 'tool allowlist (default: every tool the server offers)'],
        ['--user', 'write ~/.coder config instead of the repo'],
      ],
      examples: [['coder mcp add docs -- npx -y docs-mcp', 'then: coder run --mcp docs "..."']],
    },
    options: {
      ...baseOptions,
      env: str,
      header: str,
      url: str,
      transport: str,
      tools: str,
      user: flag,
    },
    args: 1,
    run: ({ options, args: [name], cwd }) =>
      mcpAdd(cwd, name, { ...options, command: serverCommand }),
    print: printAdded,
  });

export const commandMcpAdd = Object.assign((argv: string[]) => {
  // Everything after `--` is the server's command line.
  const dash = argv.indexOf('--');
  return addCommand(dash === -1 ? [] : argv.slice(dash + 1))(
    dash === -1 ? argv : argv.slice(0, dash),
  );
}, addCommand([]));
