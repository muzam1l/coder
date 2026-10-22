/** Re-seal the server's stored secrets with the current encryption key. */
import process from 'node:process';

import { eq } from 'drizzle-orm';

import { CoderError } from '../core/dispatch';
import { reseal } from './settings/credentials';
import { secret } from './store/pg/schema';
import { loadServerConfig } from './env';
import { decryptSecret, encryptSecret, keyVersion, secretKeyVersion } from './store/secrets';
import { createBackend } from './store';

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

/** Re-seal every stored secret with the current encryption key: one pass over the `secret` table, or the memory store's records. */
export function rotateKey(options: MaintenanceOptions = {}): Promise<{ moved: number }> {
  return asServerError(async () => {
    const config = loadServerConfig(options.env ?? process.env);
    if (!config.encryptionKey)
      throw new CoderError('invalid-option', 'SERVER_ENCRYPTION_KEY is required to rotate keys.', {
        hint: 'Set the new key in SERVER_ENCRYPTION_KEY and the old key in SERVER_ENCRYPTION_KEY_PREVIOUS.',
      });

    const backend = await createBackend(config);
    try {
      const db = backend.connection?.db;
      if (!db) return { moved: await reseal(backend.store(backend.defaultOrganizationId), config) };
      const current = keyVersion(config.encryptionKey);
      let moved = 0;
      for (const row of await db.select().from(secret)) {
        if (secretKeyVersion(config, row.value) === current) continue;
        await db
          .update(secret)
          .set({ value: encryptSecret(config, decryptSecret(config, row.value)) })
          .where(eq(secret.id, row.id));
        moved++;
      }

      return { moved };
    } finally {
      await backend.close();
    }
  });
}
