import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { ProtocolError } from "./app-server.js";

export interface CodexControlClient {
  request(method: string, params?: unknown): Promise<any>;
}

export interface CodexControlResult {
  ok: boolean;
  retryable: boolean;
  result?: any;
  detail: string;
}

interface CodexControlError extends Error {
  retryable: boolean;
  rpcCode?: number;
}

function atomicJsonWrite(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temp, file);
}

function isActiveTurnCompletionRace(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /no active turn|active turn.*(?:ended|completed)|turn.*(?:already )?(?:ended|completed)|turn.*not active/i.test(
    detail
  );
}

function controlError(message: string, retryable: boolean, rpcCode?: number): CodexControlError {
  return Object.assign(new Error(message), {
    retryable,
    ...(rpcCode === undefined ? {} : { rpcCode })
  });
}

function validateOwnerRequest(
  request: any,
  id: string,
  threadId: string,
  turnId: string
): {
  method: "turn/steer" | "turn/interrupt";
  params: Record<string, unknown>;
} {
  if (!request || request.id !== id || (request.method !== "turn/steer" && request.method !== "turn/interrupt")) {
    throw controlError("Invalid Codex control request.", false);
  }
  const params = request.params;
  if (!params || typeof params !== "object" || params.threadId !== threadId) {
    throw controlError("Codex control request does not match its owning thread.", false);
  }
  if (request.method === "turn/interrupt") {
    if (params.turnId !== turnId) {
      throw controlError("Codex turn/interrupt request does not match its owning active turn.", false);
    }
    return { method: request.method, params };
  }
  if (params.expectedTurnId !== turnId) {
    throw controlError("Codex turn/steer request does not match its owning active turn.", false);
  }
  const input = params.input;
  if (
    !Array.isArray(input) ||
    input.length !== 1 ||
    input[0]?.type !== "text" ||
    typeof input[0]?.text !== "string" ||
    !input[0].text.trim()
  ) {
    throw controlError("Invalid Codex turn/steer input schema.", false);
  }
  return { method: request.method, params };
}

/**
 * Start a detached-process-safe control mailbox bound to the exact app-server
 * client that owns one active turn. The caller publishes the returned endpoint
 * only after turn/start has returned its active turn id.
 */
export async function startCodexControlServer(
  client: CodexControlClient,
  { threadId, turnId }: { threadId: string; turnId: string }
) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coder-codex-control-"));
  const endpoint = `file:${directory}`;
  const processing = new Set<Promise<void>>();
  let stopped = false;
  let scanning = false;

  const scan = (closing = false) => {
    if ((stopped && !closing) || scanning) return;
    scanning = true;
    try {
      for (const name of fs.readdirSync(directory).filter((entry) => entry.endsWith(".request.json"))) {
        const requestFile = path.join(directory, name);
        const claimFile = `${requestFile}.${process.pid}.processing`;
        try {
          fs.renameSync(requestFile, claimFile);
        } catch {
          continue;
        }
        const id = name.slice(0, -".request.json".length);
        const responseFile = path.join(directory, `${id}.response.json`);
        const work = (async () => {
          let response: any;
          try {
            if (stopped) {
              throw controlError("Codex owner endpoint is shutting down.", true);
            }
            const request = JSON.parse(fs.readFileSync(claimFile, "utf8"));
            const validated = validateOwnerRequest(request, id, threadId, turnId);
            try {
              const result = await client.request(validated.method, validated.params);
              response = { id, result };
            } catch (error) {
              const protocol = error as ProtocolError;
              response = {
                id,
                error: {
                  message: error instanceof Error ? error.message : String(error),
                  retryable: isActiveTurnCompletionRace(error),
                  ...(protocol.rpcCode === undefined ? {} : { rpcCode: protocol.rpcCode })
                }
              };
            }
          } catch (error) {
            const control = error as CodexControlError;
            response = {
              id,
              error: {
                message: control.message,
                retryable: control.retryable === true,
                ...(control.rpcCode === undefined ? {} : { rpcCode: control.rpcCode })
              }
            };
          }
          try {
            atomicJsonWrite(responseFile, response);
          } finally {
            try {
              fs.unlinkSync(claimFile);
            } catch {
              // Best-effort claim cleanup.
            }
          }
        })();
        processing.add(work);
        void work.then(
          () => processing.delete(work),
          () => processing.delete(work)
        );
      }
    } catch {
      // The directory may be removed by `coder task stop` during teardown.
    } finally {
      scanning = false;
    }
  };
  const timer = setInterval(scan, 10);
  timer.unref?.();

  return {
    endpoint,
    async close() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Claim requests that raced completion and answer them as retryable.
      scan(true);
      await Promise.allSettled([...processing]);
      // Give a detached caller time to consume the final response.
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  };
}

export function removeCodexControlEndpoint(endpoint: string | null | undefined) {
  if (endpoint?.startsWith("file:") && endpoint.length > "file:".length) {
    const directory = path.resolve(endpoint.slice("file:".length));
    const tempRoot = path.resolve(os.tmpdir());
    if (path.dirname(directory) === tempRoot && path.basename(directory).startsWith("coder-codex-control-")) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** Send one control request to a running Codex worker's owning app-server. */
export async function requestCodexControl(
  endpoint: string | null | undefined,
  method: "turn/steer" | "turn/interrupt",
  params: Record<string, unknown>,
  timeoutMs = 3_000
): Promise<CodexControlResult> {
  if (!endpoint) {
    return {
      ok: false,
      retryable: true,
      detail: "Codex owner endpoint is not ready."
    };
  }
  if (!endpoint.startsWith("file:") || endpoint.length === "file:".length) {
    return {
      ok: false,
      retryable: false,
      detail: `Unsupported Codex control endpoint: ${endpoint}`
    };
  }
  const directory = endpoint.slice("file:".length);
  if (!fs.existsSync(directory)) {
    return {
      ok: false,
      retryable: true,
      detail: "Codex owner endpoint is no longer available."
    };
  }
  const id = randomUUID();
  const requestFile = path.join(directory, `${id}.request.json`);
  const responseFile = path.join(directory, `${id}.response.json`);
  try {
    atomicJsonWrite(requestFile, { id, method, params });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      ok: false,
      retryable: code === "ENOENT",
      detail: error instanceof Error ? error.message : String(error)
    };
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = JSON.parse(fs.readFileSync(responseFile, "utf8"));
      try {
        fs.unlinkSync(responseFile);
      } catch {
        // Best-effort response cleanup.
      }
      if (response?.id !== id) {
        return {
          ok: false,
          retryable: false,
          detail: "Malformed Codex owner response id."
        };
      }
      if (response?.error) {
        return {
          ok: false,
          retryable: response.error.retryable === true,
          detail: String(response.error.message ?? "Malformed Codex owner error response.")
        };
      }
      if (!("result" in response)) {
        return {
          ok: false,
          retryable: false,
          detail: "Malformed Codex owner response."
        };
      }
      return {
        ok: true,
        retryable: false,
        result: response.result,
        detail: "Codex owner accepted control."
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          ok: false,
          retryable: false,
          detail: `Invalid Codex owner response: ${error instanceof Error ? error.message : String(error)}`
        };
      }
      if (!fs.existsSync(directory)) {
        // The request was already published, so owner acceptance is unknown.
        // Queueing here could deliver the same steer twice. An orderly owner
        // teardown claims and acknowledges raced requests before removal.
        return {
          ok: false,
          retryable: false,
          detail: "Codex owner endpoint closed after control publication; acceptance is unknown."
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The request was published and may have reached the owner. Never queue a
  // duplicate after an ambiguous timeout.
  return {
    ok: false,
    retryable: false,
    detail: "Timed out waiting for Codex owner acknowledgement."
  };
}
