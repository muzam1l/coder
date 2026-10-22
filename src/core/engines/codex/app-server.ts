/**
 * Forked from the codex plugin's app-server client. Differences:
 * - server-initiated requests (approvals) can be answered via setServerRequestHandler
 * - coder-specific broker endpoint env + state locations
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import readline from 'node:readline';
import { createHash } from 'node:crypto';

import { ensureBrokerSession, loadBrokerSession, parseBrokerEndpoint } from '../../broker/session';
import { processTiming } from '../../../utils/process';
import { readVersion } from '../../runtime';
import { connectionEnvironmentKey, engineEnvironment } from '../../connections';
import { startChatBridge, type ChatBridge } from './chat-bridge';
import type { AppServerClient } from './turn';

export const BROKER_ENDPOINT_ENV = 'CODER_APP_SERVER_ENDPOINT';
export const BROKER_BUSY_RPC_CODE = -32001;
// Broker-only frames: a one-line notice for the task log, the shared
// app-server dying under a client, and a client asking for a fresh app-server.
export const BROKER_NOTICE_METHOD = 'coder/notice';
export const BROKER_APP_SERVER_EXITED_METHOD = 'coder/appServerExited';
export const BROKER_RECYCLE_METHOD = 'broker/recycle';

function defaultClientInfo() {
  return { title: 'Coder', name: 'coder', version: readVersion() };
}

const DEFAULT_CAPABILITIES = {
  // thread/backgroundTerminals/clean, which task stop needs, is experimental.
  experimentalApi: true,
  requestAttestation: false,
  optOutNotificationMethods: [
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
  ],
};

export type ProtocolError = Error & { data?: unknown; rpcCode?: number };
type NotificationHandler = (message: any) => void;
type ServerRequestHandler = (method: string, params: any) => Promise<any> | any;
type NoticeHandler = (message: string) => void;

interface ClientOptions {
  env?: NodeJS.ProcessEnv;
  networkAccess?: boolean;
  nativeMcp?: boolean;
  brokerEndpoint?: string | null;
  disableBroker?: boolean;
  /** A bridge the caller owns (the broker's); otherwise a private app-server starts its own. */
  bridgeUrl?: string;
  reuseExistingBroker?: boolean;
}

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
  method: string;
}

function buildJsonRpcError(code: number, message: string, data?: unknown) {
  return data === undefined ? { code, message } : { code, message, data };
}

function createProtocolError(message: string, data?: any): ProtocolError {
  const error = new Error(message) as ProtocolError;
  error.data = data;
  if (data?.code !== undefined) {
    error.rpcCode = data.code;
  }
  return error;
}

export class AppServerClientBase {
  cwd: string;
  options: ClientOptions;
  pending: Map<number, PendingRequest>;
  nextId: number;
  stderr: string;
  closed: boolean;
  exitError: Error | null;
  notificationHandler: NotificationHandler | null;
  serverRequestHandler: ServerRequestHandler | null;
  noticeHandler: NoticeHandler | null;
  lineBuffer: string;
  transport: string;
  /** The custom-model bridge that lives as long as this client's app-server. */
  bridgeUrl?: string;
  exitPromise: Promise<void>;
  exitResolved?: boolean;
  resolveExit!: (value?: void) => void;
  // Declared as an assignable property (not a method) so the broker can
  // replace it with its forwarding implementation.
  handleServerRequest: (message: any) => void;

  constructor(cwd: string, options: ClientOptions = {}) {
    this.cwd = cwd;
    this.options = options;
    this.pending = new Map();
    this.nextId = 1;
    this.stderr = '';
    this.closed = false;
    this.exitError = null;
    this.notificationHandler = null;
    this.serverRequestHandler = null;
    this.noticeHandler = null;
    this.lineBuffer = '';
    this.transport = 'unknown';
    this.handleServerRequest = message => this.defaultHandleServerRequest(message);

    this.exitPromise = new Promise(resolve => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler: NotificationHandler | null) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler: ServerRequestHandler | null) {
    this.serverRequestHandler = handler;
  }

  setNoticeHandler(handler: NoticeHandler | null) {
    this.noticeHandler = handler;
  }

  request<T = any>(method: string, params?: unknown): Promise<T> {
    if (this.closed) {
      throw new Error('codex app-server client is closed.');
    }
    // A dead app-server never answers; fail now instead of hanging.
    if (this.exitResolved) {
      return Promise.reject(this.exitError ?? new Error('codex app-server connection closed.'));
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method: string, params: unknown = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk: string | Buffer) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  }

  handleLine(line: string) {
    if (!line.trim()) {
      return;
    }

    let message: any;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(
        createProtocolError(
          `Failed to parse codex app-server JSONL: ${error instanceof Error ? error.message : String(error)}`,
          { line },
        ),
      );
      return;
    }

    if (message.id !== undefined && message.method) {
      this.handleServerRequest(message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(
          createProtocolError(
            message.error.message ?? `codex app-server ${pending.method} failed.`,
            message.error,
          ),
        );
      } else {
        pending.resolve(message.result ?? {});
      }
      return;
    }

    if (message.method === BROKER_NOTICE_METHOD) {
      this.noticeHandler?.(String(message.params?.message ?? ''));
      return;
    }

    if (message.method === BROKER_APP_SERVER_EXITED_METHOD) {
      this.handleExit(
        createProtocolError(String(message.params?.message ?? 'codex app-server exited.')),
      );
      return;
    }

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  defaultHandleServerRequest(message: any) {
    const handler = this.serverRequestHandler;
    if (!handler) {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`),
      });
      return;
    }

    Promise.resolve()
      .then(() => handler(message.method, message.params ?? {}))
      .then(result => {
        this.sendMessage({ id: message.id, result: result ?? {} });
      })
      .catch(error => {
        this.sendMessage({
          id: message.id,
          error: buildJsonRpcError(-32000, error instanceof Error ? error.message : String(error)),
        });
      });
  }

  handleExit(error: Error | null) {
    if (this.exitResolved) {
      return;
    }

    this.exitResolved = true;
    this.exitError = error ?? null;

    for (const pending of this.pending.values()) {
      pending.reject(this.exitError ?? new Error('codex app-server connection closed.'));
    }
    this.pending.clear();
    this.resolveExit(undefined);
  }

  sendMessage(_message: any): void {
    throw new Error('sendMessage must be implemented by subclasses.');
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  proc?: import('node:child_process').ChildProcess;
  readline?: import('node:readline').Interface;
  bridge?: ChatBridge;

  constructor(cwd: string, options: ClientOptions = {}) {
    super(cwd, options);
    this.transport = 'direct';
    this.exitPromise = this.exitPromise.then(() => this.bridge?.close());
  }

  async initialize() {
    const networkAccess = this.options.networkAccess ?? false;
    this.bridge = this.options.bridgeUrl ? undefined : await startChatBridge();
    this.bridgeUrl = this.options.bridgeUrl ?? this.bridge!.url;
    processTiming('codex.spawn');
    this.proc = spawn('codex', codexAppServerArgs(networkAccess, this.options.nativeMcp), {
      cwd: this.cwd,
      env: engineEnvironment(this.options.env ?? process.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? process.env.SHELL || true : false,
      windowsHide: true,
    });

    const stdout = this.proc.stdout;
    const stderr = this.proc.stderr;
    if (!stdout || !stderr) {
      throw new Error('codex app-server did not expose stdio streams.');
    }
    stdout.setEncoding('utf8');
    stderr.setEncoding('utf8');

    stderr.on('data', chunk => {
      this.stderr += chunk;
    });

    this.proc.on('error', error => {
      this.handleExit(error);
    });
    // Writes racing a dying process fail with EPIPE; the exit handler reports it.
    this.proc.stdin?.on('error', () => {});

    this.proc.on('exit', (code, signal) => {
      const stderr = this.stderr.trim();
      const detail =
        code === 0
          ? null
          : createProtocolError(
              `codex app-server exited unexpectedly (${signal ? `signal ${signal}` : `exit ${code}`}).${stderr ? `\n${stderr}` : ''}`,
            );
      this.handleExit(detail);
    });

    this.readline = readline.createInterface({ input: stdout });
    this.readline.on('line', line => {
      this.handleLine(line);
    });

    await this.request('initialize', {
      clientInfo: defaultClientInfo(),
      capabilities: DEFAULT_CAPABILITIES,
    });
    this.notify('initialized', {});
    processTiming('codex.initialized');
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;

    if (this.readline) {
      this.readline.close();
    }

    if (this.proc && !this.proc.killed) {
      this.proc.stdin?.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          if (process.platform === 'win32') {
            try {
              spawnSync('taskkill', ['/PID', String(this.proc.pid), '/T', '/F'], {
                stdio: 'ignore',
              });
            } catch {
              // Best-effort cleanup inside an unref'd timer.
            }
          } else {
            this.proc.kill('SIGTERM');
          }
        }
      }, 50).unref?.();
    }

    await this.exitPromise;
  }

  sendMessage(message: any) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error('codex app-server stdin is not available.');
    }
    stdin.write(line);
  }
}

/** Fixed process arguments; thread-scoped config, including MCP secrets, travels over JSON-RPC. */
export function codexAppServerArgs(networkAccess: boolean, nativeMcp = false): string[] {
  return [
    '-c',
    `sandbox_workspace_write.network_access=${networkAccess}`,
    'app-server',
    ...(!nativeMcp ? ['--disable', 'plugins', '--disable', 'apps'] : []),
  ];
}

class BrokerCodexAppServerClient extends AppServerClientBase {
  endpoint?: string | null;
  socket?: import('node:net').Socket;

  constructor(cwd: string, options: ClientOptions = {}) {
    super(cwd, options);
    this.transport = 'broker';
    this.endpoint = options.brokerEndpoint;
  }

  async initialize() {
    await new Promise((resolve, reject) => {
      const target = parseBrokerEndpoint(this.endpoint);
      this.socket = net.createConnection({ path: target.path });
      this.socket.setEncoding('utf8');
      this.socket.on('connect', resolve);
      this.socket.on('data', chunk => {
        this.handleChunk(chunk);
      });
      this.socket.on('error', error => {
        if (!this.exitResolved) {
          reject(error);
        }
        this.handleExit(error);
      });
      this.socket.on('close', () => {
        this.handleExit(this.exitError);
      });
    });

    const initialized = await this.request('initialize', {
      clientInfo: defaultClientInfo(),
      capabilities: DEFAULT_CAPABILITIES,
    });
    this.bridgeUrl = initialized.bridgeUrl;
    this.notify('initialized', {});
    processTiming('codex.initialized');
  }

  async close() {
    if (this.closed) {
      await this.exitPromise;
      return;
    }

    this.closed = true;
    if (this.socket) {
      this.socket.end();
    }
    await this.exitPromise;
  }

  sendMessage(message: any) {
    const line = `${JSON.stringify(message)}\n`;
    const socket = this.socket;
    if (!socket) {
      throw new Error('codex app-server broker connection is not connected.');
    }
    socket.write(line);
  }
}

export class CodexAppServerClient {
  static async connect(cwd: string, options: ClientOptions = {}) {
    const env = options.env ?? process.env;
    const connectionKey = connectionEnvironmentKey(env);
    options = { ...options, env: engineEnvironment(env) };
    const networkAccess = options.networkAccess ?? false;
    let brokerEndpoint = null;
    if (!options.disableBroker && !options.nativeMcp) {
      brokerEndpoint = connectionKey
        ? null
        : (options.brokerEndpoint ??
          options.env?.[BROKER_ENDPOINT_ENV] ??
          process.env[BROKER_ENDPOINT_ENV] ??
          null);
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd, networkAccess, connectionKey)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, {
          env,
          networkAccess,
          connectionKey,
        });
        brokerEndpoint = brokerSession?.endpoint ?? null;
      }
    }
    const client = brokerEndpoint
      ? new BrokerCodexAppServerClient(cwd, { ...options, brokerEndpoint })
      : new SpawnedCodexAppServerClient(cwd, options);
    await client.initialize();
    return client;
  }
}

export async function withAppServer<T>(
  cwd: string,
  fn: (client: AppServerClient) => Promise<T>,
  internals: {
    connect?: typeof CodexAppServerClient.connect;
    networkAccess?: boolean;
    nativeMcp?: boolean;
    disableBroker?: boolean;
  } = {},
): Promise<T> {
  const connect = internals.connect ?? CodexAppServerClient.connect;
  const clientOptions = {
    ...(internals.networkAccess === undefined ? {} : { networkAccess: internals.networkAccess }),
    nativeMcp: internals.nativeMcp ?? false,
    disableBroker: internals.disableBroker ?? false,
  };
  let client: AppServerClient | null = null;
  try {
    client = await connect(cwd, clientOptions);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const err = error as ProtocolError & NodeJS.ErrnoException;
    const brokerRequested =
      client?.transport === 'broker' || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === 'broker' && err?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED'));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await connect(cwd, { ...clientOptions, disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

export async function recycleAppServer(client: AppServerClient) {
  if (client.transport === 'broker') {
    await client.request(BROKER_RECYCLE_METHOD, {}).catch(() => {});
  }
}

// Every refresh failure codex reports starts this way; after an account switch
// a long-lived app-server still holds the old tokens and hits it on every turn.
const STALE_AUTH_PATTERN = /access token could not be refreshed/i;
const UNSUPPORTED_MODEL_PATTERN = /model is not supported|Codex cannot run model/i;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function isStaleAuthError(message: string | null | undefined): boolean {
  return STALE_AUTH_PATTERN.test(message ?? '');
}

export function isUnsupportedModelError(message: string | null | undefined): boolean {
  return UNSUPPORTED_MODEL_PATTERN.test(message ?? '');
}

/** A clear replacement for an "unsupported model" 400, or null for any other error. */
export function describeUnsupportedModel(
  message: string | null | undefined,
  model?: string | null,
): string | null {
  if (!isUnsupportedModelError(message) || /Codex cannot run model/.test(message ?? '')) {
    return null;
  }
  const named = /'([^']+)' model/.exec(message ?? '')?.[1] ?? model ?? 'this model';
  return `Codex cannot run model ${named} on the signed-in account. Run \`codex login\` with an account that has it, or pick another alias (coder model list).`;
}

function codexAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

function jwtSubject(token: unknown): string {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    return String(payload.sub ?? payload.email ?? '');
  } catch {
    return '';
  }
}

/** Account identity; the caller retains its last value across an incomplete write. */
export function codexAuthFingerprint(
  env: NodeJS.ProcessEnv = process.env,
  state?: { file?: string; mtimeMs?: number; fingerprint?: string },
): string {
  const file = codexAuthFile(env);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return '';
  }
  if (state?.file === file && state.mtimeMs === mtimeMs) return state.fingerprint ?? '';
  try {
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const apiKey = auth.OPENAI_API_KEY
      ? createHash('sha256').update(String(auth.OPENAI_API_KEY)).digest('hex')
      : '';
    const fingerprint = [
      auth.auth_mode ?? '',
      auth.tokens?.account_id ?? '',
      jwtSubject(auth.tokens?.id_token),
      apiKey,
    ].join('|');
    if (state) Object.assign(state, { file, mtimeMs, fingerprint });
    return fingerprint;
  } catch {
    return state?.file === file ? (state.fingerprint ?? '') : '';
  }
}
