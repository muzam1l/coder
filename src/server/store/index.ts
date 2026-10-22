import type { StateAdapter } from 'chat';

import type { AgentApp, Installation } from '../../agent/types';

import type { ServerConfig } from '../context';
import type { Connection } from './pg/client';
import type { TaskQueue } from '../tasks/queue';
import { memoryBackend, postgresBackend } from './backend';
import type { Store, MetadataKind } from './types';

export { database } from './backend';

/** Everything a server needs from its database: a store per organization and the queue. */
export interface Backend {
  store(organizationId: string): Store;
  queue: TaskQueue;
  /** Chat SDK state shared by every app; `appChatState` gives each its own keys. */
  chatState: StateAdapter;
  defaultOrganizationId: string;
  /** An app record and the organization owning it, in one lookup; webhooks find their tenant and secret this way. An installation of an app sharing its platform client (`<app>/<id>`) routes to that app. */
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
  /** Every workspace's apps on one integration, for an install the platform started. */
  apps(integration: string): Promise<Array<{ organizationId: string; app: AgentApp }>>;
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
  return config.store === 'postgres' ? postgresBackend(config) : memoryBackend(options.local);
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
  return store.updateMetadata(kind, id, fields);
}

export async function getApps(
  store: Store,
  keys: string[],
): Promise<Array<{ id: string; value: AgentApp }>> {
  return store.getApps([...new Set(keys)]);
}
