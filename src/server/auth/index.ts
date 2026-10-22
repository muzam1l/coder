// Imported only lazily (context/create.ts); static importers use auth/members, auth/metadata and auth/nonce.
import type { AuthApi, ServerConfig } from '../context';
import type { Db } from '../store/pg/client';
import { createSessionAuth, platformLinks } from './sign-in';

export { authKeys } from './sign-in';

export async function createAuth(db: Db, config: ServerConfig): Promise<AuthApi> {
  return { ...(await createSessionAuth(db, config)), ...platformLinks(db) };
}
