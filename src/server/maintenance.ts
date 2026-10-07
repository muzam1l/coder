/** Operator commands on a server's database: `coder server migrate` and `coder server rotate-key`. */
import process from 'node:process';

import { eq, isNotNull, like } from 'drizzle-orm';

import { CoderError } from '../core/dispatch';
import { reseal } from './settings/credentials';
import { describeDatabase, migrateDb } from './store/pg/migrate';
import { platformLink, secret, chatState } from './store/pg/schema';
import { stateKey } from './store/pg/tables/shared';
import { loadServerConfig } from './env';
import { decryptSecret, encryptSecret, keyVersion, secretKeyVersion } from './store/secrets';
import { createBackend, database } from './store';

export interface MaintenanceOptions {
  env?: Record<string, string | undefined>;
}

async function asServerError<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CoderError) throw error;
    throw new CoderError('server', error instanceof Error ? error.message : String(error));
  }
}

/** Apply pending server migrations and return how many were applied. */
export function migrate(options: MaintenanceOptions = {}): Promise<{ applied: number }> {
  return asServerError(async () => {
    const config = loadServerConfig(options.env ?? process.env);
    if (!config.databaseUrl)
      throw new CoderError('invalid-option', 'No database to migrate.', {
        hint: 'Set DATABASE_URL to the Postgres the server uses.',
      });

    const connection = await database(config);
    try {
      return await migrateDb(connection, describeDatabase(config.databaseUrl));
    } finally {
      await connection.close();
    }
  });
}

/** Re-seal every stored secret with the current encryption key. */
export function rotateKey(options: MaintenanceOptions = {}): Promise<{ moved: number }> {
  return asServerError(async () => {
    const config = loadServerConfig(options.env ?? process.env);
    if (!config.encryptionKey)
      throw new CoderError('invalid-option', 'SERVER_ENCRYPTION_KEY is required to rotate keys.', {
        hint: 'Set the new key in SERVER_ENCRYPTION_KEY and the old key in SERVER_ENCRYPTION_KEY_PREVIOUS.',
      });

    const backend = await createBackend(config);
    try {
      const organizationIds = new Set<string>([backend.defaultOrganizationId]);
      if (backend.connection) {
        const db = backend.connection.db;
        const [secrets, configs] = await Promise.all([
          db.selectDistinct({ id: secret.organizationId }).from(secret),
          db
            .select({ key: chatState.key })
            .from(chatState)
            .where(like(chatState.key, 'o:%,"config"]:workspace')),
        ]);
        for (const row of secrets) organizationIds.add(row.id);
        for (const row of configs) {
          let scope: unknown;
          try {
            scope = JSON.parse(row.key.slice(2, -10));
          } catch {
            continue;
          }
          if (
            Array.isArray(scope) &&
            scope.length === 2 &&
            typeof scope[0] === 'string' &&
            scope[1] === 'config' &&
            row.key === stateKey(scope[0], 'config', 'workspace')
          )
            organizationIds.add(scope[0]);
        }
      }
      let moved = 0;
      for (const id of organizationIds) moved += await reseal(backend.store(id), config);

      const db = backend.connection?.db;
      const current = keyVersion(config.encryptionKey);
      for (const link of db
        ? await db.select().from(platformLink).where(isNotNull(platformLink.token))
        : []) {
        if (secretKeyVersion(config, link.token!) === current) continue;
        await db!
          .update(platformLink)
          .set({ token: encryptSecret(config, decryptSecret(config, link.token!)) })
          .where(eq(platformLink.id, link.id));
        moved++;
      }
      return { moved };
    } finally {
      await backend.close();
    }
  });
}
