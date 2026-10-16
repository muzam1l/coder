import process from 'node:process';

import { serveReadOnlyTools, serveTools } from '../../utils/mcp-server';
import { command } from '../../cli';

/** Conversation tools or a read-only view of an external stdio server. */
export const commandTools = command({
  name: 'agent tools',
  options: {},
  args: 1,
  async run({ args }) {
    const { INTEGRATIONS } = await import('../../integrations');
    const { agentTools } = await import('../../agent/mcp');

    const id = args[0] ?? '';
    const external = INTEGRATIONS[id]?.tools.server;
    if (external) {
      const spec = external(['read'], undefined, '');
      const token = process.env[spec.credentialFields?.env ?? 'APP_TOKEN'];
      if (!token) throw new Error('Platform token is not set');
      await serveReadOnlyTools(external(['read'], undefined, token));
      return;
    }
    const tools = agentTools(id);
    if (!tools) throw new Error(`Unknown tool set "${id}"`);
    await serveTools(`coder-${id}`, tools, { fetch });
  },
});
