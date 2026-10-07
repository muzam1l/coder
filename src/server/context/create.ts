import { randomBytes } from 'node:crypto';
import process from 'node:process';

import { enabledIntegrations } from '../../integrations';
import { createRunners } from '../runners';
import { nearestRegion } from '../runners/vercel-sandbox';
import type { RunnerKind } from '../../agent/types';
import { CoderError } from '../../core/dispatch';
import { seedBuiltinAgents } from '../agents/records';
import { remoteAgentLoader } from '../agents/repo';
import { migrationStatus } from '../store/pg/migrate';
import { loadServerConfig } from '../env';
import { handleRequest } from '../routes';
import { DashboardHosts } from '../dash/serve';
import { ServerLimits } from '../limits';
import { sql } from 'drizzle-orm';
import { runner as runnerTable } from '../store/pg/schema';
import { createBackend } from '../store';
import { recoverLocalTasks, stopLocalTasks, syncLocalUsage } from '../tasks/local';
import type { ServerContext, ServerConfig } from '.';

interface ContextOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  host?: 'node' | 'vercel';
  runner?: RunnerKind;
  /** Serve the CLI on this machine: its config, agents and tasks. */
  local?: ServerContext['local'];
}

export interface Contexts {
  config: ServerConfig;
  context(organizationId: string): ServerContext;
  defaultContext: ServerContext;
  warnings: string[];
  mintedToken?: string;
  sweep(batch?: number): Promise<void>;
  close(): Promise<void>;
}

/** Build the shared server backend and organization-scoped request contexts. */
export async function createContext(options: ContextOptions = {}): Promise<Contexts> {
  const env = options.env ?? process.env;
  const base = loadServerConfig(env, options.host ?? 'node');
  // The memory store is for one machine: remote runners call back and need durable state.
  const runner = options.runner ?? base.runner;
  if (
    (options.host === 'vercel' || env.VERCEL) &&
    (runner === 'local' || runner === 'local-docker')
  )
    throw new CoderError('invalid-option', `The ${runner} runner cannot run on Vercel.`, {
      hint: 'Leave RUNNER unset to use vercel-sandbox.',
    });
  if (base.store === 'memory' && runner !== 'local' && runner !== 'local-docker')
    throw new CoderError('invalid-option', `The ${runner} runner needs a database.`, {
      hint: 'Set DATABASE_URL, or use RUNNER=local for a memory server.',
    });
  if (!base.publicUrl)
    throw new CoderError('invalid-option', 'PUBLIC_URL is required to start a Coder server.', {
      hint: 'Set PUBLIC_URL to the address platforms and browsers use.',
    });

  const warnings: string[] = [];
  if (base.store === 'memory' && !options.local)
    warnings.push(
      'test server, not for production: everything is in memory, nothing survives a restart, no sign-in; set DATABASE_URL for a real deployment',
    );
  if (!env.SERVER_ENCRYPTION_KEY && !options.local)
    warnings.push(
      'secrets are stored unencrypted; set SERVER_ENCRYPTION_KEY (openssl rand -base64 32)',
    );
  if (base.store === 'postgres' && !base.encryptionKey)
    throw new CoderError(
      'invalid-option',
      'SERVER_ENCRYPTION_KEY is required for a Postgres server.',
      {
        hint: 'Set SERVER_ENCRYPTION_KEY (openssl rand -base64 32); sign-in keys derive from it.',
      },
    );

  const integrations = enabledIntegrations(base.integrations);

  const mintedToken =
    base.store === 'memory' && !base.adminToken ? randomBytes(18).toString('base64url') : undefined;
  if (base.store === 'postgres' && base.adminToken)
    warnings.push(
      'ADMIN_TOKEN is ignored with Postgres; owners and admins sign in with coder auth login',
    );

  const config: ServerConfig = {
    ...base,
    ...(base.store === 'postgres' ? { adminToken: undefined } : {}),
    ...(mintedToken ? { adminToken: mintedToken } : {}),
    ...(options.runner ? { runner: options.runner } : {}),
  };

  const backend = await createBackend(config, { local: Boolean(options.local) });
  if (backend.connection) {
    try {
      const status = await migrationStatus(backend.connection.db);
      if (!status.applied)
        throw new CoderError('server', 'The database is not set up yet.', {
          hint: 'Create the tables: coder server migrate',
        });
      if (status.pending)
        warnings.push(
          `database is ${status.pending} migration${status.pending === 1 ? '' : 's'} behind; run coder server migrate`,
        );
    } catch (error) {
      await backend.close();
      throw error;
    }
  }

  try {
    if (config.store === 'memory')
      await seedBuiltinAgents(backend.store(backend.defaultOrganizationId), Date.now());

    const auth =
      backend.connection && config.auth
        ? await (await import('../auth')).createAuth(backend.connection.db, config)
        : undefined;

    const cwd = options.cwd ?? process.cwd();
    const snapshots = backend.store(backend.defaultOrganizationId);
    const runners = createRunners({
      kind: config.runner,
      workDir: config.workDir,
      config: config.runnerConfig,
      local: !(options.host === 'vercel' || env.VERCEL),
      sandbox: {
        region: nearestRegion(config.databaseUrl),
        snapshots: {
          get: key => snapshots.get('snapshot', key),
          put: (key, value) => snapshots.put('snapshot', key, value),
        },
      },
    });
    if (!runners[config.runner]) {
      await backend.close();
      throw new CoderError('invalid-option', `Runner ${config.runner} is not configured.`, {
        hint: 'Set RUNNER_CONFIG to JSON containing url and secret.',
      });
    }

    const dashboardHosts = new DashboardHosts();
    const limits = new ServerLimits();
    const contexts = new Map<string, ServerContext>();
    const requestScopes = new Map<string, import('../routes').RequestScope>();
    const context = (organizationId: string): ServerContext => {
      const existing = contexts.get(organizationId);
      if (existing) return existing;
      const store = backend.store(organizationId);
      const value: ServerContext = {
        limits,
        ...(backend.connection
          ? {
              databaseHealth: async () => {
                await backend.connection!.db.execute(sql`select 1`);
              },
              healthRunners: async () => {
                const [counts] = await backend
                  .connection!.db.select({
                    total: sql<number>`count(*)::int`,
                    online: sql<number>`count(*) filter (where ${runnerTable.lastSeen} > clock_timestamp() - interval '5 minutes')::int`,
                  })
                  .from(runnerTable);
                return counts ?? { online: 0, total: 0 };
              },
            }
          : {}),
        config,
        settings: {},
        organizationId,
        integrations,
        runners,
        store,
        queue: backend.queue,
        requestScopes,
        dashboardHosts,
        dbProfile: backend.connection?.profile,
        chatState: backend.chatState,
        loadAgent: remoteAgentLoader(integrations, { cwd, config, store }),
        ...(auth ? { auth } : {}),
        scope: context,
        webhookTarget: (key, installationKey) => backend.webhookTarget(key, installationKey),
        appRecord: key => backend.appRecord(key),
        installationOrganization: key => backend.installationOrganization(key),
        installations: integration => backend.installations(integration),
        serverOrganizationId: backend.defaultOrganizationId,
        taskOrganization: (id, tokenHash) => backend.taskOrganization(id, tokenHash),
        ...(options.local ? { local: options.local } : {}),
      };
      contexts.set(organizationId, value);
      return value;
    };

    globalThis.__coder = {
      handle: request =>
        handleRequest(request, context(backend.defaultOrganizationId), { inProcess: true }),
    };

    const defaultContext = context(backend.defaultOrganizationId);
    let usageStart: ReturnType<typeof setImmediate> | undefined;
    if (options.local) {
      await recoverLocalTasks(defaultContext);
      // Let the host bind its listener before reading task history.
      usageStart = setImmediate(() => {
        void syncLocalUsage(defaultContext).catch(() => undefined);
      });
    }

    return {
      config,
      context,
      defaultContext,
      warnings,
      ...(mintedToken ? { mintedToken } : {}),
      sweep: backend.sweep,
      close: async () => {
        if (usageStart) clearImmediate(usageStart);
        await defaultContext.local?.usageSync?.catch(() => undefined);
        await stopLocalTasks(defaultContext);
        await backend.close();
      },
    };
  } catch (error) {
    await backend.close();
    throw error;
  }
}
