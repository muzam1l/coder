import process from 'node:process';

import { serveTools } from '../../utils/mcp-server';
import { command } from '../../cli';

/** `coder agent tools <integration>`: stdio MCP server backed by APP_TOKEN. */
export const commandTools = command({
  name: 'agent tools',
  options: {},
  args: 1,
  async run({ args }) {
    const { INTEGRATIONS } = await import('../../integrations');
    const { agentTools } = await import('../../agent/mcp');

    const id = args[0] ?? '';
    const allowed = (process.env.CODER_AGENT_TOOLS ?? '').split(',').filter(Boolean);
    const tools = agentTools(id, allowed);
    if (!tools)
      throw new Error(
        `Unknown tool set "${id}"; known: ${[...Object.keys(INTEGRATIONS).filter(key => INTEGRATIONS[key]!.tools.serve), 'history'].join(', ')}`,
      );
    const token = process.env.APP_TOKEN ?? '';
    if (!token && id !== 'history') throw new Error('APP_TOKEN is not set');
    const scope = process.env.CODER_AGENT_SCOPE
      ? JSON.parse(process.env.CODER_AGENT_SCOPE)
      : undefined;
    await serveTools(`coder-${id}`, tools, {
      token,
      fetch,
      tools: allowed,
      ...(scope ? { scope } : {}),
    });
  },
});
