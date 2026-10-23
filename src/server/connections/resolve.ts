import type { AgentTask, Connection } from '../../agent/types';
import { agentAccess } from '../../agent/definition';
import { strictestAccess } from '../../core/config';
import {
  connectionDescription,
  connectionMcp,
  connectionWarning,
  connectionEnvConflicts,
  credentialField,
} from '../../core/connections';
import { connectionEnvName } from '../../core/connection-env';
import type { McpServerSpec } from '../../core/types';
import { decryptCredential, encryptSecret, decryptSecret } from '../store/secrets';
import {
  findConnection,
  nativeApp,
  nativeConnections,
  nativeCredential,
  personalGrants,
  type ConnectionContext,
} from './records';
import { sharedApps } from '../agents/apps';
import { sharedConversation } from '../tasks/access';
import { connectionToolServer } from '../../agent/mcp';
import { IntegrationError } from '../../integrations/types';
import { OAuthRevoked, oauthAccessToken, type OAuthSecret } from './oauth';
import { refreshFailure, tokenFingerprint } from '../../core/oauth';
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

const hostOf = (connection: Connection) =>
  connection.endpoint?.url ? URL.parse(connection.endpoint.url)?.host : undefined;

/** An `env` connection's value, read from its credential; a member's connection reads only their own or the workspace's. */
async function envKey(ctx: ConnectionContext, connection: Connection): Promise<string> {
  const stored = connection.credential
    ? await ctx.store.get('credential', connection.credential)
    : undefined;
  if (!stored || (stored.owner && stored.owner !== connection.owner))
    throw new Error('Missing credential');
  const key = decryptCredential(ctx.config, stored).env[(connection.keyIn as { env: string }).env];
  if (!key) throw new Error('Missing key');

  return key;
}

/** Who asked for the turn: its asker, else outside a shared conversation the task's requester. */
export const taskAsker = (task: AgentTask) =>
  task.context?.asker ?? (sharedConversation(task) ? undefined : task.requestedBy);

/** A turn's connections: the task's grants and, on a conversation turn, the personal ones of the member who asked it. */
export async function turnConnections(ctx: ConnectionContext, task: AgentTask): Promise<string[]> {
  const asker = taskAsker(task);
  const own = task.event && asker ? await personalGrants(ctx, asker, task.usage?.connections) : [];

  return [...new Set([...(task.connections ?? []), ...own])];
}

/** `actAs` refuses a personal connection until its owner approved acting as them for the task, else answers nothing. */
export async function resolveConnections(
  ctx: ConnectionContext,
  task: AgentTask,
  handles: Record<string, string> = {},
  actAs?: (connection: Connection) => Promise<string | undefined>,
) {
  const mcp: Record<string, McpServerSpec> = {};
  const env: Record<string, string> = {};
  const tokens = { ...handles };
  const mode = agentAccess(task, task.access);
  const accessOf = (connection: Connection) => strictestAccess(connection.access, mode);
  const warnings: string[] = [];
  const secrets: string[] = [];
  const asker = taskAsker(task);
  const ids = await turnConnections(ctx, task);
  const stored = ids.length
    ? await ctx.store.list('connection', { ids, visibleTo: asker, secrets: 'all' })
    : [];
  const saved = new Set(stored.map(row => row.id));
  let nativeError: unknown;
  const native = ids.some(id => !saved.has(id))
    ? await nativeConnections(ctx, asker).catch(error => {
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
  const conflicts = connectionEnvConflicts(
    rows.flatMap(result =>
      result.status === 'fulfilled' && result.value.value ? [result.value.value] : [],
    ),
  );
  for (const result of rows) {
    let connection: Connection | undefined;
    let id = '';
    try {
      if (result.status === 'rejected') throw result.reason;
      ({ id, value: connection } = result.value);
      if (!connection || (connection.owner && connection.owner !== asker)) continue;
      if (
        connection.provider === 'env' &&
        (connection.auth !== 'key' ||
          connection.access !== 'auto' ||
          connection.endpoint ||
          !connection.credential ||
          !connection.keyIn ||
          !('env' in connection.keyIn) ||
          !connectionEnvName(connection.keyIn.env) ||
          conflicts.has(connection.keyIn.env) ||
          ('local' in ctx && ctx.local && process.env[connection.keyIn.env] !== undefined))
      )
        throw new Error('Invalid environment connection');
      // A personal key in the spawn environment waits for its owner's approval, from the turn that asks for it.
      if (connection.owner && connection.provider === 'env') {
        const refusal = actAs ? await actAs(connection) : 'Its owner has not approved it';
        if (refusal) {
          warnings.push(refusal);
          continue;
        }
      }
      if (
        connection.auth === 'oauth' ||
        (connection.owner && connection.provider === 'mcp' && connection.auth === 'key')
      ) {
        // OAuth tokens and personal keys load on first use, through the task's server.
        const access = accessOf(connection);
        if (connection.provider === 'mcp')
          mcp[id] = {
            ...connectionMcp({ ...connection, access }, undefined),
            connection: id,
            credentialOnUse: credentialField(connection),
            connectionCreatedAt: connection.createdAt,
            description: connectionDescription(connection),
            access,
            ...(connection.owner
              ? { owner: connection.owner, account: connection.login ?? connection.account }
              : {}),
          };
        else {
          const integration = ctx.integrations[connection.provider];
          if (!integration) throw new Error('Unknown integration');
          mcp[id] = connectionToolServer(
            connection,
            [...integration.tools.presets[access]],
            task.event,
          );
        }
        continue;
      }
      if (connection.broken) {
        warnings.push(`${connection.name} needs reconnecting.`);
        continue;
      }
      let token: string | undefined;
      if (connection.provider === 'env') {
        token = await envKey(ctx, connection);
      } else if (connection.auth === 'key') {
        if (!connection.secret) throw new Error('Missing credential');
        token = decryptSecret<{ key?: string }>(ctx.config, connection.secret).key;
        if (!token) throw new Error('Missing key');
      }
      if (token) secrets.push(token);
      if (connection.provider === 'env') {
        env[(connection.keyIn as { env: string }).env] = token!;
      } else if (connection.provider === 'mcp') {
        const access = accessOf(connection);
        mcp[id] = {
          ...connectionMcp({ ...connection, access }, token),
          connection: id,
          description: connectionDescription(connection),
          access,
        };
      }
    } catch (error) {
      warnings.push(connectionWarning(connection?.name ?? 'A connection', error));
    }
  }

  return { mcp, env, tokens, warnings, secrets };
}

/** Where an attempt keeps its resolved connections, by the turn's connection ids and asker, so one connected mid-run resolves again. */
const resolvedId = (status: TaskStatus, ids: string[]) =>
  `connections:${status.task.id}:${status.generation ?? 0}:${status.attempts}:${createHash('sha256')
    .update(JSON.stringify([ids, taskAsker(status.task)]))
    .digest('hex')
    .slice(0, 12)}`;

/** Error codes with which a platform refuses a token's refresh. */
const REFUSED = ['invalid_grant', 'invalid_token', 'bad_refresh_token', 'expired_token'];

const broken = (ctx: ConnectionContext) => ({
  at: (ctx.now ?? Date.now)(),
  reason: 'Needs reconnecting',
});

const timed = (ctx: ConnectionContext) =>
  ((input, init) =>
    (ctx.fetch ?? fetch)(input, {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })) as typeof fetch;

/** An OAuth MCP connection's token, refreshed when expired or when it is the `refused` one, and saved in the same locked step; only for the row and endpoint the task resolved. */
function mcpToken(
  ctx: ConnectionContext,
  id: string,
  owner: string | undefined,
  refused: string | undefined,
  secrets: string[],
  resolved: { url?: unknown; connectionCreatedAt?: unknown },
): Promise<string | undefined> {
  return ctx.store.withAppLock(`connection:${id}`, async store => {
    const current = await store.get('connection', id);
    if (!current?.secret || current.auth !== 'oauth' || current.broken || current.owner !== owner)
      return undefined;
    if (
      current.createdAt !== resolved.connectionCreatedAt ||
      current.endpoint?.url !== resolved.url
    )
      throw new Error('The connection changed since the task resolved it');
    const secret = decryptSecret<OAuthSecret>(ctx.config, current.secret);
    secrets.push(
      ...[secret.accessToken, secret.refreshToken].filter((value): value is string => !!value),
    );
    const force = !!secret.accessToken && tokenFingerprint(secret.accessToken) === refused;
    // A token with no expiry stays until its server refuses it.
    if (!force && secret.accessToken && secret.expiresAt === undefined) return secret.accessToken;
    try {
      return await oauthAccessToken({
        secret,
        now: (ctx.now ?? Date.now)(),
        fetch: timed(ctx),
        force,
        save: async value => {
          secrets.push(
            ...[value.accessToken, value.refreshToken].filter((entry): entry is string => !!entry),
          );
          await store.put('connection', id, {
            ...current,
            secret: encryptSecret(ctx.config, value),
          });
        },
      });
    } catch (error) {
      console.error(
        'coder server: token refresh failed',
        refreshFailure({ connection: id, host: hostOf(current) }, error),
      );
      if (!(error instanceof OAuthRevoked)) throw error;
      await store.put('connection', id, { ...current, broken: broken(ctx) });
      return undefined;
    }
  });
}

/** A personal platform connection's token, from its member's link; a refresh and the save of its rotated token happen under the lock the token was read in. A token bound to no client refreshes with the event's app. */
async function nativeToken(
  ctx: ConnectionContext,
  connection: Connection,
  event: AgentTask['event'],
  refused: string | undefined,
  secrets: string[],
): Promise<string | undefined> {
  const integration = ctx.integrations[connection.provider];
  if (!integration?.auth.user) throw new Error('Missing user OAuth');
  const { owner, provider } = connection;
  if (!owner) return undefined;
  const linked = (
    accounts: Awaited<
      ReturnType<NonNullable<NonNullable<ConnectionContext['auth']>['linkedAccounts']>>
    > = [],
    account = connection.account,
  ) =>
    accounts.find(
      value =>
        value.platform === provider &&
        value.token &&
        value.organizations?.includes(ctx.organizationId) &&
        (!account || value.platformUserId === account),
    );
  const accountId =
    connection.account ??
    linked(await ctx.auth?.linkedAccounts?.(owner, ctx.store))?.platformUserId;
  if (!accountId) return undefined;
  const eventApp =
    event?.integration === provider ? await ctx.store.get('app', event.appId) : undefined;
  const apps = await Promise.all([sharedApps(ctx), ctx.store.list('app')]).then(([shared, own]) => [
    ...shared,
    ...own.map(row => row.value),
    ...(eventApp ? [eventApp] : []),
  ]);

  return ctx.store.withAppLock(`native:${owner}:${provider}:${accountId}`, async store => {
    const current = await findConnection({ ...ctx, store }, connection.id, owner);
    if (!current || current.owner !== owner || current.provider !== provider || current.broken)
      return undefined;
    const account = linked(await ctx.auth?.linkedAccounts?.(owner, store), accountId);
    if (!account?.token || account.refusedAt) return undefined;
    const stored = nativeCredential(ctx.config, account.token);
    secrets.push(...nativeSecretValues(stored.token));
    const app = await nativeApp(
      ctx,
      provider,
      stored.app ?? current.oauthApp ?? eventApp?.id,
      apps,
    );
    if (!app) throw new Error('Missing integration credentials');
    const use = (force: boolean) =>
      integration.auth.user!.access(stored.token, decryptSecret(ctx.config, app.credentials), {
        fetch: timed(ctx),
        now: (ctx.now ?? Date.now)(),
        force,
      });
    let access;
    try {
      access = await use(false);
      // Its server refused this very token, so it refreshes now.
      if (!access.refreshed && tokenFingerprint(access.accessToken) === refused)
        access = await use(true);
    } catch (error) {
      console.error(
        'coder server: token refresh failed',
        refreshFailure({ integration: provider, account: accountId }, error),
      );
      if (!(error instanceof IntegrationError && REFUSED.includes(error.error ?? ''))) throw error;
      await ctx.auth?.refuseLinkedToken?.(
        owner,
        provider,
        account.platformUserId,
        account.token,
        store,
      );
      return undefined;
    }
    if (access.refreshed) {
      secrets.push(...nativeSecretValues(access.refreshed));
      const sealed = encryptSecret(ctx.config, { app: app.id, token: access.refreshed });
      if (
        !(await ctx.auth?.refreshLinkedToken?.(
          owner,
          provider,
          account.platformUserId,
          account.token,
          sealed,
          store,
        ))
      ) {
        const error = new Error('Linked account changed during refresh');
        console.error(
          'coder server: token refresh failed',
          refreshFailure({ integration: provider, account: accountId }, error),
        );
        throw error;
      }
    }

    return access.accessToken;
  });
}

/** A personal MCP key, only for the endpoint the task resolved; none once its server refused it. */
function keyToken(
  ctx: ConnectionContext,
  connection: Connection,
  refused: string | undefined,
  resolved: { url?: unknown; connectionCreatedAt?: unknown },
): string | undefined {
  if (
    connection.createdAt !== resolved.connectionCreatedAt ||
    connection.endpoint?.url !== resolved.url
  )
    throw new Error('The connection changed since the task resolved it');
  const key =
    connection.secret && decryptSecret<{ key?: string }>(ctx.config, connection.secret).key;

  return key && tokenFingerprint(key) !== refused ? key : undefined;
}

/** A task's OAuth connection token or personal key on first use, refreshed then; `refused` names, by its fingerprint, a token its server refused, which refreshes only while it is still the current one. No token when it needs reconnecting: the refusal is marked on the connection or link. */
export async function connectionToken(
  ctx: ConnectionContext,
  task: AgentTask,
  id: string,
  refused?: string,
  resolved: { url?: unknown; connectionCreatedAt?: unknown } = {},
): Promise<{ token?: string; name?: string }> {
  const connection = await findConnection(ctx, id, taskAsker(task));
  const key = connection?.auth === 'key' && connection.owner && connection.provider === 'mcp';
  if (!connection || (connection.auth !== 'oauth' && !key) || connection.broken)
    return { name: connection?.name };
  const secrets: string[] = [];
  const token = key
    ? keyToken(ctx, connection, refused, resolved)
    : connection.provider === 'mcp'
      ? await mcpToken(ctx, id, connection.owner, refused, secrets, resolved)
      : await nativeToken(ctx, connection, task.event, refused, secrets);
  await taskConnectionSecrets(ctx, task.id, [...secrets, ...(token ? [token] : [])]);

  return { name: connection.name, ...(token ? { token } : {}) };
}

/** The attempt's connections, resolved once and kept; `saved` when the kept resolution answered, whose secrets its first start stored. */
export async function resolvedTaskConnections(
  ctx: ConnectionContext,
  status: TaskStatus,
  handles: Record<string, string>,
  actAs?: (connection: Connection) => Promise<string | undefined>,
) {
  if (!status.task.connections?.length && !(status.task.event && taskAsker(status.task)))
    return { mcp: {}, env: {}, tokens: handles, warnings: [], secrets: [], saved: false };
  const id = resolvedId(status, await turnConnections(ctx, status.task));

  const known = await ctx.store.get('snapshot', id);
  if (known && 'resolvedConnections' in known) {
    const resolved = decryptSecret<Awaited<ReturnType<typeof resolveConnections>>>(
      ctx.config,
      known.resolvedConnections,
    );
    if (!resolved.warnings.length)
      return {
        ...resolved,
        tokens: { ...resolved.tokens, ...handles },
        saved: true,
      };
  }
  const live = await ctx.store.get('task', status.task.id);
  const resolved = await resolveConnections(ctx, status.task, handles, actAs);
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
    });

  return { ...resolved, saved: false };
}

/** A task's redaction secrets, one sealed row each under `connection-secrets:<task>:`, kept for the task's timeout. */
export function secretRows(
  ctx: ConnectionContext,
  taskId: string,
  values: string[],
): Array<{ id: string; value: string; expiresAt: number }> {
  const expiresAt = (ctx.now ?? Date.now)() + (ctx.config.taskTimeoutMs ?? 60 * 60 * 1000);

  return [...new Set(values)]
    .filter(value => value.length >= 8)
    .map(value => ({
      id: `connection-secrets:${taskId}:${createHash('sha256').update(value).digest('hex').slice(0, 24)}`,
      value: encryptSecret(ctx.config, value),
      expiresAt,
    }));
}

export async function taskConnectionSecrets(
  ctx: ConnectionContext,
  taskId: string,
  values: string[],
): Promise<string[]> {
  const rows = secretRows(ctx, taskId, values);
  if (rows.length) await ctx.store.saveTaskSecrets(taskId, rows);

  return [...new Set(values)].filter(value => value.length >= 8);
}

export async function connectionSecretValues(
  ctx: ConnectionContext,
  task: AgentTask,
): Promise<string[]> {
  const secrets: string[] = [];
  const ids = [...new Set(task.connections ?? [])];
  const stored = ids.length
    ? await ctx.store.list('connection', { ids, visibleTo: task.requestedBy, secrets: 'all' })
    : [];
  const native = ids.some(id => !stored.some(row => row.id === id))
    ? await nativeConnections(ctx, task.requestedBy)
    : [];
  const available = new Map([
    ...native.map(value => [value.id, value] as const),
    ...stored.map(({ id, value }) => [id, value] as const),
  ]);
  for (const id of ids) {
    const connection = available.get(id);
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

/** A task's kept secrets and its connections' current ones; a row in the old single-row layout is refused, never read as nothing. */
export async function readTaskConnectionSecrets(
  ctx: ConnectionContext,
  task: AgentTask,
): Promise<string[]> {
  const [old, rows, current] = await Promise.all([
    ctx.store.get('snapshot', `connection-secrets:${task.id}`),
    ctx.store.list('snapshot', { prefix: `connection-secrets:${task.id}:` }),
    connectionSecretValues(ctx, task),
  ]);
  if (old) throw new Error(`Task ${task.id} keeps its secrets in the old single-row layout`);
  const previous = rows.flatMap(row =>
    'secret' in row.value ? [decryptSecret<string>(ctx.config, row.value.secret)] : [],
  );

  return [...new Set([...previous, ...current])];
}

export async function deleteTaskConnections(store: Store, taskId: string): Promise<void> {
  await store.withAppLock(`connections:${taskId}`, async store => {
    await store.delete('snapshot', `connection-secrets:${taskId}`);
    for (const prefix of [`connection-secrets:${taskId}:`, `connections:${taskId}:`])
      for (const row of await store.list('snapshot', { prefix }))
        await store.delete('snapshot', row.id);
  });
}
