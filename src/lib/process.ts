import { spawnSync } from "node:child_process";
import process from "node:process";

import type { Availability } from "./types.js";

/** Options accepted by runCommand and friends. */
export interface RunCommandOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  maxBuffer?: number;
  stdio?: import("node:child_process").StdioOptions;
}

/** The normalized result of a spawnSync call. */
export interface CommandResult {
  command: string;
  args: string[];
  status: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: (Error & { code?: string }) | null;
}

export function runCommand(command: string, args: string[] = [], options: RunCommandOptions = {}): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    input: options.input,
    maxBuffer: options.maxBuffer,
    stdio: options.stdio ?? "pipe",
    shell: process.platform === "win32" ? (process.env.SHELL || true) : false,
    windowsHide: true
  });

  return {
    command,
    args,
    status: result.status ?? 0,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ?? null
  };
}

export function runCommandChecked(command: string, args: string[] = [], options: RunCommandOptions = {}): CommandResult {
  const result = runCommand(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(formatCommandFailure(result));
  }
  return result;
}

export function binaryAvailable(
  command: string,
  versionArgs: string[] = ["--version"],
  options: RunCommandOptions = {}
): Availability {
  const result = runCommand(command, versionArgs, options);
  if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") {
    return { available: false, detail: "not found" };
  }
  if (result.error) {
    return { available: false, detail: result.error.message };
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.status}`;
    return { available: false, detail };
  }
  return { available: true, detail: result.stdout.trim() || result.stderr.trim() || "ok" };
}

function looksLikeMissingProcessMessage(text: string) {
  return /not found|no running instance|cannot find|does not exist|no such process/i.test(text);
}

export interface TerminateProcessOptions {
  platform?: NodeJS.Platform;
  runCommandImpl?: typeof runCommand;
  killImpl?: (pid: number, signal?: NodeJS.Signals | number) => void;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

export interface TerminateProcessResult {
  attempted: boolean;
  delivered: boolean;
  method: string | null;
  result?: CommandResult;
}

export function terminateProcessTree(
  pid: number | null | undefined,
  options: TerminateProcessOptions = {}
): TerminateProcessResult {
  if (!Number.isFinite(pid)) {
    return { attempted: false, delivered: false, method: null };
  }
  const targetPid = pid as number;

  const platform = options.platform ?? process.platform;
  const runCommandImpl = options.runCommandImpl ?? runCommand;
  const killImpl = options.killImpl ?? process.kill.bind(process);

  if (platform === "win32") {
    const result = runCommandImpl("taskkill", ["/PID", String(targetPid), "/T", "/F"], {
      cwd: options.cwd,
      env: options.env
    });

    if (!result.error && result.status === 0) {
      return { attempted: true, delivered: true, method: "taskkill", result };
    }

    const combinedOutput = `${result.stderr}\n${result.stdout}`.trim();
    if (!result.error && looksLikeMissingProcessMessage(combinedOutput)) {
      return { attempted: true, delivered: false, method: "taskkill", result };
    }

    if (result.error?.code === "ENOENT") {
      try {
        killImpl(targetPid);
        return { attempted: true, delivered: true, method: "kill" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "kill" };
        }
        throw error;
      }
    }

    if (result.error) {
      throw result.error;
    }

    throw new Error(formatCommandFailure(result));
  }

  try {
    killImpl(-targetPid, "SIGTERM");
    return { attempted: true, delivered: true, method: "process-group" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ESRCH") {
      try {
        killImpl(targetPid, "SIGTERM");
        return { attempted: true, delivered: true, method: "process" };
      } catch (innerError) {
        if ((innerError as NodeJS.ErrnoException)?.code === "ESRCH") {
          return { attempted: true, delivered: false, method: "process" };
        }
        throw innerError;
      }
    }

    return { attempted: true, delivered: false, method: "process-group" };
  }
}

export function formatCommandFailure(result: CommandResult) {
  const parts = [`${result.command} ${result.args.join(" ")}`.trim()];
  if (result.signal) {
    parts.push(`signal=${result.signal}`);
  } else {
    parts.push(`exit=${result.status}`);
  }
  const stderr = (result.stderr || "").trim();
  const stdout = (result.stdout || "").trim();
  if (stderr) {
    parts.push(stderr);
  } else if (stdout) {
    parts.push(stdout);
  }
  return parts.join(": ");
}
