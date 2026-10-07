import path from 'node:path';

import type { StateAdapter } from 'chat';

import type { AgentApp, Installation } from '../../agent/types';

import { resolveStateDir } from '../../core/state';
import type { ServerConfig } from '../context';
import type { Connection } from './pg/client';
import { StoreQueue, type TaskQueue } from '../tasks/queue';
import { LocalChatState } from './chat';
import { LocalStore } from './local';
import { MemoryStore } from './memory';
import type { Store, MetadataKind } from './types';

/** Organization id for stores that have no tenancy (memory, file). */
const DEFAULT_ORGANIZATION = 'default';

/** Each backend owns its pool and drains it when the server closes. */
export async function database(
  config: Pick<ServerConfig, 'databaseUrl' | 'databasePool'>,
): Promise<Connection> {
  if (!config.databaseUrl) throw new Error('DATABASE_URL is required for the Postgres store');
  const { connect } = await import('./pg/client');
  return connect(config.databaseUrl, config.databasePool);
}

/** Everything a server needs from its database: a store per organization and the queue. */
export interface Backend {
  store(organizationId: string): Store;
  queue: TaskQueue;
  /** Chat SDK state shared by every app; `appChatState` gives each its own keys. */
  chatState: StateAdapter;
  defaultOrganizationId: string;
  /** An app record and the organization owning it, in one lookup; webhooks find their tenant and secret this way. */
  webhookTarget(
    appKey: string,
    installationKey?: string,
  ): Promise<
    | {
        organizationId: string;
        app: AgentApp;
        bound?: { organizationId: string; installation: Installation };
      }
    | undefined
  >;
  appRecord(appKey: string): Promise<{ organizationId: string; app: AgentApp } | undefined>;
  /** Which workspace an installation is bound to; webhooks route by it. */
  installationOrganization(key: string): Promise<string | undefined>;
  /** Live installations of one integration in every workspace, for the sweep. */
  installations(integration: string): Promise<Array<{ key: string; organizationId: string }>>;
  /** Which organization owns a task with this current attempt token hash. */
  taskOrganization(taskId: string, tokenHash: string): Promise<string | undefined>;
  /** The database connection; absent for the memory store. */
  connection?: Connection;
  sweep(batch?: number): Promise<void>;
  close(): Promise<void>;
}

/** Postgres, a local server's files, or memory for a throwaway test server. */
export async function createBackend(
  config: ServerConfig,
  options: { local?: boolean } = {},
): Promise<Backend> {
  if (config.store !== 'postgres') {
    const store = options.local ? new LocalStore() : new MemoryStore();

    return {
      store: () => store,
      queue: new StoreQueue(store),
      chatState: new LocalChatState(
        options.local ? path.join(resolveStateDir(''), 'chat.json') : undefined,
      ),
      defaultOrganizationId: DEFAULT_ORGANIZATION,
      webhookTarget: async (key, installationKey) => {
        const app = await store.get('app', key);
        const installation = installationKey
          ? await store.get('installation', installationKey)
          : undefined;

        return (
          app && {
            organizationId: DEFAULT_ORGANIZATION,
            app,
            ...(installation && installation.app === key && !installation.deletedAt
              ? { bound: { organizationId: DEFAULT_ORGANIZATION, installation } }
              : {}),
          }
        );
      },
      appRecord: async key => {
        const app = await store.get('app', key);

        return app && { organizationId: DEFAULT_ORGANIZATION, app };
      },
      installationOrganization: async key =>
        (await store.get('installation', key)) ? DEFAULT_ORGANIZATION : undefined,
      installations: async integration =>
        (await store.list('installation', { prefix: `${integration}:` }))
          .filter(entry => !entry.value.deletedAt)
          .map(entry => ({ key: entry.id, organizationId: DEFAULT_ORGANIZATION })),
      taskOrganization: async (id, tokenHash) =>
        (await store.get('task', id))?.tokenHash === tokenHash ? DEFAULT_ORGANIZATION : undefined,
      sweep: async () => {},
      close: async () => {},
    };
  }

  const connection = await database(config);
  const [{ DrizzleStore }, { DrizzleQueue }, { UNSCOPED_ORGANIZATION }, { PgChatState }] =
    await Promise.all([
      import('./pg/store'),
      import('./pg/queue'),
      import('./pg/tables/shared'),
      import('./pg/chat'),
    ]);
  const queue = new DrizzleQueue(connection.db);

  return {
    store: organizationId => new DrizzleStore(connection.db, organizationId, Date.now, config),
    queue,
    chatState: new PgChatState(connection.db),
    defaultOrganizationId: UNSCOPED_ORGANIZATION,
    webhookTarget: (key, installationKey) =>
      DrizzleStore.webhookTarget(connection.db, key, installationKey),
    appRecord: key => DrizzleStore.appRecord(connection.db, key),
    installationOrganization: key => DrizzleStore.installationOrganization(connection.db, key),
    installations: integration => DrizzleStore.installations(connection.db, integration),
    taskOrganization: (id, tokenHash) =>
      DrizzleStore.taskOrganization(connection.db, id, tokenHash),
    connection,
    sweep: batch => new DrizzleStore(connection.db, UNSCOPED_ORGANIZATION).sweep(batch),
    close: () => connection.close(),
  };
}

/** The memory store, or an unscoped Postgres store for low-level callers. */
export async function createStore(
  config: ServerConfig,
): Promise<Store & { close(): Promise<void> }> {
  const backend = await createBackend(config);
  return Object.assign(backend.store(backend.defaultOrganizationId), { close: backend.close });
}

export async function updateMetadata(
  store: Store,
  kind: MetadataKind,
  id: string,
  fields: Record<string, unknown>,
): Promise<boolean> {
  if (store.updateMetadata) return store.updateMetadata(kind, id, fields);

  const current = await store.get(kind, id);
  if (!current) return false;

  await store.put(kind, id, { ...current, ...fields });

  return true;
}

export async function getApps(
  store: Store,
  keys: string[],
): Promise<Array<{ id: string; value: AgentApp }>> {
  const unique = [...new Set(keys)];
  if (store.getApps) return store.getApps(unique);

  const apps = await Promise.all(
    unique.map(async id => ({ id, value: await store.get('app', id) })),
  );

  return apps.filter((row): row is { id: string; value: AgentApp } => Boolean(row.value));
}
