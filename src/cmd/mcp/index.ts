/** `coder mcp <sub>`: the `mcp` map in .coder/config.json, in `.mcp.json` entry shape. */
import { group } from '../../cli';

export const commandMcpConfig = group(
  'mcp',
  {
    serve: async () => (await import('./serve')).commandMcp,
    add: async () => (await import('./add')).commandMcpAdd,
    'add-json': async () => (await import('./add-json')).commandMcpAddJson,
    list: async () => (await import('./list')).commandMcpList,
    ls: async () => (await import('./list')).commandMcpList,
    rm: async () => (await import('./remove')).commandMcpRemove,
    remove: async () => (await import('./remove')).commandMcpRemove,
  },
  {
    menu: [
      { usage: 'add <name> (--url <url> | -- <command> [args])', blurb: 'add a server' },
      { usage: "add-json <name> '<json>'", blurb: 'add a server from a .mcp.json entry' },
      { usage: 'list', blurb: 'list configured servers' },
      { usage: 'rm <name>', blurb: 'remove a server' },
    ],
    details: true,
  },
  {
    aliases: { ls: 'list', remove: 'rm' },
    help: {
      usage: 'coder mcp <add|add-json|list|rm>',
      summary:
        'Manage the `mcp` map in .coder/config.json (or ~/.coder with --user). Entries use the .mcp.json shape (stdio command or remote url) plus an optional tools allowlist; attach them with `coder task run --mcp <names|all>`.',
      examples: [
        ['coder mcp add docs -- npx -y docs-mcp', 'add a stdio server from its command line'],
        [
          'coder mcp add linear --url https://mcp.linear.app/mcp',
          'add a remote server; the engine handles its OAuth login',
        ],
        [
          'coder mcp add-json github \'{"url":"https://api.githubcopilot.com/mcp/","headers":{"Authorization":"Bearer ${GH_TOKEN}"}}\'',
          'paste an entry from any .mcp.json',
        ],
        ['coder run --mcp docs,linear "find why uploads fail"', 'attach by name'],
      ],
      seeAlso: 'task run',
    },
  },
);
