/** `coder task hub <task-id>`: the task hub MCP server (stdio), spawned by engines that load tools on demand through it. */
import { hubServers, hubTools } from '../../core/hub';
import { readVersion } from '../../core/runtime';
import { str } from '../../utils/args';
import { serveTools } from '../../utils/mcp-server';
import { command } from '../../cli';

export const commandTaskHub = command({
  name: 'task hub',
  options: { cwd: str },
  args: 1,
  run: ({ args, cwd }) =>
    serveTools('coder', hubTools(hubServers(cwd, args[0]!)), undefined, undefined, readVersion()),
});
