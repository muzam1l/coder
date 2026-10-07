/** `coder mcp serve <task-id>` - the coder MCP server (stdio), spawned by engines that need a callback into coder. */
import { decidePermission } from '../../core/engines/claude/permission';
import { readVersion } from '../../core/runtime';
import { str } from '../../utils/args';
import { serveTools, type McpTool } from '../../utils/mcp-server';
import { command } from '../../cli';

const TOOLS: Record<string, McpTool<{ cwd: string; taskId: string }>> = {
  approval_prompt: {
    description: 'Coder approval policy for claude permission prompts.',
    inputSchema: { type: 'object', additionalProperties: true },
    handler: (args, { cwd, taskId }) =>
      decidePermission(cwd, taskId, args).catch(error => ({
        behavior: 'deny',
        message: `coder mcp tool failed: ${error instanceof Error ? error.message : String(error)}`,
      })),
  },
};

export const commandMcp = command({
  name: 'mcp serve',
  options: { cwd: str },
  args: 1,
  run: ({ args, cwd }) =>
    serveTools('coder', TOOLS, { cwd, taskId: args[0]! }, undefined, readVersion()),
});
