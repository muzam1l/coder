import readline from 'node:readline';

/** One tool: its schema for `tools/list` and the handler `tools/call` runs with the server context. */
export interface McpTool<C> {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, any>, ctx: C) => Promise<unknown>;
}

/** Minimal MCP stdio server over a tool set; one JSON-RPC message per line. */
export async function serveTools<C>(
  name: string,
  tools: Record<string, McpTool<C>>,
  ctx: C,
  io: { input: NodeJS.ReadableStream; write: (line: string) => void } = {
    input: process.stdin,
    write: line => process.stdout.write(`${line}\n`),
  },
  version = '1',
): Promise<void> {
  const send = (message: unknown) => io.write(JSON.stringify(message));
  const rl = readline.createInterface({ input: io.input, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: { id?: unknown; method?: string; params?: any };
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = request;
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name, version },
        },
      });
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: Object.entries(tools).map(([toolName, tool]) => ({
            name: toolName,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
    } else if (method === 'tools/call') {
      const tool = tools[String(params?.name ?? '')];
      let text: string;
      let isError = false;
      try {
        if (!tool) throw new Error(`unknown tool: ${params?.name}`);
        const result = await tool.handler(params?.arguments ?? {}, ctx);
        text = typeof result === 'string' ? result : JSON.stringify(result);
      } catch (error) {
        isError = true;
        text = error instanceof Error ? error.message : String(error);
      }
      send({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text }], isError },
      });
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, result: {} });
    }
  }
}

/** JSON schema helper: an object with the given string/number properties. */
export function schema(
  props: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>,
  required: string[] = Object.keys(props),
): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(Object.entries(props).map(([k, type]) => [k, { type }])),
    required,
  };
}
