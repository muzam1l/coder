/** A turn's MCP servers: Coder's task tools, then the task's own, each narrowed to what the turn may call. */
import path from 'node:path';
import process from 'node:process';

import { CLI_PATH } from '../runtime';
import { MACHINE_SANDBOX_ENV, WORKSPACE_CONFIG_ENV } from '../config';
import { WORKER_ENV } from '../dispatch';
import type { McpServerSpec, Task } from '../types';
import { mcpClient, type McpToolInfo } from '../connections';
import { taskFlow } from './async';
import { asyncTools } from './context/tools';

/** A server's line in the prompt: what it reaches. */
export function serverSummary({ description, connection, url }: McpServerSpec): string {
  return (
    description ??
    (connection
      ? `connection ${connection}`
      : url && URL.canParse(url)
        ? new URL(url).host
        : 'MCP server')
  ).replace(/\s+/g, ' ');
}

/** Read-only by its spec, or by its access, else the task's. */
const readOnlyServer = (server: McpServerSpec, access: 'read' | 'write') =>
  Boolean(server.readOnly) || (server.access ?? access) === 'read';

/** One line per server, without its tools: name, what it reaches, its access mode. */
export function serverLines(servers: McpServerSpec[], access: 'read' | 'write'): string {
  return servers
    .map(
      server =>
        `${server.name}: ${serverSummary(server)}; ${readOnlyServer(server, access) ? 'read-only' : 'read-write'}`,
    )
    .join('\n');
}

/** A server's tools this turn may call, and the listed rest. */
type Narrowed = { server: McpServerSpec; denied: string[] };

/** A turn's servers for its engine: each with the tools it may call, the listed rest denied, Coder's task tools, and the prompt lines of the task's own. */
export interface TurnTools {
  servers: McpServerSpec[];
  denied: Array<[server: string, tool: string]>;
  tools: string[];
  lines: string;
}

/** Every tool a server lists, within the startup window. */
export async function listServerTools(server: McpServerSpec): Promise<McpToolInfo[]> {
  const client = await mcpClient(server, fetch, AbortSignal.timeout(30_000));
  try {
    return await client.tools();
  } finally {
    await client.close().catch(() => {});
  }
}

/** A server narrowed to its allowlist, and to `readOnlyHint` tools when read-only; listed only when one applies. A read-only server that cannot list stays out. */
async function narrowServer(
  server: McpServerSpec,
  access: 'read' | 'write',
  warn: (message: string) => void,
  list: (server: McpServerSpec) => Promise<McpToolInfo[]>,
): Promise<Narrowed | undefined> {
  const readOnly = readOnlyServer(server, access);
  if (!readOnly && !server.tools?.length) return { server, denied: [] };
  let listed: McpToolInfo[];
  try {
    listed = await list(server);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    warn(
      readOnly
        ? `MCP server "${server.name}" did not list its tools (${reason}); left out of this read-only turn.`
        : `MCP server "${server.name}" did not list its tools (${reason}); its allowlist applies as given.`,
    );
    return readOnly ? undefined : { server, denied: [] };
  }
  const allowed = listed
    .filter(
      tool =>
        (!server.tools?.length || server.tools.includes(tool.name)) &&
        (!readOnly || tool.annotations?.readOnlyHint === true),
    )
    .map(tool => tool.name);
  if (!allowed.length) {
    warn(`MCP server "${server.name}" has no tool this turn may call; left out.`);
    return undefined;
  }

  return {
    server: { ...server, tools: allowed },
    denied: listed.map(tool => tool.name).filter(name => !allowed.includes(name)),
  };
}

/** The turn's MCP servers: Coder's task tools bound to the conversation endpoint, then the task's own, each narrowed to what the turn may call; every stdio server knows it runs inside a task. */
export async function turnToolServers(
  task: Pick<Task, 'conversation' | 'flowRunId'>,
  taskDir: string,
  servers: McpServerSpec[],
  options: {
    access: 'read' | 'write';
    onWarning?: (message: string) => void;
    list?: (server: McpServerSpec) => Promise<McpToolInfo[]>;
  },
): Promise<TurnTools> {
  const endpoint = servers.find(
    server => server.name === 'conversation' && !server.command && !server.url,
  );
  const warn = options.onWarning ?? (() => {});
  const narrowed = (
    await Promise.all(
      servers
        .filter(server => server !== endpoint)
        .map(server => narrowServer(server, options.access, warn, options.list ?? listServerTools)),
    )
  ).filter(entry => entry !== undefined);
  const tools = taskToolNames(task);
  const all = [
    ...(tools.length
      ? [
          {
            server: taskToolServer(path.join(taskDir, 'job.json'), tools, endpoint?.env),
            denied: [],
          },
        ]
      : []),
    ...narrowed,
  ];

  return {
    servers: all.map(({ server }) =>
      server.command ? { ...server, env: { ...server.env, [WORKER_ENV]: '1' } } : server,
    ),
    tools,
    denied: all.flatMap(({ server, denied }) =>
      denied.map((tool): [string, string] => [server.name, tool]),
    ),
    lines: serverLines(
      narrowed.map(entry => entry.server).filter(server => !server.alwaysLoad),
      options.access,
    ),
  };
}

/** Coder's task tools for a task: the async tools unless one's flow started it, and the conversation tools in a conversation. */
export function taskToolNames(task: Pick<Task, 'conversation' | 'flowRunId'>): string[] {
  const flow = taskFlow(task);

  return [
    ...(asyncTools.some(tool => tool.flow === flow) ? [] : asyncTools.map(tool => tool.name)),
    ...(task.conversation ? ['reply', 'react', 'history'] : []),
  ];
}

// Codex hands stdio servers only its default environment; history and reviews need these to find state, config and engines.
// Only set ones: a set CLAUDE_CONFIG_DIR, even the default, moves Claude's login to another keychain entry.
const TOOL_ENV = [
  'CODER_HOME',
  'CODER_MCP_MODE',
  WORKSPACE_CONFIG_ENV,
  MACHINE_SANDBOX_ENV,
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_PROJECT_DIR_NAME',
];

/** Coder's task tools entry, bound to a task's record and its conversation endpoint. */
export function taskToolServer(
  file: string,
  tools: string[],
  env: Record<string, string> = {},
): McpServerSpec {
  return {
    name: 'coder',
    command: process.execPath,
    args: [CLI_PATH, 'task', 'tools', ...tools],
    env: {
      ...env,
      ...Object.fromEntries(
        TOOL_ENV.flatMap(name => (process.env[name] ? [[name, process.env[name]]] : [])),
      ),
      CODER_HISTORY_TASK: file,
    },
    tools,
    alwaysLoad: true,
  };
}
