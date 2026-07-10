/**
 * Forked from the codex plugin's app-server client. Differences:
 * - server-initiated requests (approvals) can be answered via setServerRequestHandler
 * - coder-specific broker endpoint env + state locations
 */
import net from 'node:net';
import process from 'node:process';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { parseBrokerEndpoint } from './broker-endpoint.js';
import { ensureBrokerSession, loadBrokerSession } from './broker-lifecycle.js';
import { runCommand, terminateProcessTree } from './process.js';

export const BROKER_ENDPOINT_ENV = 'CODER_APP_SERVER_ENDPOINT';
export const BROKER_BUSY_RPC_CODE = -32001;

const FALLBACK_CODEX_VERSION = '0.144.1';
let cachedCodexVersion: string | undefined;
function detectCodexVersion() {
  if (cachedCodexVersion === undefined) {
    const result = runCommand('codex', ['--version']);
    const match = /(\d+\.\d+\.\d+(?:-[\w.]+)?)/.exec(`${result.stdout} ${result.stderr}`);
    cachedCodexVersion = match ? match[1] : FALLBACK_CODEX_VERSION;
  }
  return cachedCodexVersion;
}

function defaultClientInfo() {
  return { title: 'Coder', name: 'coder', version: detectCodexVersion() };
}

const DEFAULT_CAPABILITIES = {
  experimentalApi: false,
  requestAttestation: false,
  optOutNotificationMethods: [
    'item/agentMessage/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/textDelta',
  ],
};

export type ProtocolError = Error & { data?: unknown; rpcCode?: number };
export type NotificationHandler = (message: any) => void;
export type ServerRequestHandler = (method: string, params: any) => Promise<any> | any;

export interface ClientOptions {
  env?: NodeJS.ProcessEnv;
  clientInfo?: Record<string, unknown>;
  capabilities?: Record<string, unknown>;
  brokerEndpoint?: string | null;
  disableBroker?: boolean;
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
  lineBuffer: string;
  transport: string;
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
    this.lineBuffer = '';
    this.transport = 'unknown';
    this.handleServerRequest = message => this.defaultHandleServerRequest(message);

    this.exitPromise = new Promise(resolve => {
      this.resolveExit = resolve;
    });
  }

  setNotificationHandler(handler) {
    this.notificationHandler = handler;
  }

  setServerRequestHandler(handler) {
    this.serverRequestHandler = handler;
  }

  request(method, params) {
    if (this.closed) {
      throw new Error('codex app-server client is closed.');
    }

    const id = this.nextId;
    this.nextId += 1;

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.sendMessage({ id, method, params });
    });
  }

  notify(method, params = {}) {
    if (this.closed) {
      return;
    }
    this.sendMessage({ method, params });
  }

  handleChunk(chunk) {
    this.lineBuffer += chunk;
    let newlineIndex = this.lineBuffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.lineBuffer.slice(0, newlineIndex);
      this.lineBuffer = this.lineBuffer.slice(newlineIndex + 1);
      this.handleLine(line);
      newlineIndex = this.lineBuffer.indexOf('\n');
    }
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.handleExit(
        createProtocolError(`Failed to parse codex app-server JSONL: ${error.message}`, { line }),
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

    if (message.method && this.notificationHandler) {
      this.notificationHandler(message);
    }
  }

  defaultHandleServerRequest(message) {
    if (!this.serverRequestHandler) {
      this.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `Unsupported server request: ${message.method}`),
      });
      return;
    }

    Promise.resolve()
      .then(() => this.serverRequestHandler(message.method, message.params ?? {}))
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

  handleExit(error) {
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

  sendMessage(_message) {
    throw new Error('sendMessage must be implemented by subclasses.');
  }
}

class SpawnedCodexAppServerClient extends AppServerClientBase {
  proc?: import('node:child_process').ChildProcess;
  readline?: import('node:readline').Interface;

  constructor(cwd: string, options: ClientOptions = {}) {
    super(cwd, options);
    this.transport = 'direct';
  }

  async initialize() {
    // Disable plugins in the worker session.
    this.proc = spawn('codex', ['app-server', '--disable', 'plugins'], {
      cwd: this.cwd,
      env: this.options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32' ? process.env.SHELL || true : false,
      windowsHide: true,
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stderr.setEncoding('utf8');

    this.proc.stderr.on('data', chunk => {
      this.stderr += chunk;
    });

    this.proc.on('error', error => {
      this.handleExit(error);
    });

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

    this.readline = readline.createInterface({ input: this.proc.stdout });
    this.readline.on('line', line => {
      this.handleLine(line);
    });

    await this.request('initialize', {
      clientInfo: this.options.clientInfo ?? defaultClientInfo(),
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
    });
    this.notify('initialized', {});
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
      this.proc.stdin.end();
      setTimeout(() => {
        if (this.proc && !this.proc.killed && this.proc.exitCode === null) {
          if (process.platform === 'win32') {
            try {
              terminateProcessTree(this.proc.pid);
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

  sendMessage(message) {
    const line = `${JSON.stringify(message)}\n`;
    const stdin = this.proc?.stdin;
    if (!stdin) {
      throw new Error('codex app-server stdin is not available.');
    }
    stdin.write(line);
  }
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

    await this.request('initialize', {
      clientInfo: this.options.clientInfo ?? defaultClientInfo(),
      capabilities: this.options.capabilities ?? DEFAULT_CAPABILITIES,
    });
    this.notify('initialized', {});
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

  sendMessage(message) {
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
    let brokerEndpoint = null;
    if (!options.disableBroker) {
      brokerEndpoint =
        options.brokerEndpoint ??
        options.env?.[BROKER_ENDPOINT_ENV] ??
        process.env[BROKER_ENDPOINT_ENV] ??
        null;
      if (!brokerEndpoint && options.reuseExistingBroker) {
        brokerEndpoint = loadBrokerSession(cwd)?.endpoint ?? null;
      }
      if (!brokerEndpoint && !options.reuseExistingBroker) {
        const brokerSession = await ensureBrokerSession(cwd, { env: options.env });
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
