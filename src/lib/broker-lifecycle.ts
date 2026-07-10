import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createBrokerEndpoint, parseBrokerEndpoint } from "./broker-endpoint.js";
import { resolveStateDir } from "./state.js";
import { readVersion } from "./runtime.js";

const BROKER_STATE_FILE = "broker.json";

/** A persisted broker session record (broker.json). */
export interface BrokerSession {
  endpoint: string;
  pidFile: string;
  logFile: string;
  sessionDir: string;
  pid: number | null;
  // The CLI version and broker script that spawned this broker. A different
  // build (e.g. a globally-installed coder vs. this one) speaks a possibly
  // incompatible protocol, so its broker must never be reused — otherwise
  // thread creation wedges. See ensureBrokerSession.
  version?: string;
  scriptPath?: string;
}

type KillProcess = (pid: number) => void;

export function createBrokerSessionDir(prefix = "coder-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint: string) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint: string, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = connectToEndpoint(endpoint);
      socket.on("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.on("error", () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

export async function sendBrokerShutdown(endpoint: string) {
  await new Promise<void>((resolve) => {
    const socket = connectToEndpoint(endpoint);
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify({ id: 1, method: "broker/shutdown", params: {} })}\n`);
    });
    socket.on("data", () => {
      socket.end();
      resolve();
    });
    socket.on("error", resolve);
    socket.on("close", resolve);
  });
}

export interface SpawnBrokerProcessOptions {
  scriptPath: string;
  cwd: string;
  endpoint: string;
  pidFile: string;
  logFile: string;
  env?: NodeJS.ProcessEnv;
}

export function spawnBrokerProcess({ scriptPath, cwd, endpoint, pidFile, logFile, env = process.env }: SpawnBrokerProcessOptions) {
  const logFd = fs.openSync(logFile, "a");
  const child = spawn(process.execPath, [scriptPath, "serve", "--endpoint", endpoint, "--cwd", cwd, "--pid-file", pidFile], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd]
  });
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerScript(): string {
  // This module is bundled into dist/cli.js, where the broker entry sits at
  // ./lib/broker.js; in an unbundled layout it sits alongside this file.
  const candidates = [new URL("./lib/broker.js", import.meta.url), new URL("./broker.js", import.meta.url)];
  for (const candidate of candidates) {
    const candidatePath = fileURLToPath(candidate);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  throw new Error("Coder broker script not found next to the runtime. Rebuild with `bun run build`.");
}

function resolveBrokerStateFile(cwd: string) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILE);
}

export function loadBrokerSession(cwd: string): BrokerSession | null {
  const stateFile = resolveBrokerStateFile(cwd);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(stateFile, "utf8")) as BrokerSession;
  } catch {
    return null;
  }
}

export function saveBrokerSession(cwd: string, session: BrokerSession) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(resolveBrokerStateFile(cwd), `${JSON.stringify(session, null, 2)}\n`, "utf8");
}

export function clearBrokerSession(cwd: string) {
  const stateFile = resolveBrokerStateFile(cwd);
  if (fs.existsSync(stateFile)) {
    fs.unlinkSync(stateFile);
  }
}

async function isBrokerEndpointReady(endpoint: string | null | undefined) {
  if (!endpoint) {
    return false;
  }
  try {
    return await waitForBrokerEndpoint(endpoint, 150);
  } catch {
    return false;
  }
}

export interface EnsureBrokerSessionOptions {
  env?: NodeJS.ProcessEnv;
  killProcess?: KillProcess | null;
  createBrokerEndpoint?: (sessionDir: string, platform?: NodeJS.Platform) => string;
  platform?: NodeJS.Platform;
  scriptPath?: string;
  timeoutMs?: number;
}

export async function ensureBrokerSession(
  cwd: string,
  options: EnsureBrokerSessionOptions = {}
): Promise<BrokerSession | null> {
  const scriptPath = options.scriptPath ?? resolveBrokerScript();
  const version = readVersion();

  const existing = loadBrokerSession(cwd);
  // Only reuse a broker this exact build spawned. A session left by a different
  // coder (version or script path) may speak an incompatible protocol; reusing
  // it hangs on thread creation, so tear it down and spawn our own instead.
  const ownsExisting =
    existing?.version === version && existing?.scriptPath === scriptPath;
  if (existing && ownsExisting && (await isBrokerEndpointReady(existing.endpoint))) {
    return existing;
  }

  if (existing) {
    teardownBrokerSession({
      endpoint: existing.endpoint ?? null,
      pidFile: existing.pidFile ?? null,
      logFile: existing.logFile ?? null,
      sessionDir: existing.sessionDir ?? null,
      pid: existing.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    clearBrokerSession(cwd);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, "broker.pid");
  const logFile = path.join(sessionDir, "broker.log");

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    env: options.env ?? process.env
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null
    });
    return null;
  }

  const session: BrokerSession = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    version,
    scriptPath
  };
  saveBrokerSession(cwd, session);
  return session;
}

export interface TeardownBrokerSessionOptions {
  endpoint?: string | null;
  pidFile?: string | null;
  logFile?: string | null;
  sessionDir?: string | null;
  pid?: number | null;
  killProcess?: KillProcess | null;
}

export function teardownBrokerSession({
  endpoint = null,
  pidFile,
  logFile,
  sessionDir = null,
  pid = null,
  killProcess = null
}: TeardownBrokerSessionOptions) {
  if (Number.isFinite(pid) && killProcess) {
    try {
      killProcess(pid as number);
    } catch {
      // Ignore missing or already-exited broker processes.
    }
  }

  if (pidFile && fs.existsSync(pidFile)) {
    fs.unlinkSync(pidFile);
  }

  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }

  if (endpoint) {
    try {
      const target = parseBrokerEndpoint(endpoint);
      if (target.kind === "unix" && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir = sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}
