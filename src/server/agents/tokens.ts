import { IntegrationError, type AppTokens } from '../../integrations/types';
import { sha256 } from '../../utils/crypto';
import type { ServerContext } from '../context';
import { decryptSecret, encryptSecret } from '../store/secrets';

type TokenContext = Pick<ServerContext, 'store' | 'config' | 'session' | 'now' | 'organizationId'>;
type SavedToken = Parameters<AppTokens['put']>[0] & {
  savedBy: string;
  lastUsedAt: number;
  unusable?: true;
};

const prefix = (integration: string) => `app-token:${integration}:`;

export async function savedAppTokens(ctx: TokenContext, integration: string) {
  const rows = await ctx.store.list('snapshot', { prefix: prefix(integration) });

  return rows
    .flatMap(({ id, value }) => {
      if (!('secret' in value)) return [];
      const token = decryptSecret<SavedToken>(ctx.config, value.secret);
      return token.unusable ? [] : [{ id, token }];
    })
    .sort((a, b) => b.token.lastUsedAt - a.token.lastUsedAt)
    .map(({ id, token }) => ({
      id,
      label: `${token.workspaceName} · saved by ${token.savedBy}`,
    }));
}

export function appTokens(ctx: TokenContext, integration: string): AppTokens {
  const now = () => (ctx.now ?? Date.now)();
  return {
    async put(value) {
      const id = prefix(integration) + sha256(JSON.stringify([value.workspace, value.user]));
      await ctx.store.withAppLock(`${ctx.organizationId}:${id}`, store =>
        store.put('snapshot', id, {
          secret: encryptSecret(ctx.config, {
            ...value,
            savedBy: ctx.session?.user.name || 'Server operator',
            lastUsedAt: now(),
          }),
        }),
      );
      return id;
    },
    async use(id, run) {
      if (!id.startsWith(prefix(integration)))
        throw new IntegrationError(
          'invalid-field',
          'token',
          'Choose a saved configuration token or paste a new one.',
        );
      // Commit rotated pairs and invalidation even when the platform request fails.
      const outcome = await ctx.store.withAppLock(`${ctx.organizationId}:${id}`, async store => {
        const row = await store.get<{ secret: string }>('snapshot', id);
        const token = row && decryptSecret<SavedToken>(ctx.config, row.secret);
        if (!token || token.unusable)
          return {
            error: new IntegrationError(
              'invalid-field',
              'token',
              'This configuration token is unavailable. Paste a new token.',
            ),
          };
        const write = () => store.put('snapshot', id, { secret: encryptSecret(ctx.config, token) });
        try {
          const value = await run(
            token.credentials,
            async (credentials, workspaceName) => {
              if (workspaceName) token.workspaceName = workspaceName;
              token.credentials = credentials;
              await write();
            },
            async () => {
              token.unusable = true;
              await write();
            },
          );
          token.lastUsedAt = now();
          await write();
          return { value };
        } catch (error) {
          return { error };
        }
      });
      if ('error' in outcome) throw outcome.error;
      return outcome.value;
    },
  };
}
