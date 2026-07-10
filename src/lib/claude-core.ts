/**
 * Claude engine over the claude CLI in print mode. Used when the host cannot
 * spawn Claude subagents itself (codex plugin, direct CLI use). Sessions are
 * assigned an id up front so jobs are steerable via --resume, mirroring codex
 * threadIds.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

import { CLAUDE_PERMISSION_FLAGS, claudeSandboxSettings } from "./config.js";
import type { AuthStatus, Availability, Effort, Permission, TurnResult } from "./types.js";

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
  resumeSessionId?: string | null;
  onProgress?: (update: { message: string; threadId?: string }) => void;
}

export interface ClaudeTurnResult extends TurnResult {
  threadId: string;
  turnId: string | null;
  finalMessage: string;
  error: { message: string } | null;
}

export async function runClaudeTurn(cwd: string, options: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const sessionId = options.resumeSessionId ?? randomUUID();
  // stream-json emits newline-delimited events (tool calls, result) as the turn
  // runs, so progress is visible instead of a single blob at the end like the
  // plain "json" format. --verbose is required for stream-json in print mode.
  const args = ["-p", options.prompt, "--output-format", "stream-json", "--verbose"];
  args.push(options.resumeSessionId ? "--resume" : "--session-id", sessionId);
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.effort) {
    args.push("--effort", options.effort);
  }
  const permissions = options.permissions ?? "auto";
  args.push(...(CLAUDE_PERMISSION_FLAGS[permissions] ?? CLAUDE_PERMISSION_FLAGS.auto));
  // Read-only is enforced by claude's OS sandbox, scoped to deny writes to this
  // workspace; passed as a settings JSON string so it needs no on-disk config.
  const sandboxSettings = claudeSandboxSettings(permissions, cwd);
  if (sandboxSettings) {
    args.push("--settings", sandboxSettings);
  }

  options.onProgress?.({ message: `claude turn started (session ${sessionId})`, threadId: sessionId });

  return new Promise((resolve, reject) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let resultEvent: any = null;
    let streamSessionId = sessionId;

    const handleEvent = (event: any) => {
      if (!event || typeof event !== "object") {
        return;
      }
      if (event.type === "system" && event.subtype === "init" && event.session_id) {
        streamSessionId = event.session_id;
      } else if (event.type === "assistant") {
        // Forward each tool call raw: name + the full untruncated input.
        for (const block of event.message?.content ?? []) {
          if (block?.type === "tool_use") {
            options.onProgress?.({
              message: `${block.name} ${JSON.stringify(block.input ?? {})}`,
              threadId: streamSessionId
            });
          }
        }
      } else if (event.type === "user") {
        // Forward tool results raw, so intermediate command output is visible.
        for (const block of event.message?.content ?? []) {
          if (block?.type === "tool_result") {
            const text = toolResultText(block.content).trim();
            if (text) {
              options.onProgress?.({ message: text, threadId: streamSessionId });
            }
          }
        }
      } else if (event.type === "result") {
        resultEvent = event;
        if (event.session_id) {
          streamSessionId = event.session_id;
        }
      }
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
        } catch {
          // Non-JSON lines (e.g. stderr warnings interleaved) are ignored.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    // coder stop SIGTERMs the worker; take the claude child down with us.
    const onTerm = () => {
      child.kill("SIGTERM");
      process.exit(143);
    };
    process.on("SIGTERM", onTerm);

    child.on("error", (error) => {
      process.removeListener("SIGTERM", onTerm);
      reject(new Error(`claude spawn failed: ${(error as NodeJS.ErrnoException).message}`));
    });
    child.on("close", (code) => {
      process.removeListener("SIGTERM", onTerm);
      const tail = buffer.trim();
      if (tail) {
        try {
          handleEvent(JSON.parse(tail));
        } catch {
          // Ignore a trailing partial line.
        }
      }
      const finalMessage = resultEvent?.result ?? "";
      // No result event means the turn never completed (sandbox init failure,
      // auth error printed to stderr); treat that as failed too.
      const failed = code !== 0 || resultEvent?.is_error === true || resultEvent == null;
      resolve({
        status: failed ? 1 : 0,
        threadId: resultEvent?.session_id ?? streamSessionId,
        turnId: null,
        finalMessage,
        error: failed
          ? { message: finalMessage || stderr.trim() || `claude exited ${code}` }
          : null
      });
    });
  });
}
