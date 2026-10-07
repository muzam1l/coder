import http from 'node:http';
import process from 'node:process';

import type { RunnerKind } from '../agent/types';
import { CoderError } from '../core/dispatch';
import { migrateCache, type CacheMigration } from '../core/cache';
import type { ServerContext } from './context';
import { createContext, type Contexts } from './context/create';
import { kick } from './tasks/kick';
import { flushInbox } from './tasks/queue';
import { requireBunServer } from './env';
import { handleRequest } from './routes';
import { LOOPBACK, serverMode, socketAllowed, type ServerMode } from './routes/guards';
import { bodyLimit, nodeListener } from './routes/http';
import { RUNNER_KINDS } from './runners';
import { describeDatabase } from './store/pg/migrate';

const SWEEP_MS = 60 * 60 * 1000;

function loopbackPort(publicUrl?: string): number | undefined {
  try {
    const url = new URL(publicUrl!);
    return LOOPBACK.has(url.hostname)
      ? Number(url.port || (url.protocol === 'https:' ? 443 : 80))
      : undefined;
  } catch {
    return undefined;
  }
}

/** Serverless request handler with a lazily initialized, reused backend. */
export function serverHandler(
  env: Record<string, string | undefined> = process.env,
  host: 'node' | 'vercel' = env.VERCEL ? 'vercel' : 'node',
): {
  (request: Request, waitUntil?: (work: Promise<unknown>) => void): Promise<Response>;
  scheduled(): Promise<void>;
  close(): Promise<void>;
} {
  requireBunServer();

  let pending: Promise<Contexts> | undefined;

  const getContext = () =>
    (pending ??= createContext({ env, host }).catch(error => {
      pending = undefined;
      throw error;
    }));

  const handler = async (request: Request, waitUntil?: (work: Promise<unknown>) => void) => {
    const server = await getContext();
    const background = waitUntil
      ? (work: Promise<unknown>) => waitUntil(work)
      : (work: Promise<unknown>) => void work.catch(() => {});
    const requestContext = (organizationId: string): ServerContext => ({
      ...server.context(organizationId),
      waitUntil: background,
      scope: requestContext,
    });
    const context = requestContext(server.defaultContext.organizationId);
    const clientIp = env.VERCEL
      ? request.headers.get('x-forwarded-for')?.split(',', 1)[0]?.trim()
      : undefined;
    return handleRequest(request, context, { clientIp });
  };
  return Object.assign(handler, {
    scheduled: async () => {
      const server = await getContext();
      await Promise.all([
        server.sweep(),
        import('./chat').then(chat => chat.renewInstallations(server.defaultContext)),
        kick(server.defaultContext, false, true),
        flushInbox(server.defaultContext),
      ]);
    },
    close: async () => {
      const server = pending;
      pending = undefined;
      await (await server)?.close();
    },
  });
}

export interface ServeOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  port?: number;
  /** Interface to listen on: 127.0.0.1 by default without a database, else every interface. */
  host?: string;
  /** A throwaway test server that keeps everything in memory. */
  memory?: boolean;
  runner?: RunnerKind;
}

export interface ServeResult {
  address: string;
  publicUrl: string;
  warnings: string[];
  close(): Promise<void>;
}

export type ServeDetails = ServeResult & {
  runner: RunnerKind;
  store: 'memory' | 'postgres';
  mode: ServerMode;
  cacheMigration?: Promise<CacheMigration>;
  maxTasks: number;
  signIn?: string;
  mintedToken?: string;
  /** Where DATABASE_URL points. */
  database?: string;
  /** The dashboard link, with the memory server's token, when the server is on this machine. */
  dashboard?: string;
};

/** Start the HTTP host. Returns after listening; never prints or installs signal handlers. */
async function startServer(options: ServeOptions = {}): Promise<ServeDetails> {
  requireBunServer();
  const given = options.env ?? process.env;

  if (options.runner && !RUNNER_KINDS.includes(options.runner))
    throw new CoderError(
      'invalid-option',
      `Invalid --runner value: use ${RUNNER_KINDS.join(', ')}`,
    );
  if (
    options.port !== undefined &&
    (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535)
  )
    throw new CoderError('invalid-option', 'Invalid port: use 1 through 65535.');

  const envPort = given.PORT && /^\d+$/.test(given.PORT) ? Number(given.PORT) : undefined;
  const publicPort = loopbackPort(given.PUBLIC_URL);
  const port = options.port ?? envPort ?? publicPort ?? 8787;
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new CoderError('invalid-option', 'Invalid PORT: use 1 through 65535.');

  // Without PUBLIC_URL the server is reached where it listens.
  const env = given.PUBLIC_URL ? given : { ...given, PUBLIC_URL: `http://localhost:${port}` };

  const database = Boolean(given.DATABASE_URL || given.POSTGRES_URL);
  if (database && options.memory)
    throw new CoderError('invalid-option', 'A memory server cannot use DATABASE_URL.', {
      hint: 'Unset DATABASE_URL, or drop --memory.',
    });

  const bind = (options.host ?? given.HOST ?? (database ? undefined : '127.0.0.1'))?.replace(
    /^\[(.*)\]$/,
    '$1',
  );
  const local = !database && !options.memory;
  if (local && !LOOPBACK.has(bind!))
    throw new CoderError('invalid-option', 'A local server listens on loopback only.', {
      hint: 'Reach it through a tunnel or a proxy on this machine; set DATABASE_URL for a deployment, or use --memory for a test server.',
    });

  if (options.memory && given.VERCEL)
    throw new CoderError('invalid-option', 'A memory server cannot run on Vercel.', {
      hint: 'Set DATABASE_URL for a real deployment.',
    });

  let startCache: (() => void) | undefined;
  let rejectCache: ((error: unknown) => void) | undefined;
  const cacheMigration = local
    ? new Promise<CacheMigration>((resolve, reject) => {
        rejectCache = reject;
        startCache = () => {
          void migrateCache().then(resolve, reject);
        };
      })
    : undefined;
  const cacheMaintenance = cacheMigration?.then(() => undefined).catch(() => undefined);
  const localOptions = local
    ? { cwd: options.cwd ?? process.cwd(), port, cacheMaintenance }
    : undefined;
  const host = await createContext({
    cwd: options.cwd,
    env,
    runner: options.runner,
    ...(localOptions ? { local: localOptions } : {}),
  });
  const context = host.defaultContext;

  const sweep = () => {
    void host.sweep().catch(() => {});
    void import('./chat').then(chat => chat.renewInstallations(context)).catch(() => {});
  };
  sweep();
  const sweepTimer = setInterval(sweep, SWEEP_MS);
  sweepTimer.unref();

  const kickTimer = setInterval(() => {
    void kick(context, false, true).catch(() => {});
    void flushInbox(context).catch(() => {});
    if (!given.PUBLIC_URL)
      void import('./chat').then(chat => chat.renewInstallations(context, 'sync')).catch(() => {});
  }, 60_000);
  kickTimer.unref();

  const listener = http.createServer(
    nodeListener((request, clientIp) => handleRequest(request, context, { clientIp }), {
      limit: bodyLimit,
      admit: incoming =>
        database || socketAllowed(incoming.socket.remoteAddress, incoming.url ?? '/'),
    }),
  );

  const publicUrl = host.config.publicUrl!;
  if (publicPort !== undefined && publicPort !== port)
    host.warnings.push(`PUBLIC_URL points at port ${publicPort} but the server listens on ${port}`);

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, bind, resolve);
  }).catch(async error => {
    rejectCache?.(error);
    clearInterval(kickTimer);
    clearInterval(sweepTimer);
    await host.close();
    throw error;
  });

  const cacheStart = startCache ? setTimeout(startCache, 0) : undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    clearInterval(kickTimer);
    clearInterval(sweepTimer);
    await new Promise<void>((resolve, reject) =>
      listener.close(error => (error ? reject(error) : resolve())),
    );
    await cacheMaintenance;
    if (cacheStart) clearTimeout(cacheStart);
    await host.close();
  };
  const signIn = context.auth ? `Wular Auth (${context.auth.issuer})` : undefined;
  const address = `http://localhost:${port}`;
  const mode = serverMode(context);
  const home = mode === 'local' ? address : publicUrl;
  const token =
    host.config.store === 'memory' ? (host.mintedToken ?? given.ADMIN_TOKEN) : undefined;

  return {
    address,
    publicUrl,
    warnings: host.warnings,
    close,
    runner: host.config.runner,
    store: host.config.store,
    mode,
    ...(cacheMigration ? { cacheMigration } : {}),
    maxTasks: host.config.maxTasks ?? host.config.limits?.concurrentTasks ?? 10,
    ...(signIn ? { signIn } : {}),
    ...(host.mintedToken ? { mintedToken: host.mintedToken } : {}),
    ...(host.config.store === 'postgres' && given.DATABASE_URL
      ? { database: describeDatabase(given.DATABASE_URL) }
      : {}),
    ...(LOOPBACK.has(new URL(home).hostname)
      ? { dashboard: `${home}/dash${token ? `#token=${encodeURIComponent(token)}` : ''}` }
      : {}),
  };
}

export async function serve(options: ServeOptions = {}): Promise<ServeDetails> {
  try {
    return await startServer(options);
  } catch (error) {
    if (error instanceof CoderError) throw error;
    // Wrapped driver errors (drizzle's "Failed query") carry the real reason in `cause`.
    const cause =
      error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    throw new CoderError(
      'server',
      `${error instanceof Error ? error.message : String(error)}${cause}`,
    );
  }
}
