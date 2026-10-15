import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../core/runtime';
import type { McpServerSpec, Task } from '../core/types';
import { INTEGRATIONS } from '../integrations';
import type { AgentEvent, AgentTask } from './types';
import type { ToolSet } from '../integrations/types';
import { schema } from '../utils/mcp-server';
import { history } from '../core/engines/history';
import { connectionEnvironment } from '../core/connections';
import { claudeProjectsDir } from '../core/engines/claude/sessions';
import { codexHome } from '../core/engines/codex/sessions';
import { askWorker } from '../core/mailbox';

/** Tool sets coder serves over stdio: one per integration plus task history. */
export function agentTools(id: string, allowed?: string[]): ToolSet | undefined {
  if (id === 'history') return HISTORY_TOOLS;
  const integration = INTEGRATIONS[id]?.tools;
  const tools = integration?.serve;
  if (
    !tools ||
    !allowed ||
    !Object.values(integration!.presets).some(names =>
      names.some(name => Object.hasOwn(tools, name)),
    )
  )
    return tools;

  return Object.fromEntries(Object.entries(tools).filter(([name]) => allowed.includes(name)));
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
  const { serve, server, presets } = INTEGRATIONS[integration]!.tools;
  if (server) {
    const spec = server(tools, context.event, context.token);
    const env = Object.entries(spec.env ?? {}).find(([, value]) => value === context.token)?.[0];
    return {
      ...spec,
      ...(env ? { credentialFields: { env } } : {}),
      ...(INTEGRATIONS[integration]!.repos?.credentialUsername
        ? { gitCredential: tools.some(tool => !presets.observe.includes(tool)) }
        : {}),
    };
  }
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
    credentialFields: { env: 'APP_TOKEN' },
    tools: Object.keys(agentTools(integration, tools) ?? serve ?? {}),
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
  task: Pick<AgentTask, 'tools' | 'event' | 'toolScopes'>,
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

/** Task tool servers with their tokens in the worker env, under names every turn of the task shares. */
export function nativeToolEnvironment(
  task: Pick<AgentTask, 'tools' | 'event' | 'toolScopes'>,
  tokens: Record<string, string | undefined>,
) {
  return connectionEnvironment(
    Object.fromEntries(
      taskToolServers(task, tokens).map(server => [
        `native:${server.name}`,
        { ...server, resolved: true },
      ]),
    ),
  );
}

export async function gitToolEnvironment(
  servers: McpServerSpec[],
): Promise<{ env: Record<string, string>; close(): Promise<void> }> {
  const credentials = Object.values(INTEGRATIONS).flatMap(integration => {
    const repos = integration.repos;
    const password = toolServerToken(
      servers.filter(server => server.gitCredential),
      integration.id,
    );

    return repos?.credentialUsername && password && !/[\r\n]/.test(password)
      ? repos.cloneHosts.map(host => ({ host, username: repos.credentialUsername, password }))
      : [];
  });
  if (!credentials.length) return { env: {}, close: async () => {} };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coder-git-'));
  const helper = path.join(root, 'credential.cjs');
  try {
    await fs.writeFile(path.join(root, 'tokens.json'), JSON.stringify(credentials), {
      mode: 0o600,
    });
    await fs.writeFile(
      helper,
      `const fs = require('node:fs');
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  if (process.argv[2] !== 'get') return;
  const fields = Object.fromEntries(input.trim().split('\\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const entries = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'tokens.json'), 'utf8'));
  const credential = entries.find(entry => fields.protocol === 'https' && fields.host === entry.host);
  if (credential) process.stdout.write('username=' + credential.username + '\\npassword=' + credential.password + '\\n');
});
`,
      { mode: 0o600 },
    );
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
    if (!Number.isInteger(count) || count < 0 || count > 1000)
      throw new Error('Invalid git config count');

    return {
      env: {
        GIT_CONFIG_COUNT: String(count + 2),
        [`GIT_CONFIG_KEY_${count}`]: 'credential.helper',
        [`GIT_CONFIG_VALUE_${count}`]: '',
        [`GIT_CONFIG_KEY_${count + 1}`]: 'credential.helper',
        [`GIT_CONFIG_VALUE_${count + 1}`]: `!${quote(process.execPath)} ${quote(helper)}`,
      },
      close: () => fs.rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

const HISTORY_TOOLS: ToolSet = {
  reply: {
    description:
      'Post a reply now, during your turn, such as before longer work. Your final message is a reply too; never send the same text twice.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Markdown to post.' } },
      required: ['text'],
    },
    handler: async a => {
      const file = process.env.CODER_HISTORY_TASK;
      if (!file) throw new Error('CODER_HISTORY_TASK is not set');
      const task = JSON.parse(await fs.readFile(file, 'utf8')) as Task;
      if (!task.conversation) throw new Error('Only conversation tasks can reply');

      return askWorker(
        'reply',
        { text: a.text },
        {
          dir: path.join(path.dirname(file), 'replies'),
          timeoutMs: 60_000,
        },
      );
    },
  },
  react: {
    description:
      'React to a message in this conversation with an emoji, by default the one that started your turn.',
    inputSchema: {
      type: 'object',
      properties: {
        emoji: {
          type: 'string',
          description: 'An emoji name such as thumbsup, or the emoji itself.',
        },
        message: { type: 'string', description: 'A message id from the conversation.' },
      },
      required: ['emoji'],
    },
    handler: async a => {
      const file = process.env.CODER_HISTORY_TASK;
      if (!file) throw new Error('CODER_HISTORY_TASK is not set');
      const task = JSON.parse(await fs.readFile(file, 'utf8')) as Task;
      if (!task.conversation) throw new Error('Only conversation tasks can react');

      return askWorker(
        'react',
        { emoji: a.emoji, message: a.message },
        {
          dir: path.join(path.dirname(file), 'replies'),
          timeoutMs: 60_000,
        },
      );
    },
  },
  history: {
    description:
      "Search or read this task's earlier conversation, including your tool calls and results, oldest first. With query, the messages containing that exact text; without, the messages from `from` on.",
    inputSchema: schema({ query: 'string', from: 'number', limit: 'number' }, [], {
      query:
        'Exact text to find, case-insensitive, 1 to 500 characters: a word or phrase from the message, not a question.',
      from: 'Message index to start at; default the oldest, or after the last match.',
      limit: 'Messages to return, 1 to 20; default 10.',
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    handler: async a => {
      const file = process.env.CODER_HISTORY_TASK;
      if (!file) throw new Error('CODER_HISTORY_TASK is not set');
      const task = JSON.parse(await fs.readFile(file, 'utf8')) as Task;

      return history(task, a);
    },
  },
};

export function historyToolServer(file: string): McpServerSpec {
  return {
    name: 'history',
    command: process.execPath,
    args: [CLI_PATH, 'agent', 'tools', 'history'],
    env: {
      CODER_HISTORY_TASK: file,
      CODEX_HOME: codexHome(),
      CLAUDE_CONFIG_DIR: path.dirname(claudeProjectsDir()),
    },
    tools: Object.keys(HISTORY_TOOLS),
  };
}
