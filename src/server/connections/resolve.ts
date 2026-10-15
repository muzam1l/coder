import type { AgentApp, AgentTask, Connection } from '../../agent/types';
import {
  ConnectionRefused,
  connectionMcp,
  connectionRevoked,
  connectionWarning,
  connectionEnvName,
  connectionEnvConflicts,
} from '../../core/connections';
import type { McpServerSpec } from '../../core/types';
import { encryptSecret, decryptSecret } from '../store/secrets';
import {
  findConnection,
  nativeApp,
  nativeConnections,
  nativeCredential,
  type ConnectionContext,
} from './records';
import { sharedApps } from '../agents/apps';
import { IntegrationError } from '../../integrations/types';
import { OAuthRevoked } from './oauth';
import { oauthAccessToken, type OAuthSecret } from './oauth';
import { LocalStore } from '../store/local';
import { credentialValue } from '../settings/credentials';
import { createHash } from 'node:crypto';
import type { Store, TaskStatus } from '../store/types';

function nativeSecretValues(stored: string): string[] {
  try {
    const value = JSON.parse(stored) as { accessToken?: string; refreshToken?: string };

    return [stored, value.accessToken, value.refreshToken].filter(
      (entry): entry is string => typeof entry === 'string' && !!entry,
    );
  } catch {
    return [stored];
  }
}

/** An `env` connection's value, read from its credential; a member's connection reads only their own or the workspace's. */
async function envKey(ctx: ConnectionContext, connection: Connection): Promise<string> {
  const stored = connection.credential
    ? await ctx.store.get('credential', connection.credential)
    : undefined;
  if (!stored || (stored.owner && stored.owner !== connection.owner))
    throw new Error('Missing credential');
  const key = credentialValue(ctx.config, stored).env[(connection.keyIn as { env: string }).env];
  if (!key) throw new Error('Missing key');

  return key;
}

export async function resolveConnections(
  ctx: ConnectionContext,
  task: AgentTask,
  handles: Record<string, string> = {},
) {
  const mcp: Record<string, McpServerSpec> = {};
  const env: Record<string, string> = {};
  const tokens = { ...handles };
  const tools = { ...task.tools };
  const nativeTokens: Record<string, string> = {};
  const warnings: string[] = [];
  const secrets: string[] = [];
  const ids = [...new Set(task.connections ?? [])];
  const stored = ids.length
    ? await ctx.store.list('connection', { ids, visibleTo: task.requester, secrets: 'all' })
    : [];
  const saved = new Set(stored.map(row => row.id));
  let nativeError: unknown;
  const native = ids.some(id => !saved.has(id))
    ? await nativeConnections(ctx, task.requester).catch(error => {
        console.error('coder server: native connection lookup failed', error);
        nativeError = error;
        return [];
      })
    : [];
  const available = new Map([
    ...native.map(value => [value.id, value] as const),
    ...stored.map(({ id, value }) => [id, value] as const),
  ]);
  const rows = await Promise.allSettled(
    ids.map(async id => {
      if (!available.has(id) && nativeError) throw nativeError;
      return { id, value: available.get(id) };
    }),
  );
  let apps: Promise<AgentApp[]> | undefined;
  const connections = rows.sort(
    (a, b) =>
      Number(b.status === 'fulfilled' && !!b.value.value?.owner) -
      Number(a.status === 'fulfilled' && !!a.value.value?.owner),
  );
  const conflicts = connectionEnvConflicts(
    connections.flatMap(result =>
      result.status === 'fulfilled' && result.value.value ? [result.value.value] : [],
    ),
  );
  for (const result of connections) {
    let connection: Connection | undefined;
    let id = '';
    try {
      if (result.status === 'rejected') throw result.reason;
      ({ id, value: connection } = result.value);
      if (!connection || (connection.owner && connection.owner !== task.requester)) continue;
      if (
        connection.provider === 'env' &&
        (connection.auth !== 'key' ||
          connection.access !== 'write' ||
          connection.endpoint ||
          !connection.credential ||
          !connection.keyIn ||
          !('env' in connection.keyIn) ||
          !connectionEnvName(connection.keyIn.env) ||
          conflicts.has(connection.keyIn.env) ||
          ('local' in ctx && ctx.local && process.env[connection.keyIn.env] !== undefined))
      )
        throw new Error('Invalid environment connection');
      if (connection.broken) {
        warnings.push(`${connection.name} needs reconnecting.`);
        continue;
      }
      let token: string | undefined;
      let credential: ((force?: boolean, refused?: string) => Promise<string>) | undefined;
      if (
        connection.provider !== 'mcp' &&
        connection.provider !== 'env' &&
        connection.auth === 'oauth'
      ) {
        if (nativeTokens[connection.provider]) continue;
        const selected = connection;
        const integration = ctx.integrations[selected.provider];
        if (!integration?.auth.user) throw new Error('Missing user OAuth');
        const selectedSecret =
          !selected.owner && selected.secret
            ? decryptSecret<{ app: string; token: string }>(ctx.config, selected.secret)
            : undefined;
        const account = selected.owner
          ? (await ctx.auth?.linkedAccounts?.(selected.owner, ctx.store))?.find(
              account =>
                account.platform === selected.provider &&
                account.token &&
                account.organizations?.includes(ctx.organizationId) &&
                (!selected.account || account.platformUserId === selected.account),
            )
          : undefined;
        const app = await nativeApp(
          ctx,
          selected.provider,
          (account?.token ? nativeCredential(ctx.config, account.token).app : undefined) ??
            selected.oauthApp ??
            selectedSecret?.app,
          await (apps ??= Promise.all([sharedApps(ctx), ctx.store.list('app')]).then(
            ([shared, own]) => [...shared, ...own.map(row => row.value)],
          )),
        );
        if (!app) throw new Error('Missing integration credentials');
        const accountId = selected.owner
          ? (selected.account ?? account?.platformUserId)
          : undefined;
        if (selected.owner && !accountId) throw new Error('Missing linked account');
        const lock = selected.owner
          ? `native:${selected.owner}:${selected.provider}:${accountId}`
          : `connection:${id}`;
        token = await ctx.store.withAppLock(lock, async store => {
          const current = await findConnection({ ...ctx, store }, id, task.requester);
          if (
            !current ||
            current.owner !== selected.owner ||
            current.provider !== selected.provider ||
            current.broken
          )
            throw new Error('Connection changed during resolution');
          connection = current;
          const accounts = current.owner
            ? await ctx.auth?.linkedAccounts?.(current.owner, store)
            : [];
          const account = accounts?.find(
            account =>
              account.platform === current.provider &&
              account.token &&
              account.organizations?.includes(ctx.organizationId) &&
              account.platformUserId === accountId &&
              (!current.account || account.platformUserId === current.account),
          );
          const secret = current.owner
            ? undefined
            : current.secret &&
              decryptSecret<{ app: string; token: string }>(ctx.config, current.secret);
          const stored = current.owner
            ? account?.token && nativeCredential(ctx.config, account.token).token
            : secret && secret.token;
          if (!stored) throw new Error('Missing native credential');
          secrets.push(...nativeSecretValues(stored));
          const boundApp =
            (account?.token ? nativeCredential(ctx.config, account.token).app : undefined) ??
            current.oauthApp ??
            (secret ? secret.app : undefined);
          if (boundApp && boundApp !== app.id)
            throw new Error('OAuth client changed during resolution');
          let access;
          try {
            access = await integration.auth.user!.access(
              stored,
              decryptSecret(ctx.config, app.credentials),
              {
                fetch: ((input, init) =>
                  (ctx.fetch ?? fetch)(input, {
                    ...init,
                    redirect: 'manual',
                    signal: AbortSignal.timeout(5000),
                  })) as typeof fetch,
                now: (ctx.now ?? Date.now)(),
              },
            );
          } catch (error) {
            if (
              error instanceof IntegrationError &&
              ['invalid_grant', 'invalid_token', 'bad_refresh_token', 'expired_token'].includes(
                error.error ?? '',
              )
            )
              throw new OAuthRevoked('Native credential was revoked');
            throw error;
          }
          if (access.refreshed) {
            secrets.push(...nativeSecretValues(access.refreshed));
            if (current.owner) {
              if (
                !account ||
                !(await ctx.auth?.refreshLinkedToken?.(
                  current.owner,
                  account.platform,
                  account.platformUserId,
                  account.token!,
                  encryptSecret(ctx.config, { app: app.id, token: access.refreshed }),
                  store,
                ))
              )
                throw new Error('Linked account changed during refresh');
            } else {
              current.secret = encryptSecret(ctx.config, { app: app.id, token: access.refreshed });
              await store.put('connection', id, current);
            }
          } else if (current.owner) {
            const linked = await ctx.auth?.linkedAccounts?.(current.owner, store);
            if (
              !linked?.some(
                value =>
                  value.platform === account?.platform &&
                  value.platformUserId === account.platformUserId &&
                  value.token === account.token,
              )
            )
              throw new Error('Linked account changed during resolution');
          }

          return access.accessToken;
        });
      } else if (connection.provider === 'env') {
        token = await envKey(ctx, connection);
      } else if (connection.auth !== 'none') {
        if (!connection.secret) throw new Error('Missing credential');
        const secret = decryptSecret<{ key?: string } & OAuthSecret>(ctx.config, connection.secret);
        secrets.push(
          ...[secret.key, secret.accessToken, secret.refreshToken, secret.clientSecret].filter(
            (value): value is string => !!value,
          ),
        );
        if (connection.auth === 'key') {
          if (!secret.key) throw new Error('Missing key');
          token = secret.key;
        } else {
          const owner = connection.owner;
          credential = async (force = false, refused?: string) => {
            const active = await ctx.store.withAppLock(`connection:${id}`, async store => {
              const current = await store.get('connection', id);
              if (!current || current.owner !== owner || current.broken || current.auth !== 'oauth')
                throw new Error('Connection changed during resolution');
              if (!current.secret) throw new Error('Missing credential');
              const secret = decryptSecret<OAuthSecret>(ctx.config, current.secret);
              secrets.push(
                ...[secret.accessToken, secret.refreshToken, secret.clientSecret].filter(
                  (value): value is string => !!value,
                ),
              );
              const signal = AbortSignal.timeout(5000);
              const token = await oauthAccessToken({
                secret,
                now: (ctx.now ?? Date.now)(),
                force: force && secret.accessToken === refused,
                fetch: ((input, init) =>
                  (ctx.fetch ?? fetch)(input, {
                    ...init,
                    redirect: 'manual',
                    signal,
                  })) as typeof fetch,
                save: async value => {
                  secrets.push(
                    ...[value.accessToken, value.refreshToken, value.clientSecret].filter(
                      (entry): entry is string => !!entry,
                    ),
                  );
                  current.secret = encryptSecret(ctx.config, value);
                  await store.put('connection', id, current);
                },
              });

              return { connection: current, token };
            });
            connection = active.connection;

            return active.token;
          };
          token = await credential();
        }
      }
      if (token) secrets.push(token);
      if (connection.provider === 'env') {
        env[(connection.keyIn as { env: string }).env] = token!;
      } else if (connection.provider === 'mcp') {
        let spec: McpServerSpec | undefined;
        try {
          spec = await connectionMcp(connection, token, ctx.fetch ?? fetch);
        } catch (error) {
          if (!(error instanceof ConnectionRefused) || !credential) throw error;
          token = await credential(true, token);
          secrets.push(token);
          spec = await connectionMcp(connection, token, ctx.fetch ?? fetch);
        }
        if (spec) mcp[id] = spec;
      } else if (!nativeTokens[connection.provider] && token) {
        const integration = ctx.integrations[connection.provider];
        if (!integration) throw new Error('Unknown integration');
        nativeTokens[connection.provider] = token;
        tokens[connection.provider] = token;
        tools[connection.provider] = [...integration.tools.presets[connection.access]];
      }
    } catch (error) {
      if (connection && connectionRevoked(error)) {
        const failed = connection;
        await ctx.store.withAppLock(`connection:${id}`, async store => {
          const current = await store.get('connection', id);
          if (current && current.secret === failed.secret)
            await store.put('connection', id, {
              ...current,
              broken: { at: (ctx.now ?? Date.now)(), reason: 'Needs reconnecting' },
            });
        });
      }
      warnings.push(connectionWarning(connection?.name ?? 'A connection', error));
    }
  }

  const toolScopes = { ...task.toolScopes };
  for (const id of Object.keys(nativeTokens)) toolScopes[id] = {};

  return { mcp, env, tokens, nativeTokens, tools, toolScopes, warnings, secrets };
}

export async function resolvedTaskConnections(
  ctx: ConnectionContext,
  status: TaskStatus,
  handles: Record<string, string>,
) {
  if (!status.task.connections?.length)
    return {
      mcp: {},
      env: {},
      tokens: handles,
      nativeTokens: {},
      tools: status.task.tools,
      toolScopes: status.task.toolScopes,
      warnings: [],
      secrets: [],
    };
  const grants = createHash('sha256')
    .update(JSON.stringify(status.task.connections))
    .digest('hex')
    .slice(0, 12);
  const id = `connections:${status.task.id}:${status.generation ?? 0}:${status.attempts}:${grants}`;

  const local = ctx.store instanceof LocalStore;
  const cached = local ? ctx.store.connectionContexts?.get(id) : undefined;
  if (cached && !cached.warnings.length)
    return { ...cached, tokens: { ...cached.tokens, ...handles, ...cached.nativeTokens } };
  const known = local ? undefined : await ctx.store.get('snapshot', id);
  if (known && 'resolvedConnections' in known) {
    const resolved = decryptSecret<Awaited<ReturnType<typeof resolveConnections>>>(
      ctx.config,
      known.resolvedConnections,
    );
    if (!resolved.warnings.length)
      return { ...resolved, tokens: { ...resolved.tokens, ...handles, ...resolved.nativeTokens } };
  }
  const live = await ctx.store.get('task', status.task.id);
  const resolved = await resolveConnections(ctx, status.task, handles);
  if (!resolved.warnings.length && live)
    await ctx.store.withAppLock(`connections:${status.task.id}`, async store => {
      const current = await store.get('task', status.task.id);
      if (
        !current ||
        ['completed', 'failed', 'cancelled'].includes(current.status) ||
        current.attempts !== status.attempts ||
        (current.generation ?? 0) !== (status.generation ?? 0)
      )
        return;
      if (store instanceof LocalStore) (store.connectionContexts ??= new Map()).set(id, resolved);
      else {
        const expiresAt =
          (status.startedAt ?? (ctx.now ?? Date.now)()) +
          (ctx.config.taskTimeoutMs ?? 60 * 60 * 1000);
        await store.put(
          'snapshot',
          id,
          {
            resolvedConnections: encryptSecret(ctx.config, resolved),
            expiresAt,
          },
          { ttlMs: Math.max(1, expiresAt - (ctx.now ?? Date.now)()) },
        );
      }
    });

  return resolved;
}

export async function taskConnectionSecrets(
  ctx: ConnectionContext,
  taskId: string,
  values: string[],
): Promise<string[]> {
  const id = `connection-secrets:${taskId}`;

  return ctx.store.withAppLock(`connections:${taskId}`, async store => {
    const [status, known] = await Promise.all([
      store.get('task', taskId),
      store instanceof LocalStore ? undefined : store.get('snapshot', id),
    ]);
    const active = status && !['completed', 'failed', 'cancelled'].includes(status.status);
    if (store instanceof LocalStore) {
      const cache = (store.connectionSecrets ??= new Map());
      const secrets = [...new Set([...(cache.get(taskId) ?? []), ...values])].filter(
        value => value.length >= 8,
      );
      if (active) cache.set(taskId, secrets);

      return secrets;
    }
    const previous =
      known && 'connectionSecrets' in known
        ? decryptSecret<string[]>(ctx.config, known.connectionSecrets)
        : [];
    const secrets = [...new Set([...previous, ...values])].filter(value => value.length >= 8);
    const expiresAt =
      (status?.startedAt ?? (ctx.now ?? Date.now)()) + (ctx.config.taskTimeoutMs ?? 60 * 60 * 1000);
    if (secrets.length && active)
      await store.put(
        'snapshot',
        id,
        {
          connectionSecrets: encryptSecret(ctx.config, secrets),
          expiresAt,
        },
        { ttlMs: Math.max(1, expiresAt - (ctx.now ?? Date.now)()) },
      );

    return secrets;
  });
}

export async function connectionSecretValues(
  ctx: ConnectionContext,
  task: AgentTask,
): Promise<string[]> {
  const secrets: string[] = [];
  for (const id of task.connections ?? []) {
    const connection = await findConnection(ctx, id, task.requester);
    if (connection?.provider === 'env') {
      secrets.push(
        ...(await envKey(ctx, connection).then(
          key => [key],
          () => [],
        )),
      );
      continue;
    }
    if (!connection?.secret) continue;
    const value = decryptSecret<({ key?: string } & OAuthSecret) | string>(
      ctx.config,
      connection.secret,
    );
    secrets.push(
      ...(typeof value === 'string'
        ? [value]
        : [
            ...('token' in value && typeof value.token === 'string'
              ? nativeSecretValues(value.token)
              : []),
            value.key,
            value.accessToken,
            value.refreshToken,
            value.clientSecret,
          ].filter((entry): entry is string => !!entry)),
    );
  }

  return secrets;
}

export async function readTaskConnectionSecrets(
  ctx: ConnectionContext,
  task: AgentTask,
): Promise<string[]> {
  const [known, current] = await Promise.all([
    ctx.store instanceof LocalStore
      ? undefined
      : ctx.store.get('snapshot', `connection-secrets:${task.id}`),
    connectionSecretValues(ctx, task),
  ]);
  const previous =
    ctx.store instanceof LocalStore
      ? (ctx.store.connectionSecrets?.get(task.id) ?? [])
      : known && 'connectionSecrets' in known
        ? decryptSecret<string[]>(ctx.config, known.connectionSecrets)
        : [];

  return [...new Set([...previous, ...current])];
}

export async function deleteTaskConnections(store: Store, taskId: string): Promise<void> {
  await store.withAppLock(`connections:${taskId}`, async store => {
    await store.delete('snapshot', `connection-secrets:${taskId}`);
    const prefix = `connections:${taskId}:`;
    for (const row of await store.list('snapshot', { prefix }))
      await store.delete('snapshot', row.id);
    if (store instanceof LocalStore) {
      store.connectionSecrets?.delete(taskId);
      for (const id of store.connectionContexts?.keys() ?? [])
        if (id.startsWith(prefix)) store.connectionContexts!.delete(id);
    }
  });
}
