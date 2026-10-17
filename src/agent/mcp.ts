import process from 'node:process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../core/runtime';
import type { McpServerSpec, Task } from '../core/types';
import { INTEGRATIONS } from '../integrations';
import type { AgentEvent, AgentTask } from './types';
import { schema, type McpTool } from '../utils/mcp-server';
import { history } from '../core/engines/history';
import { connectionEnvironment } from '../core/connections';
import { claudeProjectsDir } from '../core/engines/claude/sessions';
import { codexHome } from '../core/engines/codex/sessions';
import { eventJsons } from '../core/event-prompt';
import { appendTaskDirLog } from '../core/state';

type ToolSet = Record<string, McpTool<{ fetch?: typeof fetch }>>;

/** The Chat SDK subset served to conversation tasks. */
export function agentTools(id: string): ToolSet | undefined {
  return id === 'history' ? HISTORY_TOOLS : undefined;
}

/** `APP_TOKEN_<UPPER_ID>`: the env var carrying one integration's token inside a task. */
export function tokenEnvName(integration: string): string {
  return `APP_TOKEN_${integration.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

/** A server name from a handle key: `github:Acme Org` becomes `github-acme-org`. */
const serverName = (key: string) =>
  key
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** MCP spec for an integration's tools; the token reaches only the tool server, never the engine. */
export function agentToolServer(
  integration: string,
  tools: string[],
  context: { token: string; event?: AgentEvent; account?: string },
): McpServerSpec {
  const { name, tools: catalog, repos } = INTEGRATIONS[integration]!;
  const { readOnly, ...spec } = catalog.server(tools, context.event, context.token);
  const env = Object.entries(spec.env ?? {}).find(([, value]) => value === context.token)?.[0];
  const access = tools.some(tool => !catalog.presets.read.includes(tool)) ? 'write' : 'read';

  return {
    ...spec,
    name: serverName(handleKey(integration, context.account)),
    integration,
    ...(context.account ? { account: context.account } : {}),
    description: context.account
      ? `${name} ${context.account}`
      : `${name}, the account this task started in`,
    access,
    ...(readOnly && spec.command
      ? { command: process.execPath, args: [CLI_PATH, 'agent', 'tools', integration], readOnly }
      : {}),
    ...(env ? { credentialFields: { env } } : {}),
    ...(repos?.credentialUsername ? { gitCredential: true } : {}),
  };
}

/** A tool server name for an installation: the event's own keeps its integration id, every other one adds its account. */
export const handleKey = (integration: string, account?: string) =>
  account ? `${integration}:${account}` : integration;

/** The token a platform tool server spec carries, whatever env name or header its integration uses. */
export function serverToken(server: McpServerSpec | undefined): string | undefined {
  if (!server?.integration || !INTEGRATIONS[server.integration]) return undefined;
  const probe = agentToolServer(server.integration, [], { token: '\0' });
  const key = Object.entries(probe.env ?? {}).find(([, value]) => value === '\0')?.[0];
  const header = probe.credentialFields?.header;

  return key
    ? server.env?.[key] || undefined
    : header ? server.headers?.[header]?.replace(/^Bearer /, '') : undefined;
}

/** The token of the task's own tool server for an integration. */
export function toolServerToken(servers: McpServerSpec[], integration: string): string | undefined {
  return serverToken(servers.find(server => server.name === integration));
}

/** One tool server per handle token whose integration is in `task.tools`; a second account of the same name gets a numbered server. A member's `native` token keeps its own scopes, so it clones only in write mode. */
export function taskToolServers(
  task: Pick<AgentTask, 'tools' | 'event'>,
  tokens: Record<string, string | undefined>,
  native: Iterable<string> = [],
): McpServerSpec[] {
  const names = new Set<string>();
  const personal = new Set(native);

  return Object.entries(tokens).flatMap(([key, token]) => {
    const [id, account] = key.split(/:(.*)/) as [string, string?];
    const tools = task.tools[id];
    if (!INTEGRATIONS[id] || !token || !tools?.length) return [];
    const server = agentToolServer(id, tools, {
      token,
      ...(task.event ? { event: task.event } : {}),
      ...(account ? { account } : {}),
    });
    if (personal.has(key) && server.access === 'read') delete server.gitCredential;
    let name = server.name;
    for (let suffix = 2; names.has(name); suffix++) name = `${server.name}-${suffix}`;
    names.add(name);

    return [{ ...server, name }];
  });
}

/** Where a conversation task's reply and react tools post: the poster's task callback path and the attempt token. */
export interface ReplyEndpoint {
  url: string;
  token: string;
}

/** Task tool servers with their tokens in the worker env, under names every turn of the task shares. */
export function nativeToolEnvironment(
  task: Pick<AgentTask, 'tools' | 'event'>,
  tokens: Record<string, string | undefined>,
  reply?: ReplyEndpoint,
  native: Iterable<string> = [],
) {
  return connectionEnvironment(
    Object.fromEntries([
      ...taskToolServers(task, tokens, native).map(server => [
        `native:${server.name}`,
        { ...server, resolved: true },
      ]),
      // The token travels like a tool credential: a placeholder in the task record, the value in the worker env.
      ...(reply
        ? [
            [
              'native:history',
              {
                name: 'history',
                resolved: true,
                env: { CODER_REPLY_URL: reply.url, CODER_REPLY_TOKEN: reply.token },
                credentialFields: { env: 'CODER_REPLY_TOKEN' },
              },
            ],
          ]
        : []),
    ]),
  );
}

/** The turn's MCP servers: the conversation tools bound to the poster's endpoint, then the rest. */
export function turnToolServers(
  task: Pick<Task, 'conversation'>,
  taskDir: string,
  servers: McpServerSpec[],
): McpServerSpec[] {
  const endpoint = servers.find(
    server => server.name === 'history' && !server.command && !server.url,
  );
  const rest = servers.filter(server => server !== endpoint);

  return task.conversation
    ? [historyToolServer(path.join(taskDir, 'job.json'), endpoint?.env), ...rest]
    : rest;
}

/** The servers a Codex turn gets: the ones loaded directly, then one hub that fronts the rest on demand. */
export function hubbedToolServers(
  cwd: string,
  taskId: string,
  servers: McpServerSpec[],
): McpServerSpec[] {
  const direct = servers.filter(server => server.alwaysLoad);
  if (direct.length === servers.length) return servers;
  // The hub and the servers it starts see the worker's PATH, not the engine's.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        /^(?:PATH|CODER_(?:HOME|CONNECTION_[A-F0-9]{24}|MCP_[A-Z_]+))$/.test(entry[0]) &&
        entry[1] !== undefined,
    ),
  );

  return [
    ...direct,
    {
      name: 'coder',
      command: process.execPath,
      args: [CLI_PATH, 'task', 'hub', taskId, '--cwd', cwd],
      env,
      tools: ['find_tools', 'call_tool'],
      alwaysLoad: true,
    },
  ];
}

export async function gitToolEnvironment(
  servers: McpServerSpec[],
): Promise<{ env: Record<string, string>; close(): Promise<void> }> {
  const credentials = servers.flatMap(server => {
    const repos = server.integration ? INTEGRATIONS[server.integration]?.repos : undefined;
    const password = server.gitCredential && repos?.credentialUsername && serverToken(server);

    return password && !/[\r\n]/.test(password)
      ? repos!.cloneHosts.map(host => ({
          host,
          username: repos!.credentialUsername,
          password,
          ...(server.account ? { owner: server.account.toLowerCase() } : {}),
        }))
      : [];
  });
  if (!credentials.length) return { env: {}, close: async () => {} };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coder-git-'));
  const helper = path.join(root, 'credential.cjs');
  try {
    await fs.writeFile(path.join(root, 'tokens.json'), JSON.stringify(credentials), {
      mode: 0o600,
    });
    // The account's own token for its repositories, else the task's own installation.
    await fs.writeFile(
      helper,
      `const fs = require('node:fs');
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', () => {
  if (process.argv[2] !== 'get') return;
  const fields = Object.fromEntries(input.trim().split('\\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const entries = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'tokens.json'), 'utf8'));
  const owner = (fields.path || '').split('/')[0].toLowerCase();
  const hosted = entries.filter(entry => fields.protocol === 'https' && fields.host === entry.host);
  const credential = hosted.find(entry => entry.owner === owner) || hosted.find(entry => !entry.owner) || hosted[0];
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
        GIT_CONFIG_COUNT: String(count + 3),
        [`GIT_CONFIG_KEY_${count}`]: 'credential.helper',
        [`GIT_CONFIG_VALUE_${count}`]: '',
        [`GIT_CONFIG_KEY_${count + 1}`]: 'credential.helper',
        [`GIT_CONFIG_VALUE_${count + 1}`]: `!${quote(process.execPath)} ${quote(helper)}`,
        [`GIT_CONFIG_KEY_${count + 2}`]: 'credential.useHttpPath',
        [`GIT_CONFIG_VALUE_${count + 2}`]: 'true',
      },
      close: () => fs.rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true });
    throw error;
  }
}

/** One direct request to the poster; a retry after a network failure reuses the call id, so it posts once. */
async function askPoster(
  kind: 'reply' | 'react',
  payload: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<{ ok: true }> {
  const url = process.env.CODER_REPLY_URL;
  const token = process.env.CODER_REPLY_TOKEN;
  if (!url || !token) throw new Error('This task has no conversation to post to');
  const body = JSON.stringify({ id: randomUUID(), ...payload });
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await request(`${url}/${kind}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      if (attempt < 2) continue;
      throw error;
    }
    const answer = (await response.json().catch(() => undefined)) as
      { ok?: boolean; error?: string } | undefined;
    if (!response.ok)
      throw new Error(answer?.error ?? `The conversation ${kind} failed (${response.status})`);

    return { ok: true };
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
    handler: async (a, ctx) => {
      const file = process.env.CODER_HISTORY_TASK;
      if (!file) throw new Error('CODER_HISTORY_TASK is not set');
      const task = JSON.parse(await fs.readFile(file, 'utf8')) as Task;
      if (!task.conversation) throw new Error('Only conversation tasks can reply');
      if (typeof a.text !== 'string' || !a.text.trim()) throw new Error('Reply text is required');
      const text = a.text.trim();

      const sent = await askPoster('reply', { text }, ctx?.fetch);
      // The turn's last reply, so the same text as the final message is not posted twice.
      appendTaskDirLog(path.dirname(file), { kind: 'reply', message: text });

      return sent;
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
    handler: async (a, ctx) => {
      const file = process.env.CODER_HISTORY_TASK;
      if (!file) throw new Error('CODER_HISTORY_TASK is not set');
      const task = JSON.parse(await fs.readFile(file, 'utf8')) as Task;
      if (!task.conversation) throw new Error('Only conversation tasks can react');
      if (typeof a.emoji !== 'string' || !a.emoji.trim()) throw new Error('Emoji is required');
      if (a.message !== undefined && (typeof a.message !== 'string' || !a.message.trim()))
        throw new Error('Message id must be a non-empty string');
      const event = eventJsons(task.currentPrompt ?? task.prompt ?? '', true)?.[0];
      const message = a.message ?? event?.message?.id ?? event?.messages?.[0]?.id;
      if (event && !message)
        throw new Error('This turn has no message to react to; give a message id');

      return askPoster(
        'react',
        { emoji: a.emoji.trim(), ...(message ? { message } : {}) },
        ctx?.fetch,
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

export function historyToolServer(file: string, env: Record<string, string> = {}): McpServerSpec {
  return {
    name: 'history',
    command: process.execPath,
    args: [CLI_PATH, 'agent', 'tools', 'history'],
    env: {
      ...env,
      CODER_HISTORY_TASK: file,
      CODEX_HOME: codexHome(),
      CLAUDE_CONFIG_DIR: path.dirname(claudeProjectsDir()),
    },
    tools: Object.keys(HISTORY_TOOLS),
    alwaysLoad: true,
  };
}
