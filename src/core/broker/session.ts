import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrokerEndpoint, parseBrokerEndpoint } from './endpoint';
import { resolveStateDir } from '../state';
import { readVersion } from '../runtime';

const BROKER_STATE_FILES = { false: 'broker.json', true: 'broker-network.json' } as const;

/** A persisted broker session record for one network variant. */
export interface BrokerSession {
  endpoint: string;
  pidFile: string;
  logFile: string;
  sessionDir: string;
  pid: number | null;
  networkAccess?: boolean;
  // The CLI version and broker script that spawned this broker. A different
  // build (e.g. a globally-installed coder vs. this one) speaks a possibly
  // incompatible protocol, so its broker must never be reused. Otherwise
  // thread creation wedges. See ensureBrokerSession.
  version?: string;
  scriptPath?: string;
}

type KillProcess = (pid: number) => void;

export function createBrokerSessionDir(prefix = 'coder-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint: string) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint: string, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const ready = await new Promise<boolean>(resolve => {
      const socket = connectToEndpoint(endpoint);
      socket.on('connect', () => {
        socket.end();
        resolve(true);
      });
      socket.on('error', () => resolve(false));
    });
    if (ready) {
      return true;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return false;
}

export interface SpawnBrokerProcessOptions {
  scriptPath: string;
  cwd: string;
  endpoint: string;
  pidFile: string;
  logFile: string;
  networkAccess?: boolean;
  env?: NodeJS.ProcessEnv;
}

export function spawnBrokerProcess({
  scriptPath,
  cwd,
  endpoint,
  pidFile,
  logFile,
  networkAccess = false,
  env = process.env,
}: SpawnBrokerProcessOptions) {
  const logFd = fs.openSync(logFile, 'a');
  const child = spawn(
    process.execPath,
    [
      scriptPath,
      'serve',
      '--endpoint',
      endpoint,
      '--cwd',
      cwd,
      '--pid-file',
      pidFile,
      '--network-access',
      String(networkAccess),
    ],
    {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    },
  );
  child.unref();
  fs.closeSync(logFd);
  return child;
}

function resolveBrokerScript(): string {
  // This module is bundled into dist/cli.js, where the broker entry sits at
  // ./lib/broker.js; in an unbundled layout it sits alongside this file.
  const candidates = [
    new URL('./lib/broker.js', import.meta.url),
    new URL('./main.js', import.meta.url),
  ];
  for (const candidate of candidates) {
    const candidatePath = fileURLToPath(candidate);
    if (fs.existsSync(candidatePath)) {
      return candidatePath;
    }
  }
  throw new Error(
    'Coder broker script not found next to the runtime. Rebuild with `bun run build`.',
  );
}

function resolveBrokerStateFile(cwd: string, networkAccess = false) {
  return path.join(resolveStateDir(cwd), BROKER_STATE_FILES[networkAccess ? 'true' : 'false']);
}

export function loadBrokerSession(cwd: string, networkAccess = false): BrokerSession | null {
  const stateFile = resolveBrokerStateFile(cwd, networkAccess);
  if (!fs.existsSync(stateFile)) {
    return null;
  }

  try {
    const session = JSON.parse(fs.readFileSync(stateFile, 'utf8')) as BrokerSession;
    return (session.networkAccess ?? false) === networkAccess ? session : null;
  } catch {
    return null;
  }
}

export function saveBrokerSession(
  cwd: string,
  session: BrokerSession,
  networkAccess = session.networkAccess ?? false,
) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    resolveBrokerStateFile(cwd, networkAccess),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8',
  );
}

export function clearBrokerSession(cwd: string, networkAccess = false) {
  const stateFile = resolveBrokerStateFile(cwd, networkAccess);
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
  networkAccess?: boolean;
  killProcess?: KillProcess | null;
  createBrokerEndpoint?: (sessionDir: string, platform?: NodeJS.Platform) => string;
  platform?: NodeJS.Platform;
  scriptPath?: string;
  timeoutMs?: number;
}

export async function ensureBrokerSession(
  cwd: string,
  options: EnsureBrokerSessionOptions = {},
): Promise<BrokerSession | null> {
  const scriptPath = options.scriptPath ?? resolveBrokerScript();
  const version = readVersion();
  const networkAccess = options.networkAccess ?? false;

  const existing = loadBrokerSession(cwd, networkAccess);
  // Only reuse a broker this exact build spawned. A session left by a different
  // coder (version or script path) may speak an incompatible protocol; reusing
  // it hangs on thread creation, so tear it down and spawn our own instead.
  const ownsExisting =
    existing?.version === version &&
    existing?.scriptPath === scriptPath &&
    (existing?.networkAccess ?? false) === networkAccess;
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
      killProcess: options.killProcess ?? null,
    });
    clearBrokerSession(cwd, networkAccess);
  }

  const sessionDir = createBrokerSessionDir();
  const endpointFactory = options.createBrokerEndpoint ?? createBrokerEndpoint;
  const endpoint = endpointFactory(sessionDir, options.platform);
  const pidFile = path.join(sessionDir, 'broker.pid');
  const logFile = path.join(sessionDir, 'broker.log');

  const child = spawnBrokerProcess({
    scriptPath,
    cwd,
    endpoint,
    pidFile,
    logFile,
    networkAccess,
    env: options.env ?? process.env,
  });

  const ready = await waitForBrokerEndpoint(endpoint, options.timeoutMs ?? 2000);
  if (!ready) {
    teardownBrokerSession({
      endpoint,
      pidFile,
      logFile,
      sessionDir,
      pid: child.pid ?? null,
      killProcess: options.killProcess ?? null,
    });
    return null;
  }

  const session: BrokerSession = {
    endpoint,
    pidFile,
    logFile,
    sessionDir,
    pid: child.pid ?? null,
    networkAccess,
    version,
    scriptPath,
  };
  saveBrokerSession(cwd, session, networkAccess);
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
  killProcess = null,
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
      if (target.kind === 'unix' && fs.existsSync(target.path)) {
        fs.unlinkSync(target.path);
      }
    } catch {
      // Ignore malformed or already-removed broker endpoints during teardown.
    }
  }

  const resolvedSessionDir =
    sessionDir ?? (pidFile ? path.dirname(pidFile) : logFile ? path.dirname(logFile) : null);
  if (resolvedSessionDir && fs.existsSync(resolvedSessionDir)) {
    try {
      fs.rmdirSync(resolvedSessionDir);
    } catch {
      // Ignore non-empty or missing directories.
    }
  }
}

export const brokerLifecycleTestInternals = { resolveBrokerStateFile };
