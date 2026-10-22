#!/usr/bin/env node
/**
 * Forked from the codex plugin's app-server broker. Difference: server-initiated
 * requests (approval callbacks) are forwarded to the client that owns the active
 * stream, and that client's responses are routed back to the app-server. The
 * upstream broker rejects all server requests, which makes approval policies
 * other than "never" impossible.
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import process from 'node:process';

import type { Socket } from 'node:net';

import { defineCommand } from 'contextjsx';
import { parse } from 'contextjsx/emit';
import * as z from 'zod/mini';

import { str } from '../../utils/args';
import {
  BROKER_APP_SERVER_EXITED_METHOD,
  BROKER_BUSY_RPC_CODE,
  BROKER_NOTICE_METHOD,
  BROKER_RECYCLE_METHOD,
  CodexAppServerClient,
  ProtocolError,
  codexAuthFingerprint,
  errorText,
} from '../engines/codex/app-server';
import { startChatBridge } from '../engines/codex/chat-bridge';
import { clearBrokerSession, loadBrokerSession, parseBrokerEndpoint } from './session';
import { connectionEnvironmentKey } from '../connections';
import { redactConnectionSecrets } from '../connection-env';

/** A JSON-RPC frame passing through the broker (request, response, or notification). */
interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

type AppClient = Awaited<ReturnType<typeof CodexAppServerClient.connect>>;

const STREAMING_METHODS = new Set(['turn/start', 'review/start', 'thread/compact/start']);
const ORPHAN_CHECK_MS = 30_000;
const APP_SERVER_START_TIMEOUT_MS = 30_000;
// Codex unloads a thread 30 minutes after its last subscriber, and any
// app-server resumes it from disk, so an idle broker holds nothing past that.
const IDLE_EXIT_MS = 30 * 60_000;

function buildStreamThreadIds(
  method: string,
  params: Record<string, any> | undefined,
  result: Record<string, any> | null,
): Set<string> {
  const threadIds = new Set<string>();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === 'review/start' && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
}

/** What Codex fixes when it loads a thread: every thread/start or thread/resume field but the ids. */
function threadSettings(params: Record<string, any> = {}) {
  const { threadId, serviceName, ephemeral, ...settings } = params;

  return JSON.stringify(settings);
}

function buildJsonRpcError(code: number, message: string, data?: unknown) {
  return data === undefined ? { code, message } : { code, message, data };
}

function send(socket: Socket, message: JsonRpcMessage) {
  if (socket.destroyed) {
    return;
  }
  socket.write(`${JSON.stringify(message)}\n`);
}

// Requests a second client may send while another client owns the active
// stream: interrupting/steering the turn, stopping a stopped turn's commands,
// or archiving/deleting a finished thread this app-server still holds loaded.
// All leave stream ownership untouched, so the broker forwards them instead
// of returning "busy".
const PASSTHROUGH_DURING_STREAM = new Set([
  'turn/interrupt',
  'turn/steer',
  'thread/backgroundTerminals/clean',
  'thread/archive',
  'thread/delete',
]);

function isPassthroughDuringStream(message: JsonRpcMessage) {
  return typeof message?.method === 'string' && PASSTHROUGH_DURING_STREAM.has(message.method);
}

function writePidFile(pidFile: string | null) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, 'utf8');
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== 'serve') {
    throw new Error(
      'Usage: coder broker serve --endpoint <value> [--cwd <path>] [--pid-file <path>] [--network-access <true|false>] [--idle-ms <ms>]',
    );
  }

  const options = parse(
    defineCommand({
      name: 'broker',
      description: 'The codex app-server broker',
      access: 'write',
      args: {
        cwd: str(),
        'pid-file': str(),
        endpoint: z.string(),
        'network-access': z.optional(z.enum(['true', 'false'])),
        'idle-ms': str(),
      },
      run() {},
    }),
    argv,
  );

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options['pid-file'] ? path.resolve(options['pid-file']) : null;
  const networkAccess = options['network-access'] === 'true';
  const idleMs = Number(options['idle-ms'] ?? IDLE_EXIT_MS);
  writePidFile(pidFile);

  // The shared app-server. Replaced when it dies or its login goes stale,
  // started lazily on the next request.
  let appClient: AppClient | null = null;
  let appAuth = '';
  const authState = {};
  let starting: Promise<AppClient> | null = null;
  let recycleRequested = false;
  let stopping = false;
  let activeRequestSocket: Socket | null = null;
  let activeStreamSocket: Socket | null = null;
  let activeStreamThreadIds: Set<string> | null = null;
  const sockets = new Set<Socket>();
  // Each loaded thread's settings, per app-server.
  const loadedThreads = new WeakMap<AppClient, Map<string, string>>();
  // Custom-model keys pass through as provider headers; broker.log never shows them.
  const headerSecrets = new Set<string>();
  // Server-request id -> socket that must answer it, and the app-server that asked.
  const pendingServerRequests = new Map<
    JsonRpcMessage['id'],
    { socket: Socket; client: AppClient }
  >();

  function log(line: string) {
    process.stderr.write(
      `[coder broker] ${JSON.parse(redactConnectionSecrets(line, [...headerSecrets]))}\n`,
    );
  }

  function failPendingServerRequests(socket: Socket) {
    for (const [id, owner] of pendingServerRequests) {
      if (owner.socket === socket) {
        pendingServerRequests.delete(id);
        if (!owner.client.exitResolved) {
          owner.client.sendMessage({
            id,
            error: buildJsonRpcError(
              -32000,
              'Broker client disconnected before answering the server request.',
            ),
          });
        }
      }
    }
  }

  // Approval callbacks and other server requests: forward the raw message to the
  // owning client and remember who must answer. The raw JSON-RPC id is preserved
  // so the client's response can be piped straight back to the app-server.
  function forwardServerRequest(client: AppClient, message: JsonRpcMessage) {
    const target = activeStreamSocket ?? activeRequestSocket;
    if (!target || target.destroyed) {
      client.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `No broker client available to answer ${message.method}.`),
      });
      return;
    }
    pendingServerRequests.set(message.id, { socket: target, client });
    send(target, message);
  }

  // Tell whoever the dead app-server was serving, so their turn fails now
  // instead of waiting forever for a turn/completed that never comes.
  function onAppServerExit(client: AppClient) {
    if (client !== appClient || stopping) {
      return;
    }
    appClient = null;
    const message = client.exitError?.message ?? 'codex app-server exited.';
    log(`${message} Starting a fresh one on the next request.`);
    for (const socket of new Set([activeRequestSocket, activeStreamSocket])) {
      if (socket) {
        send(socket, { method: BROKER_APP_SERVER_EXITED_METHOD, params: { message } });
      }
    }
    pendingServerRequests.clear();
    activeRequestSocket = null;
    activeStreamSocket = null;
    activeStreamThreadIds = null;
  }

  async function startAppClient(): Promise<AppClient> {
    const auth = codexAuthFingerprint(process.env, authState);
    const connecting = CodexAppServerClient.connect(cwd, {
      disableBroker: true,
      networkAccess,
      bridgeUrl: bridge.url,
    });
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`no answer within ${APP_SERVER_START_TIMEOUT_MS / 1000}s`)),
        APP_SERVER_START_TIMEOUT_MS,
      );
    });
    try {
      const client = await Promise.race([connecting, timeout]);
      client.setNotificationHandler(routeNotification);
      client.handleServerRequest = (message: JsonRpcMessage) =>
        forwardServerRequest(client, message);
      void client.exitPromise.then(() => onAppServerExit(client));
      appAuth = auth;
      return client;
    } catch (error) {
      void connecting.then(client => client.close()).catch(() => {});
      throw new Error(`codex app-server could not start: ${errorText(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  async function retireAppClient() {
    const client = appClient;
    appClient = null;
    pendingServerRequests.clear();
    await client?.close().catch(() => {});
  }

  // The live app-server for a new request: respawned after it died, and
  // recycled when ~/.codex/auth.json now signs in as someone else (it loaded
  // its tokens at start and cannot refresh them after an account switch).
  async function ensureAppClient(socket: Socket): Promise<AppClient> {
    if (starting) {
      return starting;
    }
    const stale = recycleRequested || codexAuthFingerprint(process.env, authState) !== appAuth;
    if (appClient && !appClient.exitResolved && !stale) {
      return appClient;
    }
    if (appClient && !appClient.exitResolved) {
      const message = 'Codex login changed; restarted the shared Codex app-server.';
      log(message);
      send(socket, { method: BROKER_NOTICE_METHOD, params: { message } });
    }
    recycleRequested = false;
    await retireAppClient();
    starting = startAppClient().finally(() => {
      starting = null;
    });
    appClient = await starting;
    return appClient;
  }

  function clearSocketOwnership(socket: Socket) {
    failPendingServerRequests(socket);
    if (activeRequestSocket === socket) {
      activeRequestSocket = null;
    }
    if (activeStreamSocket === socket) {
      activeStreamSocket = null;
      activeStreamThreadIds = null;
    }
  }

  function routeNotification(message: JsonRpcMessage) {
    const target = activeRequestSocket ?? activeStreamSocket;
    if (!target) {
      return;
    }
    send(target, message);
    if (message.method === 'turn/completed' && activeStreamSocket === target) {
      const threadId = message.params?.threadId ?? null;
      if (!threadId || !activeStreamThreadIds || activeStreamThreadIds.has(threadId)) {
        activeStreamSocket = null;
        activeStreamThreadIds = null;
        if (activeRequestSocket === target) {
          activeRequestSocket = null;
        }
      }
    }
  }

  // Stops accepting and drops its session record first, so the next dispatch starts a fresh broker.
  async function shutdown(server: import('node:net').Server) {
    stopping = true;
    const closed = new Promise(resolve => server.close(resolve));
    if (listenTarget.kind === 'unix' && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    const connectionKey = connectionEnvironmentKey();
    if (loadBrokerSession(cwd, networkAccess, connectionKey)?.endpoint === endpoint) {
      clearBrokerSession(cwd, networkAccess, connectionKey);
    }

    for (const socket of sockets) {
      socket.end();
    }
    await appClient?.close().catch(() => {});
    await bridge.close();
    await closed;
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  // Outlives app-server recycles, so threads loaded on any of them reach a live port.
  const bridge = await startChatBridge();
  appClient = await startAppClient();

  // Every live task holds a socket for its turn, so no sockets means no live tasks.
  let idleTimer: NodeJS.Timeout | undefined;
  function exitWhenIdle() {
    clearTimeout(idleTimer);
    if (sockets.size === 0) {
      idleTimer = setTimeout(async () => {
        log(`No clients for ${idleMs / 1000}s; exiting.`);
        await shutdown(server);
        process.exit(0);
      }, idleMs);
    }
  }

  const server = net.createServer(socket => {
    clearTimeout(idleTimer);
    sockets.add(socket);
    socket.setEncoding('utf8');
    let buffer = '';

    socket.on('data', async chunk => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');

        if (!line.trim()) {
          continue;
        }

        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(
              -32700,
              `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
            ),
          });
          continue;
        }

        // Response to a forwarded server request: pipe back to the app-server.
        const pending =
          message.id !== undefined && !message.method
            ? pendingServerRequests.get(message.id)
            : undefined;
        if (pending) {
          pendingServerRequests.delete(message.id);
          if (!pending.client.exitResolved) {
            pending.client.sendMessage(message);
          }
          continue;
        }

        if (message.id !== undefined && message.method === 'initialize') {
          send(socket, {
            id: message.id,
            result: {
              userAgent: 'coder-broker',
              bridgeUrl: bridge.url,
            },
          });
          continue;
        }

        if (message.method === 'initialized' && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === 'broker/shutdown') {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined || !message.method) {
          continue;
        }

        for (const [key, value] of Object.entries<any>(message.params?.config ?? {}))
          if (key.startsWith('model_providers.') && value?.http_headers?.authorization)
            headerSecrets.add(String(value.http_headers.authorization).replace(/^Bearer /, ''));

        const busy =
          (activeRequestSocket && activeRequestSocket !== socket) ||
          (activeStreamSocket && activeStreamSocket !== socket);

        // A client whose turn failed on stale auth asks for a fresh app-server:
        // recycled now when idle, else by the next request after the stream ends.
        if (message.method === BROKER_RECYCLE_METHOD) {
          recycleRequested = true;
          if (!busy && appClient) {
            log('Recycling the shared Codex app-server after a stale-login error.');
            recycleRequested = false;
            await retireAppClient();
          }
          send(socket, { id: message.id, result: { recycled: !busy } });
          continue;
        }

        const allowPassthroughDuringActiveStream =
          isPassthroughDuringStream(message) &&
          activeStreamSocket &&
          activeStreamSocket !== socket &&
          !activeRequestSocket;

        if (busy && !allowPassthroughDuringActiveStream) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, 'Shared Codex broker is busy.'),
          });
          continue;
        }

        if (allowPassthroughDuringActiveStream) {
          try {
            if (!appClient) {
              throw new Error('codex app-server is not running.');
            }
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            const err = error as ProtocolError;
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(err.rpcCode ?? -32000, err.message),
            });
          }
          continue;
        }

        const isStreaming = STREAMING_METHODS.has(message.method);
        activeRequestSocket = socket;
        if (isStreaming) {
          // Claim the stream before awaiting so approval callbacks that arrive
          // mid-request already have an owner.
          activeStreamSocket = socket;
          activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, null);
        }

        try {
          const client = await ensureAppClient(socket);
          const loaded = loadedThreads.get(client) ?? new Map<string, string>();
          loadedThreads.set(client, loaded);
          const settings =
            message.method === 'thread/start' || message.method === 'thread/resume'
              ? threadSettings(message.params)
              : null;
          // A loaded thread keeps its first settings while this connection subscribes; unsubscribed, a resume reloads it with the new ones.
          if (
            message.method === 'thread/resume' &&
            loaded.get(message.params?.threadId) !== settings
          )
            await client.request('thread/unsubscribe', { threadId: message.params?.threadId });
          const result = await client.request(message.method, message.params ?? {});
          if (settings && result?.thread?.id) loaded.set(result.thread.id, settings);
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamThreadIds = buildStreamThreadIds(
              message.method,
              message.params ?? {},
              result,
            );
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          const err = error as ProtocolError;
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(err.rpcCode ?? -32000, err.message),
          });
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
          if (activeStreamSocket === socket && isStreaming) {
            activeStreamSocket = null;
            activeStreamThreadIds = null;
          }
        }
      }
    });

    socket.on('close', () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      exitWhenIdle();
    });

    socket.on('error', () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
      exitWhenIdle();
    });
  });

  process.on('SIGTERM', async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on('SIGINT', async () => {
    await shutdown(server);
    process.exit(0);
  });

  // ensureBrokerSession replaces a broker from another build by clearing its
  // session record, never by killing it (it may still be serving a turn). An
  // orphaned broker would otherwise live forever, keeping every thread its
  // app-server loaded write-locked so nothing else can archive or resume them.
  setInterval(async () => {
    if (
      sockets.size === 0 &&
      loadBrokerSession(cwd, networkAccess, connectionEnvironmentKey())?.endpoint !== endpoint
    ) {
      await shutdown(server);
      process.exit(0);
    }
  }, ORPHAN_CHECK_MS).unref();

  server.listen(listenTarget.path);
  exitWhenIdle();
}

main().catch(error => {
  process.stderr.write(
    `${JSON.parse(redactConnectionSecrets(error instanceof Error ? error.message : String(error)))}\n`,
  );
  process.exit(1);
});
