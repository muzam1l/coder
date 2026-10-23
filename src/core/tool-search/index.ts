/** Tool search: a turn's MCP servers behind find_tools and call_tool, each connected at start or on first use; a connection's token loads with its first use. */
import process from 'node:process';

import { instructions as served } from 'contextjsx/emit';

import {
  ConnectionRefused,
  connectionRevoked,
  mcpClient,
  withCredential,
  type McpClient,
  type McpServerInfo,
  type McpToolInfo,
} from '../connections';
import { redactConnectionSecrets } from '../connection-env';
import type { McpServerSpec } from '../types';
import { tokenFingerprint } from '../oauth';
import { serverScope, toolSearchApp, type CallArgs, type FindArgs } from './context';

export { searchInstructions, type ListedServer } from './context';

/** The turn's resolved servers, instructions and reconnect link as JSON, in the search server's own spawn env. */
const TOOL_SEARCH_ENV = 'CODER_TOOL_SEARCH';

/** Matches past this many get names only, so one answer stays small. */
const SCHEMA_LIMIT = 5;

interface Connected {
  spec: McpServerSpec;
  client: McpClient;
  instructions?: string;
  serverInfo?: McpServerInfo;
  /** Only what the turn may call: the spec's tool list, and only `readOnlyHint` tools on a read-only server. */
  tools: McpToolInfo[];
  /** The connection's token was refused; the server runs on the app's own. */
  refused?: boolean;
}

/** A connection's token from where the task's credentials live; `refused` is the fingerprint of a token its server refused. None when it needs reconnecting. */
export type CredentialSource = (
  spec: McpServerSpec,
  refused?: string,
) => Promise<string | undefined>;

/** Connects to a server within `startupMs` and lists the tools its spec allows; the connection then lives for the turn. */
export async function connect(spec: McpServerSpec, startupMs = 60_000): Promise<Connected> {
  const startup = AbortSignal.timeout(startupMs);
  const late = (error: unknown) =>
    startup.aborted ? new Error(`MCP server ${spec.name} did not start in time`) : error;
  const client = await mcpClient(spec, fetch, startup).catch(error => {
    throw late(error);
  });
  try {
    const { instructions, serverInfo } = await client.initialize();
    const tools = (await client.tools()).filter(
      tool =>
        (!spec.tools?.length || spec.tools.includes(tool.name)) &&
        (!spec.readOnly || tool.annotations?.readOnlyHint === true),
    );

    return {
      spec,
      client,
      instructions: [spec.instructions, instructions].filter(Boolean).join('\n\n') || undefined,
      serverInfo,
      tools,
    };
  } catch (error) {
    await client.close().catch(() => {});
    throw late(error);
  }
}

/** Matching tools: an exact name alone, else every term of `query` in the name or description, name matches first. */
function matching(tools: McpToolInfo[], query: string | undefined): McpToolInfo[] {
  const exact = tools.find(tool => tool.name === query?.trim());
  if (exact) return [exact];
  const terms = (query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const has = (text: string) => terms.every(term => text.toLowerCase().includes(term));
  const found = tools.filter(tool => has(`${tool.name} ${tool.description ?? ''}`));

  return [...found.filter(tool => has(tool.name)), ...found.filter(tool => !has(tool.name))];
}

const toolNames = (list: McpToolInfo[]) => list.map(tool => tool.name).join(', ') || 'none';

/** The search's two tools over the turn's servers: `start` ones connect now, the rest on first use. */
export function searchApp(
  servers: McpServerSpec[],
  {
    open = connect,
    instructions,
    reconnect,
    credential,
  }: {
    open?: (spec: McpServerSpec) => Promise<Connected>;
    /** The turn's servers by level, rendered by the worker (`searchInstructions`). */
    instructions?: string;
    /** Where a server that needs auth is reconnected. */
    reconnect?: string;
    credential?: CredentialSource;
  } = {},
) {
  const specs = new Map(servers.map(spec => [spec.name, spec]));
  const connections = new Map<string, Promise<Connected>>();
  const introduced = new Set<string>();
  const reported = new Set<string>();
  /** The token each connection's server last got, so a refusal names it. */
  const loaded = new Map<string, string>();
  /** Every token loaded here, which the worker's redactor never learns. */
  const secrets = new Set<string>();
  const redacted = async <T>(run: () => Promise<T>): Promise<T> => {
    const clean = (value: unknown) => JSON.parse(redactConnectionSecrets(value, [...secrets]));
    try {
      return clean(await run());
    } catch (error) {
      throw new Error(clean(error instanceof Error ? error.message : String(error)));
    }
  };
  const load = async (spec: McpServerSpec): Promise<Connected> => {
    const field = spec.credentialOnUse;
    if (!field || !spec.connection || !credential) return open(spec);
    const token = await credential(spec);
    if (token) {
      loaded.set(spec.name, token);
      secrets.add(token);
      return open(withCredential(spec, field, token));
    }
    reported.add(spec.name);
    if (!(field.env ? spec.env?.[field.env] : spec.headers?.[field.header!]))
      throw new ConnectionRefused('The connection needs reconnecting');

    return { ...(await open(spec)), refused: true };
  };
  const server = (name: string) => {
    const spec = specs.get(name);
    if (!spec)
      throw new Error(
        [
          `Unknown server "${name}". Servers: ${[...specs.keys()].join(', ') || 'none'}.`,
          'Tools that are not on these servers are called directly by their own name.',
        ].join(' '),
      );
    let connected = connections.get(spec.name);
    if (!connected) {
      connected = load(spec).catch(error => {
        connections.delete(spec.name);
        throw error;
      });
      connections.set(spec.name, connected);
    }

    return connected;
  };
  const needsAuth = (name: string) => ({
    server: name,
    status: 'needs-auth' as const,
    ...(reconnect ? { reconnect: `[Reconnect ${name}](${reconnect})` } : {}),
  });
  const report = async (name: string, error: unknown) => {
    const token = loaded.get(name);
    if (!(error instanceof ConnectionRefused) || !credential || !token || reported.has(name))
      return;
    reported.add(name);
    await credential(specs.get(name)!, tokenFingerprint(token)).catch(() => {});
  };
  /** A server's status and, once connected, its instructions and every tool name. */
  const status = (name: string) =>
    server(name).then(
      ({ spec, instructions, tools, refused }) => ({
        ...(refused ? needsAuth(name) : { server: name, status: 'connected' as const }),
        ...(serverScope(spec) ? { scope: serverScope(spec) } : {}),
        ...(instructions ? { instructions } : {}),
        names: toolNames(tools),
      }),
      async (error: unknown) => {
        await report(name, error);

        return connectionRevoked(error)
          ? needsAuth(name)
          : {
              server: name,
              status: 'failed' as const,
              error: error instanceof Error ? error.message : String(error),
            };
      },
    );
  for (const spec of servers) if (spec.connect === 'start') server(spec.name).catch(() => {});
  const find = (args: FindArgs) =>
    redacted(async () => {
      const header = await status(args.server);
      if (!('names' in header)) return header;
      const first = !introduced.has(args.server);
      introduced.add(args.server);
      if (!args.query?.trim()) return header;
      const { tools } = await server(args.server);
      const found = matching(tools, args.query);
      if (!found.length && !first)
        return `No tool on ${args.server} matches. Its tools: ${toolNames(tools)}`;
      const rest = found.slice(SCHEMA_LIMIT);

      return {
        ...(first ? header : {}),
        tools: found.slice(0, SCHEMA_LIMIT).map(tool => ({
          name: tool.name,
          description: (tool.description ?? '').split('\n')[0]!.trim(),
          inputSchema: tool.inputSchema ?? { type: 'object' },
        })),
        ...(rest.length ? { more: toolNames(rest) } : {}),
      };
    });
  const call = (args: CallArgs) =>
    redacted(async () => {
      const header = await status(args.server);
      if (!('names' in header)) throw new Error(JSON.stringify(header));
      const { spec, client, tools } = await server(args.server);
      if (!tools.some(tool => tool.name === args.tool))
        throw new Error(
          spec.readOnly
            ? `This task is read-only; "${args.tool}" is not a read-only tool on ${spec.name}.`
            : `No tool "${args.tool}" on ${spec.name}; find it with find_tools first`,
        );

      try {
        return (await client.call(args.tool, args.args ?? {})) ?? null;
      } catch (error) {
        if (!connectionRevoked(error)) throw error;
        // A token refused mid-turn: the next call connects again and reports its status.
        await report(args.server, error);
        connections.delete(args.server);
        await client.close().catch(() => {});
        throw new Error(JSON.stringify(needsAuth(args.server)));
      }
    });

  return toolSearchApp({ find, call }, instructions);
}

/** The task's callback endpoint and attempt token, which the search reports refused credentials to. */
export interface SearchEndpoint {
  url: string;
  token: string;
}

/** The turn's servers, instructions, reconnect link and callback endpoint from the search server's env. */
export function searchServers(value: string | undefined): {
  servers: McpServerSpec[];
  instructions?: string;
  reconnect?: string;
  endpoint?: SearchEndpoint;
} {
  if (!value) throw new Error(`${TOOL_SEARCH_ENV} is not set`);

  return JSON.parse(value);
}

/** The search's launch: how to start it, with the servers it fronts, its instructions, the reconnect link and the callback endpoint in its env; the spec carries the instructions it serves. */
export function toolSearchServer(
  launch: Pick<McpServerSpec, 'command' | 'args' | 'env'>,
  servers: McpServerSpec[],
  reconnect: string | undefined,
  endpoint?: SearchEndpoint,
  instructions?: string,
): McpServerSpec {
  const app = searchApp([], { instructions });

  return {
    name: app.name,
    ...launch,
    env: {
      ...launch.env,
      [TOOL_SEARCH_ENV]: JSON.stringify({ servers, instructions, reconnect, endpoint }),
    },
    tools: app.commands.filter(command => command.mcp !== false).map(command => command.name),
    instructions: served(app),
  };
}

/** Serves the search over stdio for the servers in its env; connection tokens come from the env's endpoint through `credential`, else from this machine through `localCredential`. */
export async function serveToolSearch(
  options: {
    credential?: (endpoint: SearchEndpoint) => CredentialSource;
    localCredential?: CredentialSource;
  } = {},
): Promise<void> {
  const { serve } = await import('contextjsx/serve');
  const { servers, instructions, reconnect, endpoint } = searchServers(
    process.env[TOOL_SEARCH_ENV],
  );
  // The servers it spawns get only their own secrets.
  delete process.env[TOOL_SEARCH_ENV];

  await (
    await serve(
      searchApp(servers, {
        instructions,
        reconnect,
        ...(endpoint && options.credential
          ? { credential: options.credential(endpoint) }
          : options.localCredential
            ? { credential: options.localCredential }
            : {}),
      }),
      'stdio',
    )
  ).done;
}
