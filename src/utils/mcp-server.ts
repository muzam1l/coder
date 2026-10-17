import readline from 'node:readline';

/** One tool: its schema for `tools/list` and the handler `tools/call` runs with the server context. */
export interface McpTool<C> {
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
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
  const pending = new Set<Promise<void>>();
  let failure: unknown;
  const call = async (id: unknown, params: any) => {
    const tool = tools[String(params?.name ?? '')];
    let text: string;
    let isError = false;
    try {
      if (!tool) throw new Error(`unknown tool: ${params?.name}`);
      const result = await tool.handler(params?.arguments ?? {}, ctx);
      // A handler that forwards another server's result passes it through whole.
      if (result && typeof result === 'object' && Array.isArray((result as { content?: unknown }).content)) {
        send({ jsonrpc: '2.0', id, result });
        return;
      }
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
  };
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
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          })),
        },
      });
    } else if (method === 'tools/call') {
      const running = call(id, params);
      pending.add(running);
      void running.then(
        () => pending.delete(running),
        error => {
          pending.delete(running);
          failure = error;
          rl.close();
        },
      );
    } else if (id !== undefined) {
      send({ jsonrpc: '2.0', id, result: {} });
    }
  }
  await Promise.all(pending);
  if (failure) throw failure;
}

/** JSON schema helper: an object with the given string/number properties. */
export function schema(
  props: Record<string, 'string' | 'number' | 'boolean' | 'array' | 'object'>,
  required: string[] = Object.keys(props),
  descriptions: Record<string, string> = {},
): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(props).map(([k, type]) => [
        k,
        { type, ...(descriptions[k] === undefined ? {} : { description: descriptions[k] }) },
      ]),
    ),
    ...(required.length ? { required } : {}),
  };
}

/** Forward an MCP server's schemas, admitting only tools it marks read-only. */
export async function serveReadOnlyTools(
  server: { command?: string; args?: string[]; env?: Record<string, string> },
  io: { input: NodeJS.ReadableStream; write: (line: string) => void } = {
    input: process.stdin,
    write: line => process.stdout.write(`${line}\n`),
  },
): Promise<void> {
  const { spawn } = await import('node:child_process');
  if (!server.command) throw new Error('A stdio MCP server is required');
  const child = spawn(server.command, server.args ?? [], {
    env: { ...process.env, ...server.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const allowed = new Set<string>();
  const lists = new Set<string | number>();
  const input = readline.createInterface({ input: io.input, terminal: false });
  const output = readline.createInterface({ input: child.stdout, terminal: false });
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => code ? reject(new Error(`MCP server exited with status ${code}`)) : resolve());
  });
  const stop = () => { child.kill(); input.close(); };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  let shutdown: ReturnType<typeof setTimeout> | undefined;
  void closed.catch(() => input.close());
  child.stdin.on('error', () => input.close());
  const pump = (async () => {
    for await (const line of output) {
      const message = JSON.parse(line);
      if (message.method === 'notifications/tools/list_changed') allowed.clear();
      if (lists.delete(message.id) && message.result) {
        message.result.tools = (message.result.tools ?? []).filter(
          (tool: { name?: unknown; annotations?: { readOnlyHint?: boolean } }) =>
            typeof tool.name === 'string' && tool.annotations?.readOnlyHint === true,
        );
        for (const tool of message.result.tools) allowed.add(tool.name);
      }
      io.write(JSON.stringify(message));
    }
    input.close();
  })();
  void pump.catch(() => input.close());
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      if (message.method === 'tools/call' && !allowed.has(message.params?.name)) {
        io.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Tool is not marked read-only' } }));
        continue;
      }
      if (message.method === 'tools/list') {
        if (!message.params?.cursor) allowed.clear();
        lists.add(message.id);
      }
      child.stdin.write(`${line}\n`);
    }
    child.stdin.end();
    shutdown = setTimeout(() => child.kill('SIGKILL'), 2000);
    await Promise.all([pump, closed]);
  } finally {
    if (shutdown) clearTimeout(shutdown);
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    child.kill('SIGKILL');
    input.close();
    output.close();
  }
}
