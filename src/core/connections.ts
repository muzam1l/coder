import { withFileLock } from '../utils/fsx';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Connection } from '../agent/types';
import { strictestAccess, type Access } from './config';
import {
  connectionEnvName,
  injectedConnectionEnvironment,
  transportedConnectionSecrets,
} from './connection-env';
import type { McpServerSpec } from './types';
import { coderHome } from './state';
import {
  oauthAccessToken,
  OAuthRevoked,
  refreshFailure,
  tokenFingerprint,
  type OAuthSecret,
} from './oauth';

export class ConnectionRefused extends Error {
  constructor(
    message: string,
    readonly authenticate?: string,
  ) {
    super(message);
  }
}

/** The connection ids both lists allow; absent means every one. */
export function narrowConnections(allowed?: string[], narrowed?: string[]): string[] | undefined {
  if (!narrowed) return allowed;

  return allowed ? narrowed.filter(id => allowed.includes(id)) : narrowed;
}

export function connectionEnvConflicts(connections: Connection[]): Set<string> {
  const seen = new Set<string>();
  const conflicts = new Set<string>();
  for (const connection of connections) {
    if (connection.provider !== 'env' || !connection.keyIn || !('env' in connection.keyIn))
      continue;
    const name = connection.keyIn.env;
    if (seen.has(name)) conflicts.add(name);
    seen.add(name);
  }

  return conflicts;
}

export function connectionEnvironmentKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const entries = Object.entries(injectedConnectionEnvironment(env)).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return entries.length
    ? createHash('sha256').update(JSON.stringify(entries)).digest('hex')
    : undefined;
}

export function engineEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        ([key]) =>
          !key.startsWith('CODER_CONNECTION_') &&
          !/^APP_TOKEN(?:_|$)/.test(key) &&
          ![
            'CODER_MCP_CONNECTION_ENV',
            'CODER_REPLY_URL',
            'CODER_REPLY_TOKEN',
            'CODER_TASK_TOKEN',
          ].includes(key),
      ),
    ),
    ...Object.fromEntries(
      Object.entries(injectedConnectionEnvironment(env)).filter(
        ([name]) => env[name] === undefined,
      ),
    ),
  };
}

export function connectionVariables(servers: Record<string, McpServerSpec>) {
  const env: Record<string, string | null> = {};
  for (const server of Object.values(servers))
    for (const [name, value] of Object.entries(server.env ?? {}))
      env[name] = Object.hasOwn(env, name) ? null : value;

  return env;
}

export const connectionRevoked = (error: unknown) =>
  error instanceof ConnectionRefused || error instanceof OAuthRevoked;

export const connectionWarning = (name: string, error: unknown) =>
  connectionRevoked(error)
    ? `${name} needs reconnecting.`
    : `${name} is temporarily unavailable; skipped for this task.`;

function checkResponse(response: Response): void {
  if (response.status === 401 || response.status === 403)
    throw new ConnectionRefused(
      'MCP credential was refused',
      response.headers.get('www-authenticate') ?? undefined,
    );
  if (!response.ok) throw new Error('MCP did not answer');
}

interface ConnectionSecrets {
  get(id: string): string | undefined;
  put(id: string, value: string): void;
  delete(id: string): void;
}

export const connectionToolName = (name: string) => /^[a-zA-Z0-9_.-]{1,128}$/.test(name);

export function connectionUrlAllowed(url: URL, local: boolean): boolean {
  return (
    !url.username &&
    !url.password &&
    (local ||
      !/^(?:(?:[a-z0-9_-]+\.)*localhost\.?|127\.\d+\.\d+\.\d+|\[::1\]|\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\])$/i.test(
        url.hostname,
      )) &&
    (url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
  );
}

function read<T>(file: string, empty: T): T {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw error;
  }
}

function write(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** A stored engine credential: its sealed `env`, beside public fields such as `engine` and `owner`. */
type SealedCredential = { iv: string; tag: string; ciphertext: string };
type CredentialRecord = Record<string, unknown>;

export class LocalConnections {
  private readonly secrets: ConnectionSecrets;
  private readonly file: string;
  private readonly credentialFile: string;
  private readonly lock: string;

  constructor(home = coderHome(), platform = process.platform, secrets?: ConnectionSecrets) {
    this.file = path.join(home, 'connections.json');
    this.credentialFile = path.join(home, 'local-credentials.json');
    this.lock = path.join(home, 'state', 'global', 'connections.lock');
    const credentials = path.join(home, 'credentials.json');
    this.secrets =
      secrets ??
      (platform === 'darwin'
        ? {
            get(id) {
              try {
                return execFileSync(
                  'security',
                  ['find-generic-password', '-s', 'coder', '-a', id, '-w'],
                  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
                ).trimEnd();
              } catch (error) {
                if ((error as { status?: number }).status === 44) return undefined;
                throw new Error('Could not read the connection keychain');
              }
            },
            put(id, value) {
              try {
                const quote = (text: string) =>
                  '"' + text.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
                if (/[\r\n\0]/.test(id + value)) throw new Error('Invalid keychain value');
                execFileSync('security', ['-i'], {
                  input: `add-generic-password -U -s coder -a ${quote(id)} -w ${quote(value)}\n`,
                  stdio: ['pipe', 'pipe', 'pipe'],
                });
              } catch {
                throw new Error('Could not save the connection keychain');
              }
            },
            delete(id) {
              try {
                execFileSync('security', ['delete-generic-password', '-s', 'coder', '-a', id], {
                  stdio: ['ignore', 'pipe', 'pipe'],
                });
              } catch (error) {
                if ((error as { status?: number }).status !== 44)
                  throw new Error('Could not remove the connection keychain');
              }
            },
          }
        : {
            get: id => read<Record<string, string>>(credentials, {})[id],
            put(id, value) {
              write(credentials, { ...read<Record<string, string>>(credentials, {}), [id]: value });
            },
            delete(id) {
              const values = read<Record<string, string>>(credentials, {});
              delete values[id];
              write(credentials, values);
            },
          });
  }

  async withLock<T>(work: () => Promise<T>, id?: string): Promise<T> {
    const lock =
      id === undefined
        ? this.lock
        : `${this.lock}-${createHash('sha256').update(id).digest('hex')}`;
    return withFileLock(lock, work);
  }

  list(): Connection[] {
    return Object.values(read<Record<string, Connection>>(this.file, {}));
  }

  get(id: string): Connection | undefined {
    const connection = this.list().find(row => row.id === id);
    if (!connection) return undefined;
    let secret: string | undefined;
    try {
      secret = connection.auth === 'none' ? undefined : this.secrets.get(id);
    } catch {
      return { ...connection, broken: { at: Date.now(), reason: 'Needs reconnecting' } };
    }

    return { ...connection, ...(secret ? { secret } : {}) };
  }

  put(connection: Connection): void {
    if (
      connection.provider === 'env' &&
      (connection.auth !== 'key' ||
        connection.access !== 'auto' ||
        connection.endpoint ||
        connection.secret ||
        !connection.credential ||
        !connection.keyIn ||
        !('env' in connection.keyIn) ||
        !connectionEnvName(connection.keyIn.env))
    )
      throw new Error('Invalid environment connection');
    const { secret, ...record } = connection;
    const rows = read<Record<string, Connection>>(this.file, {});
    if (secret) this.secrets.put(connection.id, secret);
    else if (rows[connection.id]?.auth !== 'none' && rows[connection.id])
      this.secrets.delete(connection.id);
    rows[connection.id] = record;
    write(this.file, rows);
  }

  delete(id: string): void {
    const rows = read<Record<string, Connection>>(this.file, {});
    const credential = rows[id] && rows[id].auth !== 'none';
    delete rows[id];
    write(this.file, rows);
    if (credential) this.secrets.delete(id);
  }

  /** Engine credentials a local store keeps: rows in `local-credentials.json`, sealed values beside the connection secrets. */
  credentials(): Array<{ id: string; value: SealedCredential }> {
    return Object.entries(read<Record<string, CredentialRecord>>(this.credentialFile, {})).flatMap(
      ([id, record]) => {
        const sealed = this.secrets.get(`credential/${id}`);
        return sealed ? [{ id, value: { ...record, ...JSON.parse(sealed) } }] : [];
      },
    );
  }

  credential(id: string): SealedCredential | undefined {
    const record = read<Record<string, CredentialRecord>>(this.credentialFile, {})[id];
    if (!record) return undefined;
    const sealed = this.secrets.get(`credential/${id}`);

    return sealed ? { ...record, ...JSON.parse(sealed) } : undefined;
  }

  putCredential(id: string, value: SealedCredential): void {
    const { iv, tag, ciphertext, ...record } = value;
    this.secrets.put(`credential/${id}`, JSON.stringify({ iv, tag, ciphertext }));
    write(this.credentialFile, {
      ...read<Record<string, CredentialRecord>>(this.credentialFile, {}),
      [id]: record,
    });
  }

  deleteCredential(id: string): void {
    const rows = read<Record<string, CredentialRecord>>(this.credentialFile, {});
    delete rows[id];
    write(this.credentialFile, rows);
    this.secrets.delete(`credential/${id}`);
  }
}

/** One tool as a server lists it. */
export interface McpToolInfo {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: { readOnlyHint?: boolean };
}

/** MCP `Implementation`: what a server says about itself. */
export interface McpServerInfo {
  name?: string;
  title?: string;
  version?: string;
  description?: string;
  websiteUrl?: string;
}

export interface McpClient {
  /** The server's own instructions and info, from `initialize` or, on 2026-07-28 servers, `server/discover`. */
  initialize(): Promise<{ instructions?: string; serverInfo?: McpServerInfo }>;
  /** Every tool, page by page; initializes first when needed. */
  tools(): Promise<McpToolInfo[]>;
  /** One tool's result as the server sends it, unbounded by `startup`. */
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

/** The stateless MCP revision, without `initialize`. */
const MODERN_MCP = '2026-07-28';

/** A header value as MCP 2026-07-28 carries it: plain when header-safe, else base64. */
const mcpHeader = (value: string) =>
  /^[\x21-\x7E]([\x20-\x7E]*[\x21-\x7E])?$/.test(value)
    ? value
    : `=?base64?${Buffer.from(value).toString('base64')}?=`;

/** A client for one server spec, stdio or streamable HTTP. `startup` bounds connecting, initialize and the tool list only; the session then lives until `close`. */
export async function mcpClient(
  spec: McpServerSpec,
  request: typeof fetch = fetch,
  startup?: AbortSignal,
): Promise<McpClient> {
  let version = '2025-11-25';
  const clientInfo = { name: 'coder', version: '1' };
  const within = <T>(work: Promise<T>): Promise<T> =>
    startup
      ? Promise.race([
          work,
          new Promise<never>((_, reject) => {
            const abort = () => reject(startup.reason ?? new Error('MCP startup timed out'));
            if (startup.aborted) abort();
            startup.addEventListener('abort', abort, { once: true });
          }),
        ])
      : work;
  const base = await within(spec.command ? stdioRpc(spec) : httpRpc(spec, request, () => version));
  let next = 1;
  const call = (method: string, params?: object, signal?: AbortSignal) =>
    base.rpc(
      method,
      version === MODERN_MCP
        ? {
            ...params,
            _meta: {
              'io.modelcontextprotocol/protocolVersion': version,
              'io.modelcontextprotocol/clientInfo': clientInfo,
              'io.modelcontextprotocol/clientCapabilities': {},
            },
          }
        : params,
      next++,
      signal,
    );
  let initialized: Promise<{ instructions?: string; serverInfo?: McpServerInfo }> | undefined;
  const client: McpClient = {
    initialize: () =>
      (initialized ??= within(
        call(
          'initialize',
          { protocolVersion: version, capabilities: {}, clientInfo },
          startup,
        ).then(
          async result => {
            version = result?.protocolVersion ?? version;
            await base.rpc('notifications/initialized');

            return { instructions: result?.instructions, serverInfo: result?.serverInfo };
          },
          async error => {
            if (error instanceof ConnectionRefused) throw error;
            // A server of 2026-07-28 alone has no initialize; it describes itself through server/discover.
            version = MODERN_MCP;
            const result = await call('server/discover', {}, startup).catch(() => {
              throw error;
            });
            if (!result?.supportedVersions?.includes(MODERN_MCP)) throw error;

            return { instructions: result.instructions, serverInfo: result.serverInfo };
          },
        ),
      )),
    async tools() {
      await client.initialize();
      const tools: McpToolInfo[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await within(
          call('tools/list', cursor === undefined ? {} : { cursor }, startup),
        );
        if (!Array.isArray(result?.tools)) throw new Error('Invalid tools');
        tools.push(...result.tools.filter((tool: McpToolInfo) => typeof tool.name === 'string'));
        cursor = result.nextCursor;
        if (cursor !== undefined) {
          if (typeof cursor !== 'string' || cursors.has(cursor))
            throw new Error('Invalid tools cursor');
          cursors.add(cursor);
        }
      } while (cursor !== undefined);

      return tools;
    },
    async call(name, args) {
      await client.initialize();

      return call('tools/call', { name, arguments: args });
    },
    close: () => base.close(),
  };

  return client;
}

async function stdioRpc(spec: McpServerSpec) {
  const { spawn } = await import('node:child_process');
  const readline = await import('node:readline');
  const child = spawn(spec.command!, spec.args ?? [], {
    env: { ...engineEnvironment(process.env), ...spec.env },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  let exited: Error | undefined;
  const fail = (error: Error) => {
    exited = error;
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  child.once('error', error =>
    fail(new Error(`MCP server ${spec.name} could not start: ${error.message}`)),
  );
  child.once('close', code =>
    fail(new Error(`MCP server ${spec.name} exited with status ${code}`)),
  );
  child.stdin.on('error', fail);
  readline.createInterface({ input: child.stdout, terminal: false }).on('line', line => {
    let message: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const waiting = message.id === undefined ? undefined : pending.get(message.id);
    if (!waiting) return;
    pending.delete(message.id!);
    if (message.error) waiting.reject(new Error(message.error.message ?? 'MCP error'));
    else waiting.resolve(message.result);
  });

  return {
    rpc(method: string, params?: unknown, id?: number, _signal?: AbortSignal): Promise<any> {
      if (exited) return Promise.reject(exited);
      const answer =
        id === undefined
          ? Promise.resolve(undefined)
          : new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', method, ...(id === undefined ? {} : { id }), ...(params ? { params } : {}) })}\n`,
      );

      return answer;
    },
    async close() {
      child.stdin.end();
      child.kill();
    },
  };
}

async function httpRpc(spec: McpServerSpec, request: typeof fetch, version: () => string) {
  let session: string | undefined;
  const headers = () => ({
    ...spec.headers,
    'mcp-protocol-version': version(),
    ...(session ? { 'mcp-session-id': session } : {}),
  });

  return {
    async rpc(method: string, params?: unknown, id?: number, signal?: AbortSignal) {
      const response = await request(spec.url!, {
        method: 'POST',
        redirect: 'manual',
        ...(signal ? { signal } : {}),
        headers: {
          ...headers(),
          ...(version() === MODERN_MCP
            ? {
                'mcp-method': method,
                ...(method === 'tools/call'
                  ? { 'mcp-name': mcpHeader(String((params as { name?: unknown }).name)) }
                  : {}),
              }
            : {}),
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          ...(id === undefined ? {} : { id }),
          ...(params ? { params } : {}),
        }),
      });
      checkResponse(response);
      session = response.headers.get('mcp-session-id') ?? session;
      if (id === undefined) {
        await response.body?.cancel();
        return undefined;
      }
      const raw = await response.text();
      const messages = response.headers.get('content-type')?.includes('text/event-stream')
        ? raw.split(/\r?\n\r?\n/).flatMap(event => {
            const data = event
              .split(/\r?\n/)
              .filter(line => line.startsWith('data:'))
              .map(line => line.slice(5).trimStart())
              .join('\n');
            return data ? [JSON.parse(data)] : [];
          })
        : [JSON.parse(raw)];
      const message = messages.find(message => message.id === id);
      if (!message?.result || message.error) throw new Error('Invalid MCP response');

      return message.result;
    },
    async close() {
      if (!session) return;
      await request(spec.url!, { method: 'DELETE', redirect: 'manual', headers: headers() })
        .then(response => response.body?.cancel())
        .catch(() => {});
    },
  };
}

/** Where a connection's credential goes in its server spec. */
export function credentialField(connection: Connection): { env?: string; header?: string } {
  if (connection.endpoint?.command) {
    if (!connection.keyIn || !('env' in connection.keyIn)) throw new Error('Missing key env');
    return { env: connection.keyIn.env };
  }

  return {
    header:
      connection.keyIn && 'header' in connection.keyIn ? connection.keyIn.header : 'Authorization',
  };
}

/** A server spec with `token` in `field`. */
export function withCredential(
  spec: McpServerSpec,
  field: { env?: string; header?: string },
  token: string,
): McpServerSpec {
  if (field.env)
    return { ...spec, env: { ...spec.env, [field.env]: token }, credentialFields: field };
  const header = field.header!;

  return {
    ...spec,
    headers: {
      ...spec.headers,
      [header]: header.toLowerCase() === 'authorization' ? `Bearer ${token}` : token,
    },
    credentialFields: field,
  };
}

/** A connection server's one line: its name, what it connects and the account it acts as. */
export function connectionDescription(
  connection: Pick<Connection, 'name' | 'endpoint' | 'account' | 'login'>,
): string {
  const { url, command } = connection.endpoint ?? {};
  const account = connection.login ?? connection.account;

  return [
    connection.name,
    url && URL.canParse(url) ? new URL(url).host : command,
    account && `as ${account}`,
  ]
    .filter(Boolean)
    .join(', ');
}

/** A connection's server spec, built without contacting it: a Read-only HTTP server is marked, and its tools are checked on first use. */
/** A connection's tool server name: its id, or `<name>-user` for a member's own, where a platform's name is its integration id. */
export const connectionServerName = (connection: Pick<Connection, 'id' | 'provider' | 'owner'>) =>
  !connection.owner
    ? connection.id
    : `${connection.provider === 'mcp' ? connection.id.slice(connection.owner.length + 1) : connection.provider}-user`;

export function connectionMcp(connection: Connection, token: string | undefined): McpServerSpec {
  if (!connection.endpoint) throw new Error('Missing endpoint');
  let spec: McpServerSpec = { ...connection.endpoint, name: connectionServerName(connection) };
  if (token) spec = withCredential(spec, credentialField(connection), token);
  if (spec.command) {
    if (connection.access === 'read-only' && !spec.tools?.length)
      throw new Error('Read-only requires tools');
    return spec;
  }

  return connection.access === 'read-only' ? { ...spec, readOnly: true } : spec;
}

/** Keep resolved credentials in the worker's environment, with only placeholders in task records. */
export function connectionEnvironment(
  servers: Record<string, McpServerSpec>,
  values: Record<string, string> = {},
) {
  const credentials = new Set(transportedConnectionSecrets());
  const env: Record<string, string> = Object.keys(values).length
    ? { CODER_CONNECTION_ENV_VALUES: JSON.stringify(values) }
    : {};
  const mcp = Object.fromEntries(
    Object.entries(servers).map(([id, spec]) => {
      const { credentialFields, ...publicSpec } = spec;
      const fields = (kind: 'env' | 'headers') =>
        spec[kind] &&
        Object.fromEntries(
          Object.entries(spec[kind]!).map(([key, value]) => {
            const credential =
              key === credentialFields?.[kind === 'env' ? 'env' : 'header'] ||
              credentials.has(value);
            if (!credential) return [key, value];
            const name = `CODER_CONNECTION_${createHash('sha256').update(`${id}:${kind}:${key}`).digest('hex').slice(0, 24).toUpperCase()}`;
            env[name] = value;
            return [key, '${' + name + '}'];
          }),
        );
      return [
        id,
        {
          ...publicSpec,
          ...(spec.env ? { env: fields('env') } : {}),
          ...(spec.headers ? { headers: fields('headers') } : {}),
        },
      ];
    }),
  );

  return { mcp, env };
}

export async function localConnections(
  allowed?: string[],
  granted?: string[],
  local = new LocalConnections(),
  access: Access = 'auto',
) {
  const ids =
    granted ??
    local
      .list()
      .filter(row => !row.owner && (allowed === undefined || allowed.includes(row.id)))
      .map(row => row.id);
  const mcp: Record<string, McpServerSpec> = {};
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const conflicts = connectionEnvConflicts(
    local.list().filter(connection => ids.includes(connection.id) && !connection.owner),
  );
  await Promise.all(
    ids.map(async id => {
      const connection = local.get(id);
      if (!connection || connection.owner || !['mcp', 'env'].includes(connection.provider)) return;
      if (
        connection.provider === 'env' &&
        (connection.auth !== 'key' ||
          connection.access !== 'auto' ||
          connection.endpoint ||
          !connection.credential ||
          !connection.keyIn ||
          !('env' in connection.keyIn) ||
          !connectionEnvName(connection.keyIn.env) ||
          conflicts.has(connection.keyIn.env) ||
          process.env[connection.keyIn.env] !== undefined)
      ) {
        warnings.push(
          connectionWarning(connection.name, new Error('Invalid environment connection')),
        );
        return;
      }
      const level = strictestAccess(connection.access, access);
      if (connection.auth === 'oauth') {
        // Its token loads on first use, through the tool search.
        mcp[id] = {
          ...connectionMcp({ ...connection, access: level }, undefined),
          connection: id,
          credentialOnUse: credentialField(connection),
          description: connectionDescription(connection),
          access: level,
        };
        return;
      }
      if (connection.broken) {
        warnings.push(`${connection.name} needs reconnecting.`);
        return;
      }
      if (connection.provider === 'env') {
        const name = (connection.keyIn as { env: string }).env;
        try {
          const stored = local.credential(connection.credential!);
          const key =
            stored?.iv === 'plain'
              ? (
                  JSON.parse(Buffer.from(stored.ciphertext, 'base64').toString('utf8')) as {
                    env: Record<string, string>;
                  }
                ).env[name]
              : undefined;
          if (!key) throw new Error('Missing credential');
          env[name] = key;
        } catch (error) {
          warnings.push(connectionWarning(connection.name, error));
        }
        return;
      }
      try {
        const token =
          connection.auth === 'none' ? undefined : (await localCredential(local, id, 'key')).token;
        if (connection.auth !== 'none' && !token) throw new Error('Missing credential');
        const spec = connectionMcp({ ...connection, access: level }, token);
        mcp[id] = { ...spec, description: connectionDescription(connection), access: level };
      } catch (error) {
        warnings.push(connectionWarning(connection.name, error));
      }
    }),
  );

  return { ...connectionEnvironment(mcp, env), ids, warnings };
}

/** A local connection's credential; an OAuth token that is still the `refused` one, by its fingerprint, refreshes before its expiry. */
function localCredential(
  local: LocalConnections,
  id: string,
  auth: Connection['auth'],
  refused?: string,
): Promise<{ token: string | undefined; current: Connection }> {
  return local.withLock(async () => {
    const current = local.get(id);
    if (!current || current.owner || current.broken || current.auth !== auth)
      throw new Error('Connection changed during resolution');
    if (!current.secret) throw new Error('Missing credential');
    const secret: { key?: string } & Partial<OAuthSecret> = current.secret.startsWith('plain.')
      ? (JSON.parse(Buffer.from(current.secret.slice(6), 'base64').toString('utf8')) as {
          key?: string;
        } & OAuthSecret)
      : { key: current.secret };
    if (current.auth === 'key') return { token: secret.key, current };
    const token = await oauthAccessToken({
      secret: secret as OAuthSecret,
      fetch,
      now: Date.now(),
      force: !!secret.accessToken && tokenFingerprint(secret.accessToken) === refused,
      save: async value =>
        local.withLock(async () => {
          const latest = local.get(id);
          if (
            !latest ||
            latest.secret !== current.secret ||
            latest.auth !== current.auth ||
            latest.owner !== current.owner
          )
            throw new Error('Connection changed during refresh');
          current.secret = `plain.${Buffer.from(JSON.stringify(value)).toString('base64')}`;
          local.put(current);
        }),
    });

    return { token, current };
  }, id);
}

/** A local OAuth connection's token on first use, refreshed then; `refused` names by fingerprint a token its server refused. None when it needs reconnecting, which a refused refresh marks. */
export async function localConnectionToken(
  id: string,
  refused?: string,
  local = new LocalConnections(),
): Promise<string | undefined> {
  const connection = local.get(id);
  if (connection?.auth !== 'oauth' || connection.broken || !connection.secret) return undefined;
  try {
    return (await localCredential(local, id, 'oauth', refused)).token;
  } catch (error) {
    console.error('coder: token refresh failed', refreshFailure({ connection: id }, error));
    if (!connectionRevoked(error)) throw error;
    await local.withLock(async () => {
      const current = local.get(id);
      if (current && current.secret === connection.secret)
        local.put({ ...current, broken: { at: Date.now(), reason: 'Needs reconnecting' } });
    });
    return undefined;
  }
}
