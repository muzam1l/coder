/** The task hub: one MCP server in front of a task's servers, each connected on its first use, with two tools that find and call theirs. */
import { mcpClient, type McpClient, type McpToolInfo } from './connections';
import { resolveMcpServers } from './dispatch';
import { loadTask } from './state';
import type { McpServerSpec } from './types';
import { schema, type McpTool } from '../utils/mcp-server';

/** Matches past this many get names only, so one answer stays small. */
const SCHEMA_LIMIT = 25;

interface Connected {
  spec: McpServerSpec;
  client: McpClient;
  /** Only what the task may call: the spec's allowlist, and read-only tools when the spec is read-only. */
  tools: McpToolInfo[];
}

/** Connects to a server within `startupMs` and lists its tools, filtered by the spec's allowlist and read-only mark; the connection then lives with the hub. */
export async function connect(spec: McpServerSpec, startupMs = 60_000): Promise<Connected> {
  const startup = AbortSignal.timeout(startupMs);
  const client = await mcpClient(spec, fetch, startup).catch(error => {
    throw startup.aborted ? new Error(`MCP server ${spec.name} did not start in time`) : error;
  });
  try {
    const tools = (await client.tools()).filter(
      tool =>
        (!spec.tools?.length || spec.tools.includes(tool.name)) &&
        (!spec.readOnly || tool.annotations?.readOnlyHint === true),
    );

    return { spec, client, tools };
  } catch (error) {
    await client.close().catch(() => {});
    throw startup.aborted ? new Error(`MCP server ${spec.name} did not start in time`) : error;
  }
}

/** Matching tools: every term of `query` appears in the name or description. */
export function matching(tools: McpToolInfo[], query: string | undefined): McpToolInfo[] {
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);

  return tools.filter(tool => {
    const text = `${tool.name} ${tool.description ?? ''}`.toLowerCase();
    return terms.every(term => text.includes(term));
  });
}

/** The hub's two tools over the task's servers, each connected on its first use. */
export function hubTools(
  servers: McpServerSpec[],
  open: (spec: McpServerSpec) => Promise<Connected> = connect,
): Record<string, McpTool<unknown>> {
  const specs = new Map(servers.map(spec => [spec.name, spec]));
  const connections = new Map<string, Promise<Connected>>();
  const server = (name: unknown) => {
    const spec = specs.get(String(name ?? ''));
    if (!spec)
      throw new Error(
        `Unknown server "${name}". Servers: ${[...specs.keys()].join(', ') || 'none'}`,
      );
    let connected = connections.get(spec.name);
    if (!connected) {
      connected = open(spec).catch(error => {
        connections.delete(spec.name);
        throw error;
      });
      connections.set(spec.name, connected);
    }

    return connected;
  };

  return {
    find_tools: {
      description:
        'Find tools on one of the servers listed in your prompt by words from their names or descriptions; empty query lists them all. Returns each match with one line and its input schema.',
      inputSchema: schema({ server: 'string', query: 'string' }, ['server'], {
        server: 'A server name from the prompt.',
        query: 'Words that the tool name or description contain, such as "issue list".',
      }),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
      handler: async a => {
        const { spec, tools } = await server(a.server);
        const found = matching(tools, typeof a.query === 'string' ? a.query : undefined);
        const names = (list: McpToolInfo[]) => list.map(tool => tool.name).join(', ') || 'none';
        if (!found.length) return `No tool on ${spec.name} matches. Its tools: ${names(tools)}`;
        if (found.length > SCHEMA_LIMIT)
          return `${found.length} tools on ${spec.name} match; narrow the query. Names: ${names(found)}`;

        return found.map(tool => ({
          name: tool.name,
          description: (tool.description ?? '').split('\n')[0]!.trim(),
          inputSchema: tool.inputSchema ?? { type: 'object' },
        }));
      },
    },
    call_tool: {
      description: "Call a tool found with find_tools; returns the server's result as is.",
      inputSchema: schema(
        { server: 'string', tool: 'string', args: 'object' },
        ['server', 'tool'],
        {
          server: 'A server name from the prompt.',
          tool: 'A tool name find_tools returned.',
          args: "The tool's arguments, matching its input schema.",
        },
      ),
      handler: async a => {
        const { spec, client, tools } = await server(a.server);
        const name = String(a.tool ?? '');
        if (!tools.some(tool => tool.name === name))
          throw new Error(`No tool "${name}" on ${spec.name}; find it with find_tools first`);
        const result = await client.rpc('tools/call', {
          name,
          arguments: a.args && typeof a.args === 'object' ? a.args : {},
        });

        return result && typeof result === 'object' && Array.isArray(result.content)
          ? result
          : JSON.stringify(result);
      },
    },
  };
}

/** The servers a task's hub fronts: its record's, resolved from this process's environment, without the ones the engine loads directly. */
export function hubServers(cwd: string, taskId: string): McpServerSpec[] {
  const task = loadTask(cwd, taskId);
  if (!task) throw new Error(`No task "${taskId}"`);

  return resolveMcpServers(task.mcp, process.env, undefined, {
    onWarning: message => process.stderr.write(`coder hub: ${message}\n`),
  }).filter(server => !server.alwaysLoad);
}
