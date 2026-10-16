import { withFileLock } from '../utils/fsx';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import type { Connection, Preset } from '../agent/types';
import type { McpServerSpec } from './types';
import { coderHome } from './state';
import { oauthAccessToken, OAuthRevoked, type OAuthSecret } from './oauth';

export class ConnectionRefused extends Error {
  constructor(
    message: string,
    readonly authenticate?: string,
  ) {
    super(message);
  }
}

export function connectionEnvName(name: string): boolean {
  return (
    /^[A-Z][A-Z0-9_]*$/.test(name) &&
    !/^(CODER_|CODEX_|LD_|DYLD_|GIT_|APP_TOKEN(?:_|$))/.test(name) &&
    ![
      'PATH',
      'HOME',
      'SHELL',
      'USER',
      'PWD',
      'TMPDIR',
      'NODE_OPTIONS',
      'NODE_PATH',
      'BASH_ENV',
      'ENV',
      'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'CODEX_AUTH_JSON',
      'CODEX_HOME',
      'CLAUDE_CONFIG_DIR',
      'OPENAI_BASE_URL',
      'ANTHROPIC_BASE_URL',
    ].includes(name)
  );
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

export function injectedConnectionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const values = JSON.parse(env.CODER_CONNECTION_ENV_VALUES ?? '{}') as Record<string, unknown>;

  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string] =>
        connectionEnvName(entry[0]) && typeof entry[1] === 'string',
    ),
  );
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
        ([key]) => !key.startsWith('CODER_CONNECTION_') && key !== 'CODER_MCP_CONNECTION_ENV',
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

export interface ConnectionSecrets {
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
export type SealedCredential = { iv: string; tag: string; ciphertext: string };
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
        connection.access !== 'write' ||
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

async function sseConnection(spec: McpServerSpec, request: typeof fetch, signal: AbortSignal) {
  const response = await request(spec.url!, {
    redirect: 'manual',
    signal,
    headers: { ...spec.headers, accept: 'text/event-stream' },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    checkResponse(response);
    throw new Error('MCP did not answer');
  }
  const reader = response.body.getReader();
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: unknown): void }
  >();
  let opened!: (url: string) => void;
  let failed!: (error: unknown) => void;
  const endpoint = new Promise<string>((resolve, reject) => {
    opened = resolve;
    failed = reject;
  });
  void endpoint.catch(() => {});
  let streamError: unknown;
  const fail = (error: unknown) => {
    streamError = error;
    failed(error);
    for (const waiting of pending.values()) waiting.reject(error);
    pending.clear();
  };
  const abort = () => {
    fail(signal.reason);
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  const pump = (async () => {
    const decoder = new TextDecoder();
    let buffered = '';
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('MCP stream closed');
      buffered = (buffered + decoder.decode(chunk.value, { stream: true })).replaceAll(
        '\r\n',
        '\n',
      );
      let end: number;
      while ((end = buffered.indexOf('\n\n')) >= 0) {
        const lines = buffered.slice(0, end).split('\n');
        buffered = buffered.slice(end + 2);
        const kind = lines
          .find(line => line.startsWith('event:'))
          ?.slice(6)
          .trim();
        const data = lines
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trimStart())
          .join('\n');
        if (kind === 'endpoint') {
          const url = new URL(data, spec.url);
          if (url.origin !== new URL(spec.url!).origin || url.username || url.password)
            throw new Error('MCP endpoint changed origin');
          opened(url.href);
        } else if (data) {
          const message = JSON.parse(data);
          const waiting = pending.get(message.id);
          if (!waiting) continue;
          pending.delete(message.id);
          if (message.error || !message.result) waiting.reject(new Error('Invalid MCP response'));
          else waiting.resolve(message.result);
        }
      }
    }
  })().catch(fail);

  return {
    async rpc(method: string, params?: unknown, id?: number): Promise<any> {
      const url = await endpoint;
      signal.throwIfAborted();
      if (streamError) throw streamError;
      const answer =
        id === undefined
          ? undefined
          : new Promise((resolve, reject) => {
              pending.set(id, { resolve, reject });
            });
      void answer?.catch(() => {});
      try {
        const response = await request(url, {
          method: 'POST',
          redirect: 'manual',
          signal,
          headers: { ...spec.headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            method,
            ...(id === undefined ? {} : { id }),
            ...(params ? { params } : {}),
          }),
        });
        checkResponse(response);
        await response.body?.cancel();

        return await answer;
      } catch (error) {
        if (id !== undefined) {
          pending.get(id)?.reject(error);
          pending.delete(id);
        }
        throw error;
      }
    },
    async close() {
      await reader.cancel().catch(() => {});
      await pump;
      signal.removeEventListener('abort', abort);
    },
  };
}

export async function connectionMcp(
  connection: Connection,
  token: string | undefined,
  request: typeof fetch = fetch,
): Promise<McpServerSpec | undefined> {
  if (!connection.endpoint) throw new Error('Missing endpoint');
  const spec: McpServerSpec = { ...connection.endpoint, name: connection.id };
  if (token) {
    if (spec.command) {
      if (!connection.keyIn || !('env' in connection.keyIn)) throw new Error('Missing key env');
      spec.env = { ...spec.env, [connection.keyIn.env]: token };
      spec.credentialFields = { env: connection.keyIn.env };
    } else {
      const header =
        connection.keyIn && 'header' in connection.keyIn
          ? connection.keyIn.header
          : 'Authorization';
      spec.headers = {
        ...spec.headers,
        [header]: header.toLowerCase() === 'authorization' ? `Bearer ${token}` : token,
      };
      spec.credentialFields = { header };
    }
  }
  if (spec.command) {
    if (connection.access === 'read' && !spec.tools?.length)
      throw new Error('Read-only requires tools');
    return spec;
  }
  const signal = AbortSignal.timeout(5_000);
  let session: string | undefined;
  let version = spec.type === 'sse' ? '2024-11-05' : '2025-11-25';
  const httpRpc = async (method: string, params?: unknown, id?: number) => {
    const response = await request(spec.url!, {
      method: 'POST',
      redirect: 'manual',
      signal,
      headers: {
        ...spec.headers,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': version,
        ...(session ? { 'mcp-session-id': session } : {}),
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
  };
  const legacy = spec.type === 'sse' ? await sseConnection(spec, request, signal) : undefined;
  const rpc = legacy?.rpc ?? httpRpc;
  try {
    const initialized = await rpc(
      'initialize',
      { protocolVersion: version, capabilities: {}, clientInfo: { name: 'coder', version: '1' } },
      1,
    );
    version = initialized.protocolVersion ?? version;
    await rpc('notifications/initialized');
    if (connection.access === 'write') return spec;
    spec.tools = [];
    let cursor: string | undefined;
    let id = 2;
    const cursors = new Set<string>();
    do {
      signal.throwIfAborted();
      const result = await rpc('tools/list', cursor === undefined ? {} : { cursor }, id++);
      if (!Array.isArray(result.tools)) throw new Error('Invalid tools');
      spec.tools.push(
        ...result.tools
          .filter(
            (tool: { name?: string; annotations?: { readOnlyHint?: boolean } }) =>
              typeof tool.name === 'string' &&
              connectionToolName(tool.name) &&
              tool.annotations?.readOnlyHint === true &&
              (!connection.endpoint?.tools?.length ||
                connection.endpoint.tools.includes(tool.name)),
          )
          .map((tool: { name: string }) => tool.name),
      );
      cursor = result.nextCursor;
      if (cursor !== undefined) {
        if (typeof cursor !== 'string' || cursors.has(cursor))
          throw new Error('Invalid tools cursor');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);

    return spec.tools!.length ? spec : undefined;
  } finally {
    if (legacy) await legacy.close();
    if (session)
      await request(spec.url!, {
        method: 'DELETE',
        redirect: 'manual',
        signal,
        headers: { ...spec.headers, 'mcp-session-id': session, 'mcp-protocol-version': version },
      })
        .then(response => response.body?.cancel())
        .catch(() => {});
  }
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
  mode: Preset = 'write',
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
      let connection = local.get(id);
      if (!connection || connection.owner || !['mcp', 'env'].includes(connection.provider)) return;
      if (
        connection.provider === 'env' &&
        (connection.auth !== 'key' ||
          connection.access !== 'write' ||
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
      const credential = async (force = false, refused?: string) =>
        local.withLock(async () => {
          const current = local.get(id);
          if (!current || current.owner || current.broken || current.auth !== connection!.auth)
            throw new Error('Connection changed during resolution');
          connection = current;
          if (!current.secret) throw new Error('Missing credential');
          const secret: { key?: string } & Partial<OAuthSecret> = current.secret.startsWith(
            'plain.',
          )
            ? (JSON.parse(Buffer.from(current.secret.slice(6), 'base64').toString('utf8')) as {
                key?: string;
              } & OAuthSecret)
            : { key: current.secret };
          if (current.auth === 'key') return secret.key;
          return oauthAccessToken({
            secret: secret as OAuthSecret,
            fetch,
            now: Date.now(),
            force: force && secret.accessToken === refused,
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
        }, id);
      try {
        let token = connection.auth === 'none' ? undefined : await credential();
        if (connection.auth !== 'none' && !token) throw new Error('Missing credential');
        let spec: McpServerSpec | undefined;
        try {
          spec = await connectionMcp({ ...connection, access: connection.access ?? mode }, token);
        } catch (error) {
          if (!(error instanceof ConnectionRefused) || connection.auth !== 'oauth') throw error;
          token = await credential(true, token);
          spec = await connectionMcp({ ...connection, access: connection.access ?? mode }, token);
        }
        if (spec) mcp[id] = spec;
      } catch (error) {
        if (connectionRevoked(error))
          await local.withLock(async () => {
            const current = local.get(id);
            if (current && current.secret === connection!.secret)
              local.put({ ...current, broken: { at: Date.now(), reason: 'Needs reconnecting' } });
          });
        warnings.push(connectionWarning(connection!.name, error));
      }
    }),
  );

  return { ...connectionEnvironment(mcp, env), ids, warnings };
}

function transportedConnectionSecrets(): string[] {
  return Object.entries(process.env)
    .filter(([key, value]) => /^CODER_CONNECTION_[A-F0-9]{24}$/.test(key) && value)
    .flatMap(([, value]) => [value!, ...(value!.startsWith('Bearer ') ? [value!.slice(7)] : [])]);
}

export function redactConnectionSecrets(value: unknown, additional: string[] = []): string {
  const named = Object.entries(injectedConnectionEnvironment())
    .filter(([, secret]) => secret.length >= 8)
    .map(([name, secret]) => [secret, `[${name}]`] as const);
  const secrets = [...additional, ...transportedConnectionSecrets()]
    .filter(Boolean)
    .map(secret => [secret, '[REDACTED]'] as const);
  const replacements = [...named, ...secrets].sort(([left], [right]) => right.length - left.length);

  return JSON.stringify(value, (_key, entry) =>
    typeof entry === 'string'
      ? replacements.reduce(
          (text, [secret, replacement]) => text.replaceAll(secret, replacement),
          entry,
        )
      : entry,
  );
}
