/** A turn's MCP servers: Coder's task tools, then the tool search over the task's own; read-only is enforced at call time. */
import path from 'node:path';
import process from 'node:process';
import { instructions, walk } from 'contextjsx/emit';

import { MACHINE_SANDBOX_ENV, WORKSPACE_CONFIG_ENV, strictestAccess, type Access } from '../config';
import { CLI_PATH, CODER_APP_NAME } from '../runtime';
import { WORKER_ENV } from '../dispatch';
import type { McpServerSpec, Task } from '../types';
import { mcpClient, type McpToolInfo } from '../connections';
import {
  connect,
  toolSearchServer,
  type CredentialSource,
  type SearchEndpoint,
} from '../tool-search';
import { taskFlow } from './async';
import { asyncTools, taskApp } from './context/tools';
import type { PromptServer } from './context/system';

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

/** Read-only by its spec, its access or the task's. */
const readOnlyServer = (server: McpServerSpec, access: Access) =>
  Boolean(server.readOnly) || strictestAccess(server.access, access) === 'read-only';

/** A turn's servers for its engine: Coder's task tools and the tool search over the task's own, read-only ones marked `readOnly`; and the task's own for the prompt. */
interface TurnTools {
  servers: McpServerSpec[];
  tools: string[];
  /** The task's own servers, for the prompt's server list. */
  listed: McpServerSpec[];
  /** The workspace's dashboard on the conversation endpoint's server. */
  dashboard?: string;
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

/** The turn's MCP servers: Coder's task tools bound to the conversation endpoint, then the tool search over the task's own, a conversation's Coder server first. Every stdio server knows it runs inside a task. */
export function turnToolServers(
  task: Pick<Task, 'conversation' | 'flowRunId' | 'access'>,
  taskDir: string,
  servers: McpServerSpec[],
  options: { access: Access },
): TurnTools {
  const endpoint = (name: string) =>
    servers.find(server => server.name === name && !server.command && !server.url);
  const conversation = endpoint('conversation');
  const coder = endpoint(CODER_APP_NAME);
  const inTask = (server: McpServerSpec) =>
    server.command ? { ...server, env: { ...server.env, [WORKER_ENV]: '1' } } : server;
  const coderSpec: McpServerSpec | undefined = task.conversation
    ? { ...coderServer(coder?.env), connect: 'start' }
    : undefined;
  const own = [
    ...(coderSpec ? [coderSpec] : []),
    ...servers.filter(server => server !== conversation && server !== coder),
  ].map(server =>
    // Read-only access never applies to Coder itself; only its own spec does.
    inTask(
      readOnlyServer(
        server,
        server === coderSpec ? 'auto' : strictestAccess(task.access, options.access),
      )
        ? { ...server, readOnly: true }
        : server,
    ),
  );
  const tools = taskToolNames(task);
  const reply = conversation?.env?.CODER_REPLY_URL;
  const token = conversation?.env?.CODER_REPLY_TOKEN;
  // Connections are reconnected on the dashboard of the server the conversation endpoint is on.
  const reconnect =
    reply && URL.canParse(reply) ? `${new URL(reply).origin}/dash/settings/connections` : undefined;

  return {
    servers: [
      ...(tools.length
        ? [taskToolServer(path.join(taskDir, 'job.json'), tools, conversation?.env)]
        : []),
      ...(own.length
        ? [
            {
              ...toolSearchServer(
                {
                  command: process.execPath,
                  args: [CLI_PATH, 'task', 'tools-search'],
                  env: toolEnvironment(),
                },
                own,
                reconnect,
                reply && token ? { url: reply, token } : undefined,
              ),
              alwaysLoad: true,
            },
          ]
        : []),
    ].map(inTask),
    tools,
    listed: own,
    ...(coder?.env?.CODER_DASHBOARD ? { dashboard: coder.env.CODER_DASHBOARD } : {}),
  };
}

/** Coder's task tools entry, bound to a task's record and its conversation endpoint; Coder's client always loads them. */
export function taskToolServer(
  file: string,
  tools: string[],
  env: Record<string, string> = {},
): McpServerSpec {
  return {
    name: taskApp.name,
    command: process.execPath,
    args: [CLI_PATH, 'task', 'tools', ...tools],
    env: { ...env, ...toolEnvironment(), CODER_HISTORY_TASK: file },
    tools,
    alwaysLoad: true,
  };
}

/** Coder's own MCP server with the task's server and token: bound to them in a cloud task; on this machine the local `coder mcp`, which starts children through them. */
function coderServer(env: Record<string, string> = {}): McpServerSpec {
  return {
    name: CODER_APP_NAME,
    command: process.execPath,
    args: [CLI_PATH, 'mcp'],
    env: { ...env, ...toolEnvironment() },
  };
}

/** A connection's token from the task's server, which refreshes it then; none when it needs reconnecting. A refusal, such as a Just me connection waiting for its owner, is the error the model reads. */
export const serverCredential =
  (endpoint: SearchEndpoint, request: typeof fetch = fetch): CredentialSource =>
  async (spec, refused) => {
    const response = await request(`${endpoint.url}/connection`, {
      method: 'POST',
      headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        connection: spec.connection ?? spec.name,
        url: spec.url,
        connectionCreatedAt: spec.connectionCreatedAt,
        ...(refused ? { refused } : {}),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 403)
      throw new Error(((await response.json()) as { error: string }).error);
    if (!response.ok) throw new Error(`The connection is unavailable (${response.status})`);

    return ((await response.json()) as { token?: string }).token;
  };

/** The Coder server's description, instructions and tool names from the app `coder mcp` serves with its env, so only the tool search starts it. */
async function coderPrompt(
  env: Record<string, string> = {},
): Promise<Pick<PromptServer, 'description' | 'started'>> {
  const apps = await import('../../context');
  const app = env.CODER_MCP_MODE === 'cloud' ? apps.cloudApp : apps.app;
  const tools = walk(app).commands.flatMap(entry =>
    entry.command.mcp === false ? [] : [entry.id],
  );

  return {
    ...(app.description ? { description: app.description } : {}),
    started: {
      instructions: instructions(app),
      tools: [...tools, ...(app.skills?.length ? ['load_skill'] : [])],
    },
  };
}

/** The prompt's servers; each `start` one is connected now for its description, instructions and tool names, except the Coder server, read in-process. */
export function promptServers(servers: McpServerSpec[]): Promise<PromptServer[]> {
  return Promise.all(
    servers.map(async server => {
      if (server.connect !== 'start') return server;
      if (server.name === CODER_APP_NAME) return { ...server, ...(await coderPrompt(server.env)) };
      const connected = await connect(server, 10_000).catch(() => undefined);
      await connected?.client.close().catch(() => {});
      const description = connected?.serverInfo?.description;

      return connected
        ? {
            ...server,
            ...(description ? { description } : {}),
            started: {
              instructions: connected.instructions,
              tools: connected.tools.map(tool => tool.name),
            },
          }
        : server;
    }),
  );
}

/** Coder's task tools for a task: the async tools unless one's flow started it, `escalate` in `auto`, and the conversation tools in a conversation. */
export function taskToolNames(task: Pick<Task, 'conversation' | 'flowRunId' | 'access'>): string[] {
  const flow = taskFlow(task);

  return [
    ...(asyncTools.some(tool => tool.flow === flow) ? [] : asyncTools.map(tool => tool.name)),
    ...((task.access ?? 'auto') === 'auto' ? ['escalate'] : []),
    ...(task.conversation ? ['reply', 'react', 'history'] : []),
  ];
}
