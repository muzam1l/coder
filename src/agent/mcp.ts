import process from 'node:process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { McpServerSpec } from '../core/types';
import { INTEGRATIONS } from '../integrations';
import type { AgentEvent, AgentTask, Connection } from './types';
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
  context: { token: string; event?: AgentEvent; account?: string; owner?: string },
): McpServerSpec {
  const { name, tools: catalog, repos, reach } = INTEGRATIONS[integration]!;
  const { readOnly, ...spec } = catalog.server(tools, context.event, context.token, context.owner);
  const env = Object.entries(spec.env ?? {}).find(([, value]) => value === context.token)?.[0];
  const access = tools.some(tool => !catalog.presets['read-only'].includes(tool))
    ? 'auto'
    : 'read-only';
  // The event's own installation is on the account of the event's repository.
  const account =
    context.account ??
    (context.event?.integration === integration ? context.event.repo?.owner : undefined);

  return {
    ...spec,
    name: serverName(handleKey(integration, context.account)),
    integration,
    ...(account ? { account } : {}),
    description: context.account
      ? (reach?.(context.account) ?? `${name} ${context.account}`)
      : `${name}, where this conversation is`,
    access,
    ...(readOnly ? { readOnly } : {}),
    ...(env ? { credentialFields: { env } } : {}),
    ...(repos?.credentialUsername ? { gitCredential: true } : {}),
  };
}

/** The platforms a task has tools on, for its prompt; `personal` where a person can connect their own account. */
export const taskPlatforms = (task: Pick<AgentTask, 'tools'>) =>
  Object.entries(task.tools ?? {}).flatMap(([id, tools]) => {
    const integration = INTEGRATIONS[id];

    return integration && tools?.length
      ? [{ id, name: integration.name, ...(integration.auth.user ? { personal: true } : {}) }]
      : [];
  });

/** A tool server name for an installation: the event's own keeps its integration id, every other one adds its account. */
export const handleKey = (integration: string, account?: string) =>
  account ? `${integration}:${account}` : integration;

/** The token a platform tool server spec carries, whatever env name or header its integration uses. */
function serverToken(server: McpServerSpec | undefined): string | undefined {
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

/** One tool server per handle token whose integration is in `task.tools`; a second account of the same name gets a numbered server. */
export function taskToolServers(
  task: Pick<AgentTask, 'tools' | 'event'>,
  tokens: Record<string, string | undefined>,
): McpServerSpec[] {
  const names = new Set<string>();

  return Object.keys(tokens).flatMap(key => {
    const [id, account] = key.split(/:(.*)/) as [string, string?];
    const tools = task.tools[id];
    const token = tokens[key];
    if (!INTEGRATIONS[id] || !token || !tools?.length) return [];
    const server = agentToolServer(id, tools, {
      token,
      ...(task.event ? { event: task.event } : {}),
      ...(account ? { account } : {}),
    });
    let name = server.name;
    for (let suffix = 2; names.has(name); suffix++) name = `${server.name}-${suffix}`;
    names.add(name);

    return [{ ...server, name }];
  });
}

/** A Just me platform connection's tool server, named for the connection; its token loads on first use. */
export function connectionToolServer(
  connection: Pick<Connection, 'id' | 'name' | 'provider' | 'owner' | 'account' | 'login'>,
  tools: string[],
  event?: AgentEvent,
): McpServerSpec {
  // A probe marks the credential field, left empty until first use.
  const server = agentToolServer(connection.provider, tools, {
    token: '\0',
    ...(event ? { event } : {}),
    ...(connection.owner ? { owner: connection.owner } : {}),
  });
  for (const field of ['env', 'headers'] as const)
    if (server[field])
      server[field] = Object.fromEntries(
        Object.entries(server[field]).filter(([, value]) => !value.includes('\0')),
      );

  return {
    ...server,
    name: connection.id,
    description: connection.name,
    connection: connection.id,
    credentialOnUse: server.credentialFields,
    owner: connection.owner,
    account: connection.login ?? connection.account,
  };
}

/** Where a conversation task's reply and react tools post: the conversation endpoint's task callback path and the attempt token; and the workspace's dashboard on that server. */
export interface ReplyEndpoint {
  url: string;
  token: string;
  dashboard?: string;
}

/** Task tool servers with their tokens in the worker env, under names every turn of the task shares. */
export function nativeToolEnvironment(
  task: Pick<AgentTask, 'tools' | 'event'>,
  tokens: Record<string, string | undefined>,
  reply?: ReplyEndpoint,
) {
  return connectionEnvironment(
    Object.fromEntries([
      ...taskToolServers(task, tokens).map(server => [
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
            // The Coder server acts as the task on its own server, with the same attempt token.
            [
              'native:coder',
              {
                name: 'coder',
                resolved: true,
                env: {
                  CODER_SERVER: new URL(reply.url).origin,
                  CODER_TASK_TOKEN: reply.token,
                  ...(reply.dashboard ? { CODER_DASHBOARD: reply.dashboard } : {}),
                },
                credentialFields: { env: 'CODER_TASK_TOKEN' },
              },
            ],
          ]
        : []),
    ]),
  );
}

/** Git's credentials for the platform servers: a written token, or a connection's that the helper asks the task's server for on first use. An installation's token wins for the owner it covers; a read-only connection never pushes as its account. */
export async function gitToolEnvironment(
  servers: McpServerSpec[],
): Promise<{ env: Record<string, string>; close(): Promise<void> }> {
  const reply = servers.find(server => server.name === 'conversation')?.env;
  const endpoint =
    reply?.CODER_REPLY_URL && reply.CODER_REPLY_TOKEN
      ? { url: `${reply.CODER_REPLY_URL}/connection`, token: reply.CODER_REPLY_TOKEN }
      : undefined;
  const credentials = servers.flatMap(server => {
    const repos = server.integration ? INTEGRATIONS[server.integration]?.repos : undefined;
    if (!server.gitCredential || !repos?.credentialUsername) return [];
    const password = serverToken(server);
    const connection =
      endpoint && server.credentialOnUse && server.access !== 'read-only'
        ? server.connection
        : undefined;

    return (password || connection) && !/[\r\n]/.test(password ?? '')
      ? repos.cloneHosts.map(host => ({
          host,
          username: repos.credentialUsername,
          ...(password ? { password } : {}),
          ...(connection ? { connection } : {}),
          ...(server.account ? { owner: server.account.toLowerCase() } : {}),
        }))
      : [];
  });
  if (!credentials.length) return { env: {}, close: async () => {} };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'coder-git-'));
  const helper = path.join(root, 'credential.cjs');
  try {
    await fs.writeFile(path.join(root, 'tokens.json'), JSON.stringify({ credentials, endpoint }), {
      mode: 0o600,
    });
    // The installation covering the owner, else the Just me accounts (the owner's own first), else any installation.
    await fs.writeFile(
      helper,
      `const fs = require('node:fs');
let input = '';
process.stdin.on('data', data => input += data);
process.stdin.on('end', async () => {
  if (process.argv[2] !== 'get') return;
  const fields = Object.fromEntries(input.trim().split('\\n').map(line => { const at = line.indexOf('='); return [line.slice(0, at), line.slice(at + 1)]; }));
  const { credentials, endpoint } = JSON.parse(fs.readFileSync(require('node:path').join(__dirname, 'tokens.json'), 'utf8'));
  const owner = (fields.path || '').split('/')[0].toLowerCase();
  const hosted = credentials.filter(entry => fields.protocol === 'https' && fields.host === entry.host);
  const apps = hosted.filter(entry => !entry.connection);
  const members = hosted.filter(entry => entry.connection);
  const covering = apps.find(entry => entry.owner === owner);
  const ordered = covering
    ? [covering]
    : [...members.filter(entry => entry.owner === owner), ...members.filter(entry => entry.owner !== owner), ...apps.filter(entry => !entry.owner), ...apps.filter(entry => entry.owner)];
  for (const credential of ordered) {
    let password = credential.password;
    if (credential.connection)
      password = await fetch(endpoint.url, { method: 'POST', headers: { authorization: 'Bearer ' + endpoint.token, 'content-type': 'application/json' }, body: JSON.stringify({ connection: credential.connection }), signal: AbortSignal.timeout(10000) })
        .then(response => response.ok ? response.json() : {})
        .then(body => typeof body.token === 'string' && !/[\\r\\n]/.test(body.token) ? body.token : password, () => password);
    if (password) return process.stdout.write('username=' + credential.username + '\\npassword=' + password + '\\n');
  }
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
