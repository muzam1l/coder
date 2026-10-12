import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CLI_PATH } from '../core/runtime';
import type { McpServerSpec } from '../core/types';
import { INTEGRATIONS } from '../integrations';
import type { AgentEvent, AgentTask } from './types';
import type { ToolSet } from '../integrations/types';
import { schema } from '../utils/mcp-server';

/** Tool sets coder serves over stdio: one per integration plus `note`. */
export function agentTools(id: string, allowed?: string[]): ToolSet | undefined {
  if (id === 'note') return NOTE_TOOLS;
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
