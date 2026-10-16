/** The connection API the CLI and the SDK share: each call works on this machine's store (`~/.coder`), or on a Coder server with `server`. */
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

import type { ConnectionInput, ConnectionRow } from '../client/types';
import type { ServerConfig, ServerContext } from '../server/context';
import type { Store } from '../server/store/types';
import { loadConfig, type McpConfigEntry } from './config';
import { CoderError } from './errors';
import { mcpApprove, mcpApproved } from './mcp';
import { connect, serverFor, type ServerOptions } from './remote';

/** Where a connection call runs: this machine's store, or the server named by `server`. */
export type ConnectionOptions = { cwd?: string; workspace?: string } & ServerOptions;

export interface ConnectionAddOptions extends ConnectionOptions {
  /** An API key's environment variable, or where a stdio MCP server reads its key. */
  env?: string;
  /** The request header a remote MCP server reads its key from. */
  header?: string;
  /** A remote MCP server. */
  url?: string;
  transport?: 'http' | 'sse';
  /** A stdio MCP server's command line. */
  command?: string[];
  tools?: string[];
  access?: 'read' | 'write';
  /** Remote authentication is detected when omitted; commands default to none. */
  auth?: 'oauth' | 'key' | 'none';
  key?: string;
  /** Asked when a key is needed and none was given. */
  askKey?: () => Promise<string>;
  /** The credential id an API key connection reads. */
  credential?: string;
  /** Your own connection instead of the workspace's. */
  me?: boolean;
  /** Called with the sign-in page of an OAuth connection; the call then waits until it is connected. */
  onAuthorize?: (url: string) => void;
}

/** An MCP server this repository or one of its agents declares; it needs approval before it runs here. */
export interface DeclaredServer {
  name: string;
  source: string;
  target: string;
  approved: boolean;
}

const invalid = (message: string, hint?: string) =>
  new CoderError('invalid-option', message, hint ? { hint } : {});

const cwdOf = (opts: { cwd?: string }) => (opts.cwd ? path.resolve(opts.cwd) : process.cwd());

const remote = (opts: ConnectionOptions) => opts.server !== undefined;

const api = (opts: ConnectionOptions) =>
  connect({ ...opts, organization: opts.organization ?? opts.workspace });

const client = (opts: ConnectionOptions) => api(opts).connections;

const needsServer = () =>
  invalid(
    'Signing in needs a Coder server.',
    'Repeat with --server <url>, or add it in coder dash',
  );

/** The server's connection functions on this machine's store. */
async function local(cwd: string) {
  const [{ LocalStore }, { INTEGRATIONS }, records] = await Promise.all([
    import('../server/store/local'),
    import('../integrations'),
    import('../server/connections/records'),
  ]);
  const ctx = {
    store: new LocalStore() as Store,
    config: { store: 'memory', runner: 'local' } as ServerConfig,
    integrations: INTEGRATIONS,
    organizationId: 'default',
    local: { cwd, port: 0 },
  } as ServerContext;
  const run = async <T>(work: () => Promise<T>) => {
    try {
      return await work();
    } catch (error) {
      if (error instanceof records.ConnectionError)
        throw new CoderError('invalid-option', error.message, { needs: error.needs });
      throw error;
    }
  };

  return {
    ctx,
    list: () => records.connectionRows(ctx),
    add: (body: ConnectionInput) => run(() => records.addConnection(ctx, body)),
    update: (id: string, body: { key: string }) =>
      run(() => records.changeConnection(ctx, id, body)),
    remove: (id: string) => run(() => records.removeConnection(ctx, id)),
  };
}

async function rows(opts: ConnectionOptions): Promise<ConnectionRow[]> {
  return remote(opts) ? client(opts).list() : (await local(cwdOf(opts))).list();
}

/** Whether a credential the new connection may read holds `name`. */
async function credentialHolds(opts: ConnectionAddOptions, name: string): Promise<boolean> {
  if (remote(opts))
    return (await api(opts).credentials.list()).some(
      row => row.name === name && (opts.me || row.scope === 'workspace'),
    );
  const { parseCredentialId } = await import('../server/settings/credentials');
  const { ctx } = await local(cwdOf(opts));

  return (await ctx.store.list('credential')).some(row => parseCredentialId(row.id).name === name);
}

async function keyOf(opts: ConnectionAddOptions, what: string): Promise<string> {
  const key = opts.key ?? (await opts.askKey?.())?.trim();
  if (!key) throw invalid(`${what} needs a key.`, 'Give it with --key, on stdin or at the prompt');

  return key;
}

/** Wait until a connection's OAuth sign-in has finished. */
async function signedIn(opts: ConnectionAddOptions, id: string, url: string) {
  const authorize = new URL(url, serverFor(opts));
  const attempt = authorize.searchParams.get('state') ?? authorize.searchParams.get('attempt');
  if (!attempt) throw invalid('Sign-in did not start.');
  const authorization = createHash('sha256').update(attempt).digest('hex');
  opts.onAuthorize!(authorize.href);
  const deadline = Date.now() + 600000;
  while (Date.now() < deadline) {
    const row = (await client(opts).list(authorization, id)).find(row => row.id === id);
    if (!row) throw invalid('The connection was removed before sign-in finished.');
    if (row.status === 'ok') return row;
  }
  throw invalid('Sign-in did not finish.', `Try again: coder connection reconnect ${id}`);
}

/** The body `add` posts for a name and its flags. */
async function input(name: string, opts: ConnectionAddOptions): Promise<ConnectionInput> {
  const [command, ...args] = opts.command ?? [];
  const access = opts.access && { access: opts.access };
  const owner = opts.me ? { owner: 'me' as const } : {};
  if (command && opts.url) throw invalid('Use either --url or a command, not both.');
  if (opts.access && !['read', 'write'].includes(opts.access))
    throw invalid('Invalid --access value.', 'Use read or write');

  if (command || opts.url) {
    const auth = opts.auth ?? (opts.key ? 'key' : opts.url ? undefined : 'none');
    if (auth !== undefined && !['oauth', 'key', 'none'].includes(auth))
      throw invalid('Invalid --auth value.', 'Use oauth, key or none');
    if (auth === 'oauth' && !remote(opts)) throw needsServer();
    if (command && auth === 'key' && !opts.env)
      throw invalid('Name the variable the key goes in with --env.');
    const tools = opts.tools?.length ? { tools: opts.tools } : {};

    return {
      name,
      provider: 'mcp',
      ...owner,
      ...access,
      ...(auth ? { auth } : {}),
      endpoint: opts.url
        ? { url: opts.url, ...(opts.transport ? { type: opts.transport } : {}), ...tools }
        : { command, ...(args.length ? { args } : {}), ...tools },
      ...(auth === 'key'
        ? {
            key: await keyOf(opts, name),
            keyIn: opts.url ? { header: opts.header ?? 'Authorization' } : { env: opts.env! },
          }
        : {}),
    };
  }
  if (opts.env) {
    const key =
      opts.key ??
      (opts.credential || (await credentialHolds(opts, opts.env))
        ? undefined
        : (process.env[opts.env] ?? (await keyOf(opts, name))));

    return {
      name,
      provider: 'env',
      ...owner,
      keyIn: { env: opts.env },
      ...(key ? { key } : {}),
      ...(opts.credential ? { credential: opts.credential } : {}),
    };
  }
  const { INTEGRATIONS } = await import('../integrations');
  if (!remote(opts) && !INTEGRATIONS[name]?.auth.user)
    throw invalid(
      'Say what to connect.',
      'Give --env <NAME> for an API key, --url <url> or -- <command> for an MCP server, or a platform name',
    );
  if (!remote(opts)) throw needsServer();

  return { name, provider: name, ...owner };
}

/** The connection `name` means: its id, or your own connection's slug. */
async function find(name: string | undefined, opts: ConnectionOptions): Promise<ConnectionRow> {
  if (!name) throw invalid('Name the connection.', 'See them: coder connection list');
  const all = await rows(opts);
  const row =
    all.find(row => row.id === name) ?? all.find(row => row.mine && row.id.endsWith(`:${name}`));
  if (!row) throw invalid(`No connection "${name}".`, 'See them: coder connection list');

  return row;
}

/** MCP servers the repository config and its agents declare, with this machine's approval. */
async function declared(cwd: string): Promise<DeclaredServer[]> {
  const { loadAgents } = await import('../agent/load');
  const { INTEGRATIONS } = await import('../integrations');
  const row = (name: string, source: string, entry: McpConfigEntry): DeclaredServer => ({
    name,
    source,
    target: entry.connection
      ? `connection ${entry.connection}`
      : (entry.url ?? [entry.command, ...(entry.args ?? [])].join(' ')),
    approved: !!entry.connection || mcpApproved(entry),
  });
  const repository = (entries: Record<string, McpConfigEntry> = {}) =>
    Object.entries(entries).filter(([, entry]) => entry.repository);

  return [
    ...repository(loadConfig(cwd).mcp).map(([name, entry]) => row(name, 'repo', entry)),
    ...(await loadAgents(cwd, INTEGRATIONS, { includeDisabled: true })).flatMap(agent =>
      repository(agent.definition.mcp).map(([name, entry]) =>
        row(name, `agent ${agent.id}`, entry),
      ),
    ),
  ];
}

export const connection = {
  /** Connect a platform account, an API key or an MCP server; an OAuth one waits for sign-in when `onAuthorize` is given. */
  async add(name: string | undefined, opts: ConnectionAddOptions = {}) {
    if (!name) throw invalid('Name the connection.', 'Usage: coder connection add <name> ...');
    const body = await input(name, opts);
    const target = remote(opts) ? client(opts) : await local(cwdOf(opts));
    let added;
    try {
      added = await target.add(body);
    } catch (error) {
      if (
        !(error instanceof CoderError) ||
        error.needs !== 'key' ||
        !body.endpoint?.url ||
        body.auth ||
        body.key ||
        !opts.askKey
      )
        throw error;
      added = await target.add({
        ...body,
        auth: 'key',
        key: await keyOf(opts, name),
        keyIn: { header: opts.header ?? 'Authorization' },
      });
    }

    return added.authorize && opts.onAuthorize ? signedIn(opts, added.id, added.authorize) : added;
  },

  /** Your connections, plus the MCP servers this repository declares and whether each is approved here. */
  async list(opts: ConnectionOptions = {}) {
    return { connections: await rows(opts), declared: await declared(cwdOf(opts)) };
  },

  /** Remove a connection; an API key's credential stays. */
  async remove(name: string | undefined, opts: ConnectionOptions = {}) {
    const row = await find(name, opts);
    if (remote(opts)) await client(opts).remove(row.id);
    else await (await local(cwdOf(opts))).remove(row.id);

    return row;
  },

  /** Give a connection a new key, or sign in again. */
  async reconnect(name: string | undefined, opts: ConnectionAddOptions = {}) {
    const row = await find(name, opts);
    if (row.auth === 'oauth') {
      if (!remote(opts)) throw needsServer();
      const { url } = await client(opts).authorize(row.id);

      return opts.onAuthorize ? signedIn(opts, row.id, url) : { ...row, authorize: url };
    }
    if (row.auth !== 'key') throw invalid(`${row.name} uses no key or sign-in.`);
    const key = await keyOf(opts, row.name);

    return remote(opts)
      ? client(opts).update(row.id, { key })
      : (await local(cwdOf(opts))).update(row.id, { key });
  },

  /** Approve a repository MCP server on this machine; `agent` picks one agent's definition. */
  approve: (name: string | undefined, opts: { cwd?: string; agent?: string } = {}) =>
    mcpApprove(cwdOf(opts), name, opts.agent),
};
