import process from 'node:process';
import fs from 'node:fs/promises';

import { CLI_PATH } from '../core/runtime';
import type { McpServerSpec } from '../core/types';
import { INTEGRATIONS } from '../integrations';
import type { AgentEvent, AgentTask } from './types';
import type { ToolSet } from '../integrations/types';
import { schema } from '../utils/mcp-server';

/** Tool sets coder serves over stdio: one per integration plus `note`. */
export function agentTools(id: string): ToolSet | undefined {
  if (id === 'note') return NOTE_TOOLS;
  return INTEGRATIONS[id]?.tools.serve;
}

/** `APP_TOKEN_<UPPER_ID>`: the env var carrying one integration's token inside a task. */
export function tokenEnvName(integration: string): string {
  return `APP_TOKEN_${integration.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** MCP spec for an integration's tools; the token reaches only the tool server, never the engine. */
export function agentToolServer(
  integration: string,
  tools: string[],
  context: { token: string; event?: AgentEvent; scope?: unknown },
): McpServerSpec {
  const { serve, server } = INTEGRATIONS[integration]!.tools;
  if (server) return server(tools, context.event, context.token);
  // Only where the task may write; never the payload or a reply capability.
  const scope =
    context.scope ?? (context.event?.chat ? { thread: context.event.chat.thread.id } : undefined);
  return {
    name: integration,
    command: process.execPath,
    args: [CLI_PATH, 'agent', 'tools', integration],
    env: {
      APP_TOKEN: context.token,
      CODER_AGENT_TOOLS: tools.join(','),
      ...(scope ? { CODER_AGENT_SCOPE: JSON.stringify(scope) } : {}),
    },
    tools: Object.keys(serve ?? {}),
  };
}

/** The token an integration's tool server spec carries, whatever env name holds it. */
export function toolServerToken(servers: McpServerSpec[], integration: string): string | undefined {
  if (!INTEGRATIONS[integration]) return undefined;
  const probe = agentToolServer(integration, [], { token: '\0' });
  const key = Object.entries(probe.env ?? {}).find(([, value]) => value === '\0')?.[0];
  return key
    ? servers.find(server => server.name === probe.name)?.env?.[key] || undefined
    : undefined;
}

/** One tool server per integration in `task.tools` that has a token. */
export function taskToolServers(
  task: AgentTask,
  tokens: Record<string, string | undefined>,
): McpServerSpec[] {
  return Object.entries(task.tools).flatMap(([id, tools]) => {
    const token = tokens[id];
    return INTEGRATIONS[id] && token && tools.length
      ? [
          agentToolServer(id, tools, {
            token,
            ...(task.event ? { event: task.event } : {}),
            scope: task.toolScopes?.[id],
          }),
        ]
      : [];
  });
}

export const NOTE_FILE_ENV = 'CODER_NOTE_FILE';

const MAX_NOTE_CHARS = 2000;

export const NOTE_TOOLS: ToolSet = {
  note: {
    description:
      "Read this thread's note, or replace it by passing text: at most 5 short lines a future turn in this thread must remember. Empty text clears it.",
    inputSchema: schema({ text: 'string' }, []),
    handler: async a => {
      const file = process.env[NOTE_FILE_ENV];
      if (!file) throw new Error(`${NOTE_FILE_ENV} is not set`);
      if (typeof a.text !== 'string')
        return { note: await fs.readFile(file, 'utf8').catch(() => '') };
      if (a.text.length > MAX_NOTE_CHARS)
        throw new Error(`A note holds at most ${MAX_NOTE_CHARS} characters`);
      await fs.writeFile(file, a.text.trim());
      return { saved: true };
    },
  },
};

export function noteToolServer(file: string): McpServerSpec {
  return {
    name: 'note',
    command: process.execPath,
    args: [CLI_PATH, 'agent', 'tools', 'note'],
    env: { [NOTE_FILE_ENV]: file },
    tools: Object.keys(NOTE_TOOLS),
  };
}
