import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { McpServerSpec } from '../core/types';
import { INTEGRATIONS } from '../integrations';
import type { AgentEvent, AgentTask } from './types';
import { connectionEnvironment } from '../core/connections';

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
    ...(readOnly ? { readOnly } : {}),
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
    : header
      ? server.headers?.[header]?.replace(/^Bearer /, '')
      : undefined;
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

/** Where a conversation task's reply and react tools post: the conversation endpoint's task callback path and the attempt token. */
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
              'native:conversation',
              {
                name: 'conversation',
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
