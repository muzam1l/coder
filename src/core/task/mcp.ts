/** A turn's MCP servers: Coder's task tools, then the task's own; read-only is enforced at call time. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CLI_PATH } from '../runtime';
import { MACHINE_SANDBOX_ENV, WORKSPACE_CONFIG_ENV } from '../config';
import { WORKER_ENV } from '../dispatch';
import type { McpServerSpec, Task } from '../types';
import { mcpClient, type McpToolInfo } from '../connections';
import { taskFlow } from './async';
import { asyncTools } from './context/tools';
import { SEARCH_TOOLS, TOOL_SEARCH_ENV } from './context/tools';

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

/** A turn's servers for its engine: Coder's task tools, then the task's own, read-only ones marked `readOnly`; and the prompt lines of the task's own. */
export interface TurnTools {
  servers: McpServerSpec[];
  tools: string[];
  lines: string;
  /** Removes the turn's tool search file. */
  cleanup(): void;
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

/** The turn's MCP servers: Coder's task tools bound to the conversation endpoint, then the task's own, none of them listed. Every stdio server knows it runs inside a task. */
export function turnToolServers(
  task: Pick<Task, 'conversation' | 'flowRunId'>,
  taskDir: string,
  servers: McpServerSpec[],
  options: {
    access: 'read' | 'write';
    /** Front the task's servers with Coder's tool search. */
    search?: boolean;
  },
): TurnTools {
  const endpoint = servers.find(
    server => server.name === 'conversation' && !server.command && !server.url,
  );
  const own = servers
    .filter(server => server !== endpoint)
    .map(server =>
      readOnlyServer(server, options.access) ? { ...server, readOnly: true } : server,
    );
  const tools = taskToolNames(task);

  const inTask = (server: McpServerSpec) =>
    server.command ? { ...server, env: { ...server.env, [WORKER_ENV]: '1' } } : server;
  const fronted = options.search ? own : [];
  const file = fronted.length ? path.join(taskDir, `tools-${randomUUID()}.json`) : undefined;
  if (file) {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fronted.map(inTask)), { flag: 'wx', mode: 0o600 });
  }

  return {
    servers: [
      ...(tools.length
        ? [taskToolServer(path.join(taskDir, 'job.json'), tools, endpoint?.env)]
        : []),
      ...(options.search ? [] : own),
      ...(file ? [toolSearchServer(file)] : []),
    ].map(inTask),
    tools,
    lines: serverLines(own, options.access),
    cleanup: () => file && fs.rmSync(file, { force: true }),
  };
}

/** Coder's task tools for a task: the async tools unless one's flow started it, `escalate` in `auto`, and the conversation tools in a conversation. */
export function taskToolNames(
  task: Pick<Task, 'conversation' | 'flowRunId' | 'permissions'>,
): string[] {
  const flow = taskFlow(task);

  return [
    ...(asyncTools.some(tool => tool.flow === flow) ? [] : asyncTools.map(tool => tool.name)),
    ...((task.permissions ?? 'auto') === 'auto' ? ['escalate'] : []),
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

/** The variables of `TOOL_ENV` this process has. */
const toolEnvironment = () =>
  Object.fromEntries(
    TOOL_ENV.flatMap(name => (process.env[name] ? [[name, process.env[name]]] : [])),
  );

/** Coder's tool search entry, over the servers in `file`. */
function toolSearchServer(file: string): McpServerSpec {
  return {
    name: 'tools',
    command: process.execPath,
    args: [CLI_PATH, 'task', 'tools-search'],
    env: { ...toolEnvironment(), [TOOL_SEARCH_ENV]: file },
    tools: SEARCH_TOOLS,
    alwaysLoad: true,
  };
}

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
    env: { ...env, ...toolEnvironment(), CODER_HISTORY_TASK: file },
    tools,
    alwaysLoad: true,
  };
}
