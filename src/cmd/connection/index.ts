/** `coder connection <add|list|rm|reconnect|approve>`: services tasks may use, on this machine or a Coder server. */
import { group } from '../../cli';

export const commandConnection = group(
  'connection',
  {
    add: async () => (await import('./add')).commandConnectionAdd,
    list: async () => (await import('./list')).commandConnectionList,
    ls: async () => (await import('./list')).commandConnectionList,
    rm: async () => (await import('./remove')).commandConnectionRemove,
    remove: async () => (await import('./remove')).commandConnectionRemove,
    reconnect: async () => (await import('./reconnect')).commandConnectionReconnect,
    approve: async () => (await import('./approve')).commandConnectionApprove,
  },
  {
    menu: [
      {
        usage: 'add <name> [--env <NAME> | --url <url> | -- <command>]',
        blurb: 'connect a platform account, an API key or an MCP server',
      },
      { usage: 'list', blurb: 'list connections and the MCP servers this repository declares' },
      { usage: 'rm <name>', blurb: 'remove a connection' },
      { usage: 'reconnect <name>', blurb: 'give a connection a new key, or sign in again' },
      { usage: 'approve <name>', blurb: 'approve a repository MCP server on this machine' },
    ],
    details: true,
  },
  {
    aliases: { ls: 'list', remove: 'rm' },
    help: {
      usage: 'coder connection <add|list|rm|reconnect|approve>',
      summary:
        'Connections give tasks access to a service without a handle: a platform account, an API key tasks read from the environment, or an MCP server. They live in ~/.coder, or on your Coder server with --server, and every task of yours may use them unless its agent or `coder task run --connections` narrows the set.',
      examples: [
        ['coder connection add groq --env GROQ_API_KEY', 'an API key, kept as a credential'],
        [
          'coder connection add docs --key --env DOCS_TOKEN -- npx -y docs-mcp',
          'a stdio MCP server; the key is read from stdin or a prompt',
        ],
        [
          'coder connection add linear --url https://mcp.linear.app/mcp --server',
          'a remote MCP server; signs in with OAuth in the browser',
        ],
        ['coder connection add github --me --server', 'your own GitHub account'],
        ['coder connection approve docs', 'approve a repository server before its first local use'],
      ],
      seeAlso: 'task run',
    },
  },
);
