#!/usr/bin/env node
/**
 * Forked from the codex plugin's app-server broker. Difference: server-initiated
 * requests (approval callbacks) are forwarded to the client that owns the active
 * stream, and that client's responses are routed back to the app-server. The
 * upstream broker rejects all server requests, which makes approval policies
 * other than "never" impossible.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import type { Socket } from "node:net";

import { parseArgs } from "./args.js";
import { BROKER_BUSY_RPC_CODE, CodexAppServerClient, ProtocolError } from "./app-server.js";
import { parseBrokerEndpoint } from "./broker-endpoint.js";

/** A JSON-RPC frame passing through the broker (request, response, or notification). */
interface JsonRpcMessage {
  id?: number | string | null;
  method?: string;
  params?: Record<string, any>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const STREAMING_METHODS = new Set(["turn/start", "review/start", "thread/compact/start"]);

function buildStreamThreadIds(
  method: string,
  params: Record<string, any> | undefined,
  result: Record<string, any> | null
): Set<string> {
  const threadIds = new Set<string>();
  if (params?.threadId) {
    threadIds.add(params.threadId);
  }
  if (method === "review/start" && result?.reviewThreadId) {
    threadIds.add(result.reviewThreadId);
  }
  return threadIds;
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

function isInterruptRequest(message: JsonRpcMessage) {
  return message?.method === "turn/interrupt";
}

function writePidFile(pidFile: string | null) {
  if (!pidFile) {
    return;
  }
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  fs.writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

async function main() {
  const [subcommand, ...argv] = process.argv.slice(2);
  if (subcommand !== "serve") {
    throw new Error("Usage: node src/lib/broker.mjs serve --endpoint <value> [--cwd <path>] [--pid-file <path>]");
  }

  const { options } = parseArgs(argv, {
    valueOptions: ["cwd", "pid-file", "endpoint"]
  });

  if (!options.endpoint) {
    throw new Error("Missing required --endpoint.");
  }

  const cwd = options.cwd ? path.resolve(process.cwd(), options.cwd) : process.cwd();
  const endpoint = String(options.endpoint);
  const listenTarget = parseBrokerEndpoint(endpoint);
  const pidFile = options["pid-file"] ? path.resolve(options["pid-file"]) : null;
  writePidFile(pidFile);

  const appClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
  let activeRequestSocket: Socket | null = null;
  let activeStreamSocket: Socket | null = null;
  let activeStreamThreadIds: Set<string> | null = null;
  const sockets = new Set<Socket>();
  // Server-request id -> socket that must answer it.
  const pendingServerRequests = new Map<JsonRpcMessage["id"], Socket>();

  function failPendingServerRequests(socket: Socket) {
    for (const [id, owner] of pendingServerRequests) {
      if (owner === socket) {
        pendingServerRequests.delete(id);
        appClient.sendMessage({
          id,
          error: buildJsonRpcError(-32000, "Broker client disconnected before answering the server request.")
        });
      }
    }
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
    if (message.method === "turn/completed" && activeStreamSocket === target) {
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

  async function shutdown(server: import("node:net").Server) {
    for (const socket of sockets) {
      socket.end();
    }
    await appClient.close().catch(() => {});
    await new Promise((resolve) => server.close(resolve));
    if (listenTarget.kind === "unix" && fs.existsSync(listenTarget.path)) {
      fs.unlinkSync(listenTarget.path);
    }
    if (pidFile && fs.existsSync(pidFile)) {
      fs.unlinkSync(pidFile);
    }
  }

  appClient.setNotificationHandler(routeNotification);

  // Approval callbacks and other server requests: forward the raw message to the
  // owning client and remember who must answer. The raw JSON-RPC id is preserved
  // so the client's response can be piped straight back to the app-server.
  appClient.handleServerRequest = (message: JsonRpcMessage) => {
    const target = activeStreamSocket ?? activeRequestSocket;
    if (!target || target.destroyed) {
      appClient.sendMessage({
        id: message.id,
        error: buildJsonRpcError(-32601, `No broker client available to answer ${message.method}.`)
      });
      return;
    }
    pendingServerRequests.set(message.id, target);
    send(target, message);
  };

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.setEncoding("utf8");
    let buffer = "";

    socket.on("data", async (chunk) => {
      buffer += chunk;
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");

        if (!line.trim()) {
          continue;
        }

        let message: JsonRpcMessage;
        try {
          message = JSON.parse(line);
        } catch (error) {
          send(socket, {
            id: null,
            error: buildJsonRpcError(-32700, `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`)
          });
          continue;
        }

        // Response to a forwarded server request: pipe back to the app-server.
        if (message.id !== undefined && !message.method && pendingServerRequests.has(message.id)) {
          pendingServerRequests.delete(message.id);
          appClient.sendMessage(message);
          continue;
        }

        if (message.id !== undefined && message.method === "initialize") {
          send(socket, {
            id: message.id,
            result: {
              userAgent: "coder-broker"
            }
          });
          continue;
        }

        if (message.method === "initialized" && message.id === undefined) {
          continue;
        }

        if (message.id !== undefined && message.method === "broker/shutdown") {
          send(socket, { id: message.id, result: {} });
          await shutdown(server);
          process.exit(0);
        }

        if (message.id === undefined || !message.method) {
          continue;
        }

        const allowInterruptDuringActiveStream =
          isInterruptRequest(message) && activeStreamSocket && activeStreamSocket !== socket && !activeRequestSocket;

        if (
          ((activeRequestSocket && activeRequestSocket !== socket) || (activeStreamSocket && activeStreamSocket !== socket)) &&
          !allowInterruptDuringActiveStream
        ) {
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(BROKER_BUSY_RPC_CODE, "Shared Codex broker is busy.")
          });
          continue;
        }

        if (allowInterruptDuringActiveStream) {
          try {
            const result = await appClient.request(message.method, message.params ?? {});
            send(socket, { id: message.id, result });
          } catch (error) {
            const err = error as ProtocolError;
            send(socket, {
              id: message.id,
              error: buildJsonRpcError(err.rpcCode ?? -32000, err.message)
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
          const result = await appClient.request(message.method, message.params ?? {});
          send(socket, { id: message.id, result });
          if (isStreaming) {
            activeStreamThreadIds = buildStreamThreadIds(message.method, message.params ?? {}, result);
          }
          if (activeRequestSocket === socket) {
            activeRequestSocket = null;
          }
        } catch (error) {
          const err = error as ProtocolError;
          send(socket, {
            id: message.id,
            error: buildJsonRpcError(err.rpcCode ?? -32000, err.message)
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

    socket.on("close", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });

    socket.on("error", () => {
      sockets.delete(socket);
      clearSocketOwnership(socket);
    });
  });

  process.on("SIGTERM", async () => {
    await shutdown(server);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await shutdown(server);
    process.exit(0);
  });

  server.listen(listenTarget.path);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
