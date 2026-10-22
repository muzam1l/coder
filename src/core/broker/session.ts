import fs from 'node:fs';
import { watchChanges } from '../../utils/fsx';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { engineEnvironment } from '../connections';
import { fileURLToPath } from 'node:url';
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

function createBrokerSessionDir(prefix = 'coder-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function connectToEndpoint(endpoint: string) {
  const target = parseBrokerEndpoint(endpoint);
  return net.createConnection({ path: target.path });
}

export async function waitForBrokerEndpoint(endpoint: string, timeoutMs = 2000) {
  const target = parseBrokerEndpoint(endpoint);
  return Boolean(
    await watchChanges(path.dirname(target.path)).until(
      () =>
        new Promise<true | undefined>(resolve => {
          const socket = connectToEndpoint(endpoint);
          socket.on('connect', () => {
            socket.end();
            resolve(true);
          });
          socket.on('error', () => resolve(undefined));
        }),
      timeoutMs,
      undefined,
      target.kind === 'pipe' ? 250 : 1000,
    ),
  );
}

interface SpawnBrokerProcessOptions {
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
      env: {
        ...engineEnvironment(env),
        ...(env.CODER_CONNECTION_ENV_VALUES
          ? { CODER_CONNECTION_ENV_VALUES: env.CODER_CONNECTION_ENV_VALUES }
          : {}),
      },
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

function resolveBrokerStateFile(cwd: string, networkAccess = false, connectionKey?: string) {
  const file = BROKER_STATE_FILES[networkAccess ? 'true' : 'false'];

  return path.join(
    resolveStateDir(cwd),
    connectionKey ? file.replace('.json', `-${connectionKey}.json`) : file,
  );
}

export function loadBrokerSession(
  cwd: string,
  networkAccess = false,
  connectionKey?: string,
): BrokerSession | null {
  const stateFile = resolveBrokerStateFile(cwd, networkAccess, connectionKey);
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

export function listBrokerSessions(cwd: string): BrokerSession[] {
  const stateDir = resolveStateDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(stateDir);
  } catch {
    return [];
  }

  return files.flatMap(file => {
    if (!/^broker(?:-network)?(?:-[a-f0-9]{64})?\.json$/.test(file)) return [];
    try {
      const session = JSON.parse(
        fs.readFileSync(path.join(stateDir, file), 'utf8'),
      ) as BrokerSession;

      return typeof session.endpoint === 'string' ? [session] : [];
    } catch {
      return [];
    }
  });
}

export function saveBrokerSession(
  cwd: string,
  session: BrokerSession,
  networkAccess = session.networkAccess ?? false,
  connectionKey?: string,
) {
  const stateDir = resolveStateDir(cwd);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(
    resolveBrokerStateFile(cwd, networkAccess, connectionKey),
    `${JSON.stringify(session, null, 2)}\n`,
    'utf8',
  );
}

export function clearBrokerSession(cwd: string, networkAccess = false, connectionKey?: string) {
  const stateFile = resolveBrokerStateFile(cwd, networkAccess, connectionKey);
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

interface EnsureBrokerSessionOptions {
  env?: NodeJS.ProcessEnv;
  connectionKey?: string;
  networkAccess?: boolean;
  killProcess?: KillProcess | null;
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

  const existing = loadBrokerSession(cwd, networkAccess, options.connectionKey);
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
    clearBrokerSession(cwd, networkAccess, options.connectionKey);
  }

  const sessionDir = createBrokerSessionDir();
  const endpoint = createBrokerEndpoint(sessionDir);
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
  saveBrokerSession(cwd, session, networkAccess, options.connectionKey);
  return session;
}

interface TeardownBrokerSessionOptions {
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

function sanitizePipeName(value: string) {
  return String(value ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '-')
    .replace(/^-+|-+$/g, '');
}

type BrokerEndpointKind = 'pipe' | 'unix';

interface BrokerEndpointTarget {
  kind: BrokerEndpointKind;
  path: string;
}

export function createBrokerEndpoint(sessionDir: string): string {
  if (process.platform === 'win32') {
    const pipeName = sanitizePipeName(`${path.win32.basename(sessionDir)}-codex-app-server`);
    return `pipe:\\\\.\\pipe\\${pipeName}`;
  }

  return `unix:${path.join(sessionDir, 'broker.sock')}`;
}

export function parseBrokerEndpoint(endpoint: string | null | undefined): BrokerEndpointTarget {
  if (typeof endpoint !== 'string' || endpoint.length === 0) {
    throw new Error('Missing broker endpoint.');
  }

  if (endpoint.startsWith('pipe:')) {
    const pipePath = endpoint.slice('pipe:'.length);
    if (!pipePath) {
      throw new Error('Broker pipe endpoint is missing its path.');
    }
    return { kind: 'pipe', path: pipePath };
  }

  if (endpoint.startsWith('unix:')) {
    const socketPath = endpoint.slice('unix:'.length);
    if (!socketPath) {
      throw new Error('Broker Unix socket endpoint is missing its path.');
    }
    return { kind: 'unix', path: socketPath };
  }

  throw new Error(`Unsupported broker endpoint: ${endpoint}`);
}
