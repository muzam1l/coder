import path from 'node:path';

import { resolveStateDir } from '../../core/state';
import type { ServerConfig } from '../context';
import type { Connection } from './pg/client';
import { StoreQueue } from '../tasks/queue';
import { LocalChatState } from './chat';
import { LocalStore } from './local';
import { MemoryStore } from './memory';
import type { Backend } from '.';

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

/** A local server's files, or memory for a throwaway test server. */
export function memoryBackend(local?: boolean): Backend {
  const store = local ? new LocalStore() : new MemoryStore();

  return {
    store: () => store,
    queue: new StoreQueue(store),
    chatState: new LocalChatState(local ? path.join(resolveStateDir(''), 'chat.json') : undefined),
    defaultOrganizationId: DEFAULT_ORGANIZATION,
    webhookTarget: async (key, installationKey) => {
      const app = await store.get('app', key);
      const installation = installationKey
        ? await store.get('installation', installationKey)
        : undefined;
      if (app && installationKey && (!installation || installation.deletedAt))
        for (const { value: sharing } of await store.list('app', { prefix: `${key}/` })) {
          const bound = await store.get(
            'installation',
            `${sharing.id}${installationKey.slice(key.length)}`,
          );
          if (bound && !bound.deletedAt)
            return {
              organizationId: DEFAULT_ORGANIZATION,
              app: sharing,
              bound: { organizationId: DEFAULT_ORGANIZATION, installation: bound },
            };
        }

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
    apps: async integration =>
      (await store.list('app', { prefix: `${integration}:` })).map(entry => ({
        organizationId: DEFAULT_ORGANIZATION,
        app: entry.value,
      })),
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

export async function postgresBackend(config: ServerConfig): Promise<Backend> {
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
    apps: integration => DrizzleStore.apps(connection.db, integration),
    installationOrganization: key => DrizzleStore.installationOrganization(connection.db, key),
    installations: integration => DrizzleStore.installations(connection.db, integration),
    taskOrganization: (id, tokenHash) =>
      DrizzleStore.taskOrganization(connection.db, id, tokenHash),
    connection,
    sweep: batch => new DrizzleStore(connection.db, UNSCOPED_ORGANIZATION).sweep(batch),
    close: () => connection.close(),
  };
}
