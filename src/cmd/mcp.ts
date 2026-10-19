/** `coder mcp`: Coder's commands as MCP tools over stdio. */
import { command } from '../cli';

export const commandMcp = command({
  name: 'mcp',
  description: "serve Coder's commands as MCP tools over stdio",
  usage:
    "Serve Coder's commands as MCP tools over stdio, so a harness can run them.\n\nCommands return their JSON payloads and next steps. Load guides with load_skill;\nblocking commands keep their CLI flags and behavior, subject to the client's tool timeout.",
  access: 'write',
  globalFlags: { json: false, cwd: false },
  mcp: false,
  cli: { examples: ['claude mcp add coder -- coder mcp  # run Coder from Claude Code'] },
  async run() {
    // A person in a terminal gets told what this is instead of a silent server.
    if (process.stdin.isTTY) {
      process.stdout.write(
        'coder mcp is the MCP server your host starts; it waits for an MCP client on stdin.\nAdd it to your host with `coder setup-host`, or by hand: claude mcp add coder -- coder mcp\n',
      );
      return;
    }
    const { app } = await import('../context');
    const { serve } = await import('contextjsx/serve');

    await serve(app, 'stdio');
  },
});
