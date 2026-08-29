/**
 * Claude engine over the claude CLI in print mode. Used when the host cannot
 * spawn Claude subagents itself (codex plugin, direct CLI use). Sessions are
 * assigned an id up front so jobs are steerable via --resume, mirroring codex
 * threadIds.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { CLAUDE_PERMISSION_FLAGS, CLAUDE_SIDECAR_FLAGS, claudeTurnSettings } from "./config.js";
import { CLI_PATH } from "./runtime.js";
import type { AuthStatus, Availability, Effort, Permission, TokenUsage, TurnResult } from "./types.js";

// Flatten a tool_result block's content (string, or array of text parts) to
// raw text for progress output.
function toolResultText(content: any): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("");
  }
  return content == null ? "" : JSON.stringify(content);
}

function textLineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === "") lines.pop();
  return Math.max(1, lines.length);
}

function matchingLineRanges(file: string, needle: string, replaceAll = false): string[] {
  if (!needle) return [];
  let source: string;
  try {
    source = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const ranges: string[] = [];
  let from = 0;
  while (from <= source.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    const start = textLineCount(source.slice(0, index)) + 1;
    const count = Math.max(1, textLineCount(needle));
    ranges.push(count === 1 ? `L${start}` : `L${start}-L${start + count - 1}`);
    if (!replaceAll) break;
    from = index + Math.max(needle.length, 1);
  }
  if (ranges.length > 4) {
    return [...ranges.slice(0, 4), `+${ranges.length - 4} matches`];
  }
  return ranges;
}

/** Compact, path-first tool detail for task logs and watch output. */
export function describeClaudeToolUse(name: string, input: Record<string, any>, cwd: string): string {
  const target = String(input.file_path ?? input.notebook_path ?? "");
  const resolved = target ? (path.isAbsolute(target) ? target : path.resolve(cwd, target)) : "";
  if (name === "Write") {
    const lines = textLineCount(String(input.content ?? ""));
    return `Write ${target || "(unknown path)"} ${lines ? `L1-L${lines}` : "(empty file)"}`;
  }
  if (name === "Edit") {
    const ranges = matchingLineRanges(resolved, String(input.old_string ?? ""), input.replace_all === true);
    return `Edit ${target || "(unknown path)"}${ranges.length ? ` ${ranges.join(", ")}` : ""}`;
  }
  if (name === "MultiEdit") {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const ranges = edits.flatMap((edit: any) =>
      matchingLineRanges(resolved, String(edit?.old_string ?? ""), edit?.replace_all === true)
    );
    return `MultiEdit ${target || "(unknown path)"}${ranges.length ? ` ${ranges.join(", ")}` : ""} (${edits.length} edits)`;
  }
  if (name === "NotebookEdit") {
    const cell = input.cell_id ?? input.cell_number;
    return `NotebookEdit ${target || "(unknown path)"}${cell == null ? "" : ` cell ${cell}`}`;
  }
  return `${name} ${JSON.stringify(input ?? {})}`;
}

// Normalize the result event's usage block ({input_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, output_tokens}).
function normalizeClaudeUsage(usage: any): TokenUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const input = num(usage.input_tokens);
  const cachedInput = num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  return { input, cachedInput, output, total: input + cachedInput + output };
}

export function getClaudeAvailability(): Availability {
  const probe = spawnSync("claude", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return { available: false, detail: "claude CLI not found on PATH (npm install -g @anthropic-ai/claude-code)" };
  }
  return { available: true, detail: String(probe.stdout || "").trim() };
}

// Whether the claude CLI is logged in, via `claude auth status --json`.
export function getClaudeAuthStatus(): AuthStatus {
  const probe = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    return { loggedIn: false, detail: "not logged in" };
  }
  try {
    const data = JSON.parse(String(probe.stdout || "")) as {
      loggedIn?: boolean;
      email?: string;
      subscriptionType?: string;
    };
    if (!data.loggedIn) {
      return { loggedIn: false, detail: "not logged in" };
    }
    const detail = [data.email, data.subscriptionType].filter(Boolean).join(", ") || "logged in";
    return { loggedIn: true, detail };
  } catch {
    return { loggedIn: false, detail: "unknown" };
  }
}

export interface ClaudeTurnOptions {
  prompt: string;
  model?: string | null;
  effort?: Effort | null;
  permissions?: Permission | null;
  /** Route unresolved permission asks to coder's approval policy (auto mode only). */
  approvalJobId?: string | null;
  /** Hosts reachable inside the sandbox without approval (auto mode only). */
  allowedNetworkHosts?: string[];
  /** Extra existing directories the turn may inspect; read-only turns deny writes there too. */
  additionalDirectories?: string[];
  /** Inspection tools for a read-only sidecar; supplying any also applies CLAUDE_SIDECAR_FLAGS. */
  readOnlyAllowedTools?: string[];
  resumeSessionId?: string | null;
  onProgress?: (update: { message: string; threadId?: string }) => void;
  onHeartbeat?: () => void;
  /** Publishes the worker-owned endpoint once this turn can accept live input. */
  onSteerReady?: (endpoint: string) => void;
  /** Test seam; production always resolves `claude` from PATH. */
  executable?: string;
}

export interface ClaudeTurnResult extends TurnResult {
  threadId: string;
  turnId: string | null;
  finalMessage: string;
  error: { message: string } | null;
}

/** Build the native CLI invocation so every Claude caller shares one permission policy. */
export function buildClaudeTurnArgs(
  cwd: string,
  options: ClaudeTurnOptions,
  sessionId: string,
): string[] {
  // stream-json emits newline-delimited events (tool calls, result) as the turn
  // runs, so progress is visible instead of a single blob at the end like the
  // plain "json" format. --verbose is required for stream-json in print mode.
  const args = [
    "-p",
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--verbose",
    // Preserve user frames in the stream for progress/debug visibility. Claude
    // may not replay a mid-tool frame until that tool returns, so replay cannot
    // be used as the synchronous acknowledgement for `coder task steer`.
    "--replay-user-messages",
  ];
  args.push(options.resumeSessionId ? "--resume" : "--session-id", sessionId);
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  const permissions = options.permissions ?? "auto";
  // Extra directories are exclusively a read-only sidecar capability. Keeping
  // them out of other modes prevents a future caller from widening a writable
  // turn's filesystem scope by accident.
  const additionalDirectories = permissions === "read-only" ? (options.additionalDirectories ?? []) : [];
  const readOnlyAllowedTools = permissions === "read-only" ? (options.readOnlyAllowedTools ?? []) : [];
  if (permissions === "auto" && options.approvalJobId) {
    // Prompt tool is only consulted in default mode (never auto/dontAsk):
    // unresolved asks hit coder's policy instead of a flat deny.
    const mcpConfig = JSON.stringify({
      mcpServers: {
        coder: {
          type: "stdio",
          command: process.execPath,
          args: [CLI_PATH, "_mcp", options.approvalJobId, "--cwd", cwd]
        }
      }
    });
    args.push(
      "--permission-mode", "default",
      "--mcp-config", mcpConfig,
      "--permission-prompt-tool", "mcp__coder__approval_prompt"
    );
  } else if (readOnlyAllowedTools.length) {
    // Sidecar: a stricter deny list than plain read-only, then the inspection
    // tools it is granted. See CLAUDE_SIDECAR_FLAGS for why Bash goes too.
    args.push(...CLAUDE_SIDECAR_FLAGS, "--allowedTools", ...readOnlyAllowedTools);
  } else {
    args.push(...(CLAUDE_PERMISSION_FLAGS[permissions] ?? CLAUDE_PERMISSION_FLAGS.auto));
  }
  for (const directory of additionalDirectories) {
    args.push("--add-dir", directory);
  }
  // Read-only is enforced by claude's OS sandbox, scoped to deny writes to this
  // workspace; passed as a settings JSON string so it needs no on-disk config.
  const turnSettings = claudeTurnSettings(
    permissions,
    cwd,
    options.allowedNetworkHosts ?? [],
    additionalDirectories,
  );
  if (turnSettings) {
    args.push("--settings", turnSettings);
  }

  return args;
}

interface ClaudeInputError extends Error {
  retryable: boolean;
}

function inputError(message: string, retryable: boolean): ClaudeInputError {
  return Object.assign(new Error(message), { retryable });
}

function claudeUserMessage(text: string) {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
  };
}

function createClaudeInputController(
  write: (frame: string, callback: (error?: Error | null) => void) => void,
) {
  let accepting = true;

  return {
    sendInitial(text: string): Promise<void> {
      return new Promise((resolve, reject) => {
        write(`${JSON.stringify(claudeUserMessage(text))}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    sendSteer(text: string): Promise<void> {
      if (!accepting) {
        return Promise.reject(inputError("Claude turn is no longer accepting live input.", true));
      }
      return new Promise((resolve, reject) => {
        write(`${JSON.stringify(claudeUserMessage(text))}\n`, (error) => {
          if (!error) {
            resolve();
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          const completionRace = code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
          reject(inputError(`Failed to write Claude live steer: ${error.message}`, completionRace));
        });
      });
    },
    stopAccepting() {
      accepting = false;
    },
  };
}

function atomicJsonWrite(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temp, file);
}

async function startClaudeSteerServer(sendSteer: (text: string) => Promise<void>) {
  // A file mailbox works in restricted worker sandboxes that deny Unix socket
  // binds. Atomic rename publishes complete requests/responses across detached
  // processes. The worker responds after the complete JSONL frame has been
  // accepted by Claude's stdin; Claude consumes it at its next model boundary.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "coder-claude-steer-"));
  const endpoint = `file:${directory}`;
  const processing = new Set<Promise<void>>();
  let stopped = false;
  let scanning = false;

  const scan = (closing = false) => {
    if ((stopped && !closing) || scanning) return;
    scanning = true;
    try {
      for (const name of fs.readdirSync(directory).filter((name) => name.endsWith(".request.json"))) {
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
            const request = JSON.parse(fs.readFileSync(claimFile, "utf8"));
            const text = typeof request?.params?.text === "string" ? request.params.text.trim() : "";
            if (request?.method !== "turn/steer" || !text || request?.id !== id) {
              response = {
                id,
                error: {
                  message: "Invalid Claude steer request.",
                  retryable: false,
                },
              };
            } else {
              try {
                await sendSteer(text);
                response = { id, result: { accepted: true } };
              } catch (error) {
                const input = error as ClaudeInputError;
                response = {
                  id,
                  error: {
                    message: input.message,
                    retryable: input.retryable === true,
                  },
                };
              }
            }
          } catch (error) {
            response = {
              id,
              error: {
                message: `Invalid Claude steer JSON: ${error instanceof Error ? error.message : String(error)}`,
                retryable: false,
              },
            };
          }
          try {
            atomicJsonWrite(responseFile, response);
          } finally {
            try {
              fs.unlinkSync(claimFile);
            } catch {
              /* best-effort */
            }
          }
        })();
        processing.add(work);
        void work.then(
          () => processing.delete(work),
          () => processing.delete(work),
        );
      }
    } catch {
      // The directory is removed only after polling stops.
    } finally {
      scanning = false;
    }
  };
  const timer = setInterval(scan, 10);

  return {
    endpoint,
    async close() {
      stopped = true;
      clearInterval(timer);
      // Claim requests that raced the result event. The input controller now
      // answers them as retryable instead of losing them during teardown.
      scan(true);
      await Promise.allSettled([...processing]);
      // Let a waiting steer process observe its final response before cleanup.
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Inject one user message into a worker-owned Claude stream-json process. */
export async function steerClaudeTurn(
  endpoint: string | null | undefined,
  text: string,
  timeoutMs = 3_000,
): Promise<{ steered: boolean; retryable: boolean; detail: string }> {
  if (!endpoint) {
    return {
      steered: false,
      retryable: true,
      detail: "Claude live steer endpoint is not ready.",
    };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { steered: false, retryable: false, detail: "empty follow-up" };
  }
  if (!endpoint.startsWith("file:") || endpoint.length === "file:".length) {
    return {
      steered: false,
      retryable: false,
      detail: `Unsupported Claude steer endpoint: ${endpoint}`,
    };
  }
  const directory = endpoint.slice("file:".length);
  if (!fs.existsSync(directory)) {
    return {
      steered: false,
      retryable: true,
      detail: "Claude live steer endpoint is no longer available.",
    };
  }
  const id = randomUUID();
  const requestFile = path.join(directory, `${id}.request.json`);
  const responseFile = path.join(directory, `${id}.response.json`);
  try {
    atomicJsonWrite(requestFile, {
      id,
      method: "turn/steer",
      params: { text: trimmed },
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      steered: false,
      retryable: code === "ENOENT",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = JSON.parse(fs.readFileSync(responseFile, "utf8"));
      try {
        fs.unlinkSync(responseFile);
      } catch {
        /* best-effort */
      }
      if (response?.result?.accepted === true) {
        return {
          steered: true,
          retryable: false,
          detail: "Claude accepted the live follow-up.",
        };
      }
      return {
        steered: false,
        retryable: response?.error?.retryable === true,
        detail: String(response?.error?.message ?? "Malformed Claude steer response."),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return {
          steered: false,
          retryable: false,
          detail: `Invalid Claude steer response: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The request was published, so acceptance is unknown. Never queue a second
  // copy; surface the protocol failure for the caller and job log.
  return {
    steered: false,
    retryable: false,
    detail: "Timed out waiting for Claude live steer acknowledgement.",
  };
}

export async function runClaudeTurn(cwd: string, options: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const sessionId = options.resumeSessionId ?? randomUUID();
  const args = buildClaudeTurnArgs(cwd, options, sessionId);

  options.onProgress?.({
    message: `claude turn started (session ${sessionId})`,
    threadId: sessionId,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(options.executable ?? "claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    const protocolErrors: string[] = [];
    let resultEvent: any = null;
    let streamSessionId = sessionId;
    let steerServer: Awaited<ReturnType<typeof startClaudeSteerServer>> | null = null;
    let settled = false;
    const input = createClaudeInputController((frame, callback) => child.stdin.write(frame, callback));
    // Timestamp of the previous stream event, to estimate thinking duration.
    let lastEventAt = Date.now();

    const handleEvent = (event: any) => {
      if (!event || typeof event !== "object") {
        return;
      }
      options.onHeartbeat?.();
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        streamSessionId = event.session_id;
      } else if (event.type === "assistant") {
        // Forward tool calls raw (name + full input), assistant text in full,
        // and thinking as a one-liner preview with elapsed time.
        for (const block of event.message?.content ?? []) {
          if (block?.type === "tool_use") {
            options.onProgress?.({
              message: describeClaudeToolUse(String(block.name ?? "Tool"), block.input ?? {}, cwd),
              threadId: streamSessionId,
            });
          } else if (block?.type === "text" && typeof block.text === "string" && block.text.trim()) {
            options.onProgress?.({
              message: block.text.trim(),
              threadId: streamSessionId,
            });
          } else if (block?.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) {
            const seconds = Math.max(1, Math.round((Date.now() - lastEventAt) / 1000));
            const firstLine = block.thinking.trim().split("\n")[0]!;
            const preview = firstLine.length > 100 ? `${firstLine.slice(0, 100)}…` : firstLine;
            options.onProgress?.({
              message: `Thought for ${seconds}s: ${preview}`,
              threadId: streamSessionId,
            });
          }
        }
      } else if (event.type === "user") {
        // Forward tool results raw, so intermediate command output is visible.
        for (const block of event.message?.content ?? []) {
          if (block?.type === "tool_result") {
            const text = toolResultText(block.content).trim();
            if (text) {
              options.onProgress?.({
                message: text,
                threadId: streamSessionId,
              });
            }
          }
        }
      } else if (event.type === "result") {
        resultEvent = event;
        if (event.session_id) {
          streamSessionId = event.session_id;
        }
        // stream-json input keeps the CLI alive waiting for more messages even
        // after the result. End stdin only after Claude declares this extended
        // turn complete; a steer arriving before this event stays in the same
        // agent loop and is observed at the next model boundary.
        input.stopAccepting();
        child.stdin.end();
      }
      lastEventAt = Date.now();
    };

    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        try {
          handleEvent(JSON.parse(line));
        } catch (error) {
          protocolErrors.push(
            `Invalid Claude stream-json output: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    // coder stop SIGTERMs the worker; take the claude child down with us.
    const onTerm = () => {
      input.stopAccepting();
      child.kill("SIGTERM");
      const endpoint = steerServer?.endpoint;
      if (endpoint?.startsWith("file:")) {
        fs.rmSync(endpoint.slice("file:".length), {
          recursive: true,
          force: true,
        });
      }
      process.exit(143);
    };
    process.on("SIGTERM", onTerm);

    void (async () => {
      if (options.onSteerReady) {
        steerServer = await startClaudeSteerServer((text) => input.sendSteer(text));
      }
      await input.sendInitial(options.prompt);
      // The endpoint becomes externally visible only after stdin has accepted
      // the original prompt frame, so no live steer can become frame one.
      if (steerServer) {
        options.onSteerReady?.(steerServer.endpoint);
      }
    })().catch((error) => {
      if (settled) return;
      settled = true;
      input.stopAccepting();
      child.kill("SIGTERM");
      process.removeListener("SIGTERM", onTerm);
      void steerServer?.close();
      reject(error);
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      input.stopAccepting();
      process.removeListener("SIGTERM", onTerm);
      void steerServer?.close();
      reject(new Error(`claude spawn failed: ${(error as NodeJS.ErrnoException).message}`));
    });
    child.on("close", async (code) => {
      if (settled) return;
      settled = true;
      input.stopAccepting();
      process.removeListener("SIGTERM", onTerm);
      await steerServer?.close();
      const tail = buffer.trim();
      if (tail) {
        try {
          handleEvent(JSON.parse(tail));
        } catch (error) {
          protocolErrors.push(
            `Invalid trailing Claude stream-json output: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const finalMessage = resultEvent?.result ?? "";
      // No result event means the turn never completed (sandbox init failure,
      // auth error printed to stderr); treat that as failed too.
      const failed = code !== 0 || resultEvent?.is_error === true || resultEvent == null || protocolErrors.length > 0;
      resolve({
        status: failed ? 1 : 0,
        threadId: resultEvent?.session_id ?? streamSessionId,
        turnId: null,
        finalMessage,
        tokens: normalizeClaudeUsage(resultEvent?.usage),
        // modelUsage is keyed by the actual model id(s) that served the turn.
        model: (resultEvent?.modelUsage && Object.keys(resultEvent.modelUsage).join("+")) || options.model || null,
        error: failed
          ? {
              message: protocolErrors[0] || finalMessage || stderr.trim() || `claude exited ${code}`,
            }
          : null,
      });
    });
  });
}
