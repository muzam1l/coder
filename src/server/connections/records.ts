import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod/mini';
import type { AgentApp, Connection } from '../../agent/types';
import type { ConnectionRow } from '../../client/types';
import { mcpEntrySchema } from '../../core/config';
import { mcpSecretValue } from '../../core/mcp';
import {
  connectionEnvName,
  connectionToolName,
  connectionUrlAllowed,
  connectionMcp,
  ConnectionRefused,
} from '../../core/connections';
import type { ServerContext } from '../context';
import type { Params } from '../routes/match';
import { json } from '../routes/http';
import { requireWorkspaceAdmin } from '../routes/guards';
import { encryptSecret, decryptSecret, decryptCredential } from '../store/secrets';
import { authorizeUrl, oauthResource } from './oauth';
import { sharedApps } from '../agents/apps';
import { addCredential, removeCredential, visibleCredentials } from '../settings/credentials';

export type ConnectionContext = Pick<
  ServerContext,
  | 'store'
  | 'config'
  | 'integrations'
  | 'organizationId'
  | 'serverOrganizationId'
  | 'scope'
  | 'auth'
  | 'now'
  | 'fetch'
>;

const slug = z.string().check(z.regex(/^[a-z0-9][a-z0-9_-]*$/i));
const keyIn = z.union([
  z.strictObject({
    header: z.string().check(z.regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/)),
  }),
  z.strictObject({
    env: z.string().check(z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)),
  }),
]);
const inputSchema = z.strictObject({
  name: z.string().check(z.minLength(1)),
  id: z.optional(slug),
  provider: z.optional(slug),
  owner: z.optional(z.literal('me')),
  access: z.optional(z.enum(['read', 'write'])),
  endpoint: z.optional(mcpEntrySchema),
  auth: z.optional(z.enum(['none', 'key', 'oauth'])),
  key: z.optional(z.string().check(z.minLength(1))),
  keyIn: z.optional(keyIn),
  credential: z.optional(z.string().check(z.minLength(1))),
});
const patchSchema = z.strictObject({
  name: z.optional(z.string().check(z.minLength(1))),
  access: z.optional(z.nullable(z.enum(['read', 'write']))),
  key: z.optional(z.string().check(z.minLength(1))),
});

function endpointAllowed(ctx: ServerContext, connection: Connection): boolean {
  const endpoint = connection.endpoint;
  if (connection.provider === 'env')
    return (
      !endpoint &&
      connection.auth === 'key' &&
      connection.access === 'write' &&
      !!connection.keyIn &&
      'env' in connection.keyIn &&
      connectionEnvName(connection.keyIn.env)
    );
  if (connection.provider !== 'mcp') return !endpoint;
  if (
    !endpoint ||
    !connection.access ||
    (endpoint.command && connection.access === 'read' && !endpoint.tools?.length)
  )
    return false;
  if (endpoint.tools?.some(tool => !connectionToolName(tool))) return false;
  if (endpoint.url) {
    const url = URL.parse(endpoint.url);
    if (!url || !connectionUrlAllowed(url, !!ctx.local)) return false;
    if (connection.keyIn && 'env' in connection.keyIn) return false;
  } else if (connection.auth !== 'none' && (!connection.keyIn || !('env' in connection.keyIn)))
    return false;
  if (connection.auth === 'oauth' && !endpoint.url) return false;
  // Endpoint fields hold public configuration; credentials use the connection's secret.
  return ![...Object.values(endpoint.headers ?? {}), ...Object.values(endpoint.env ?? {})].some(
    mcpSecretValue,
  );
}

export function connectionRow(
  connection: Connection,
  viewer?: string,
  config?: ConnectionContext['config'],
): ConnectionRow {
  let authorized = !!connection.secret;
  if (connection.auth === 'oauth' && connection.provider === 'mcp' && connection.secret && config) {
    try {
      authorized = !!decryptSecret<{ accessToken?: string }>(config, connection.secret).accessToken;
    } catch {
      authorized = false;
    }
  }

  return {
    id: connection.id,
    name: connection.name,
    provider: connection.provider,
    auth: connection.auth,
    ...(connection.access ? { access: connection.access } : {}),
    ...(connection.owner
      ? {
          owner: connection.owner,
          ...(viewer === connection.owner ? { mine: true as const } : {}),
        }
      : {}),
    ...(connection.endpoint?.url ? { url: connection.endpoint.url } : {}),
    ...(connection.endpoint?.command ? { command: connection.endpoint.command } : {}),
    ...(connection.provider === 'env' && connection.keyIn && 'env' in connection.keyIn
      ? { env: connection.keyIn.env }
      : {}),
    ...(connection.account ? { account: connection.account } : {}),
    status: connection.broken
      ? 'reconnect'
      : connection.auth === 'oauth' && !authorized
        ? 'authorize'
        : 'ok',
    createdAt: connection.createdAt,
  };
}

export function nativeCredential(config: ConnectionContext['config'], sealed: string) {
  const value = decryptSecret<string | { app: string; token: string }>(config, sealed);

  return typeof value === 'string' ? { token: value, app: undefined } : value;
}

export async function nativeConnections(
  ctx: ConnectionContext,
  owner?: string,
): Promise<Connection[]> {
  if (!owner || !ctx.auth?.linkedAccounts) return [];
  const accounts = await ctx.auth.linkedAccounts(owner, ctx.store);

  return accounts
    .filter(
      account =>
        account.token &&
        account.organizations?.includes(ctx.organizationId) &&
        ctx.integrations[account.platform]?.auth.user,
    )
    .map(account => ({
      id: `${owner}:${account.platform}-${createHash('sha256').update(account.platformUserId).digest('hex').slice(0, 12)}`,
      name: ctx.integrations[account.platform]!.name ?? account.platform,
      provider: account.platform,
      owner,
      auth: 'oauth',
      secret: account.token,
      account: account.platformUserId,
      oauthApp: nativeCredential(ctx.config, account.token!).app,
      createdAt: 0,
    }));
}

export async function visibleConnections(
  ctx: ConnectionContext,
  owner?: string,
  secrets?: 'oauth' | 'all',
): Promise<Connection[]> {
  const native = await nativeConnections(ctx, owner);
  const records = (await ctx.store.list('connection', { visibleTo: owner, secrets }))
    .map(row => row.value)
    .filter(connection => !connection.owner || connection.owner === owner)
    .map(record => {
      if (!record.owner || record.provider === 'mcp' || record.auth !== 'oauth') return record;
      const linked = native.find(
        connection =>
          connection.provider === record.provider &&
          (!record.account || record.account === connection.account),
      );

      return {
        ...record,
        secret: linked?.secret,
        account: linked?.account ?? record.account,
      };
    });

  return [
    ...records,
    ...native.filter(
      connection =>
        !records.some(
          record =>
            record.id === connection.id ||
            (record.owner === owner &&
              record.provider === connection.provider &&
              record.account === connection.account),
        ),
    ),
  ];
}

export async function findConnection(
  ctx: ConnectionContext,
  id: string,
  owner?: string,
): Promise<Connection | undefined> {
  const stored = await ctx.store.get('connection', id);
  if (stored) return !stored.owner || stored.owner === owner ? stored : undefined;

  return (await nativeConnections(ctx, owner)).find(connection => connection.id === id);
}

export async function completeNativeConnection(
  ctx: ConnectionContext,
  owner: string,
  provider: string,
  account: string,
): Promise<void> {
  for (const { id, value } of await ctx.store.list('connection')) {
    if (
      value.owner !== owner ||
      value.provider !== provider ||
      value.auth !== 'oauth' ||
      (value.account && value.account !== account)
    )
      continue;
    await ctx.store.withAppLock(`connection:${id}`, async store => {
      const current = await store.get('connection', id);
      if (
        !current ||
        current.owner !== owner ||
        current.provider !== provider ||
        (current.account && current.account !== account)
      )
        return;
      await store.put('connection', id, {
        ...current,
        account,
        broken: undefined,
        secret: undefined,
        updatedAt: (ctx.now ?? Date.now)(),
      });
    });
  }
}

export async function connectionAllowed(
  req: Request,
  ctx: ServerContext,
  params: Params,
): Promise<ServerContext | Response> {
  if (req.method === 'GET') return ctx;
  if (!params.id) {
    const input = await req
      .clone()
      .json()
      .catch(() => undefined);
    if (input?.owner === 'me')
      return ctx.auth && ctx.session && !ctx.local
        ? ctx
        : json({ error: 'Personal connections need a signed-in member' }, 400);
  } else {
    const connection = await findConnection(ctx, params.id, ctx.session?.user.id);
    if (!connection) return json({ error: 'Unknown connection' }, 404);
    if (connection.owner === ctx.session?.user.id && connection.owner) return ctx;
  }

  return requireWorkspaceAdmin(
    ctx,
    'Only workspace owners and admins can manage workspace connections',
  );
}

class OAuthClientRequired extends Error {}

export async function nativeApp(
  ctx: ConnectionContext,
  provider: string,
  id?: string,
  apps?: AgentApp[],
): Promise<AgentApp | undefined> {
  const user = ctx.integrations[provider]?.auth.user;
  if (!user) return;
  if (!apps) {
    const [shared, own] = await Promise.all([sharedApps(ctx), ctx.store.list('app')]);
    apps = [...shared, ...own.map(row => row.value)];
  }

  return apps.find(app => {
    if (app.integration !== provider || (id && app.id !== id)) return false;
    try {
      user.authorizeUrl(decryptSecret(ctx.config, app.credentials), {
        publicUrl: ctx.config.publicUrl ?? 'https://coder.invalid',
        state: '',
      });
      return true;
    } catch {
      return false;
    }
  });
}

async function authorization(
  ctx: ServerContext,
  connection: Connection,
  discovered?: Awaited<ReturnType<typeof oauthResource>>,
): Promise<string> {
  if (connection.provider === 'mcp') return authorizeUrl(ctx, connection, discovered);
  if (!(await nativeApp(ctx, connection.provider)))
    throw new OAuthClientRequired(
      `No OAuth client is available for ${ctx.integrations[connection.provider]?.name ?? connection.provider}.`,
    );

  const query = new URLSearchParams({
    connection: connection.id,
    organization: ctx.organizationId,
    attempt: randomBytes(18).toString('base64url'),
  });

  return `/connect/${encodeURIComponent(connection.provider)}?${query}`;
}

export class ConnectionError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly needs?: 'key',
  ) {
    super(message);
  }
}

const refuse = (status: number, message: string) => new ConnectionError(status, message);

async function respond(work: () => Promise<unknown>, status = 200): Promise<Response> {
  try {
    return json(await work(), status);
  } catch (error) {
    if (error instanceof ConnectionError)
      return json(
        { error: error.message, ...(error.needs ? { needs: error.needs } : {}) },
        error.status,
      );
    throw error;
  }
}

async function readBody(req: Request): Promise<unknown> {
  return req.json().catch(() => undefined);
}

/** The connections the viewer sees, as rows. */
export async function connectionRows(
  ctx: ServerContext,
  authorization?: string,
): Promise<ConnectionRow[]> {
  const owner = ctx.session?.user.id;
  const records = await visibleConnections(ctx, owner, 'oauth');
  const receipt = authorization
    ? await ctx.store.get('delivery', `connection-authorized:${authorization}`)
    : undefined;

  return records.map(connection => {
    const row = connectionRow(connection, owner, ctx.config);
    if (
      authorization &&
      connection.auth === 'oauth' &&
      (!receipt ||
        !('target' in receipt) ||
        receipt.target !== `${connection.id}:${connection.createdAt}`)
    )
      row.status = 'authorize';

    return row;
  });
}

/** The credential an `env` connection reads: `key` saved as `name` in its scope, the named one, else a visible one holding `name`. */
async function envCredential(
  ctx: ServerContext,
  name: string,
  input: { key?: string; credential?: string },
  owner?: string,
): Promise<{ id: string; created?: true }> {
  if (input.key && input.credential) throw refuse(400, 'Give a key or a credential, not both');
  if (input.key) {
    const { id, replaced } = await addCredential(
      ctx.store,
      ctx.config,
      { ...(owner ? { owner } : {}), env: { [name]: input.key } },
      ctx.now ?? Date.now,
    );

    return replaced ? { id } : { id, created: true };
  }
  const rows = (await visibleCredentials(ctx.store, owner)).filter(
    row => decryptCredential(ctx.config, row.value).env[name] !== undefined,
  );
  const found = input.credential
    ? rows.find(row => row.id === input.credential)
    : (rows.find(row => owner && row.value.owner === owner) ?? rows.find(row => !row.value.owner));
  if (!found)
    throw refuse(
      400,
      input.credential
        ? `Credential ${input.credential} does not hold ${name}`
        : `No credential holds ${name}; give its key`,
    );

  return { id: found.id };
}

/** Save `key` as an `env` connection's variable in the connection's scope. */
async function rotateEnvCredential(
  ctx: ServerContext,
  connection: Connection,
  key: string,
): Promise<string> {
  const name = (connection.keyIn as { env: string }).env;

  return (await envCredential(ctx, name, { key }, connection.owner)).id;
}

/** Create a connection from `body`; an OAuth one also returns where the browser goes next. */
export async function addConnection(
  ctx: ServerContext,
  body: unknown,
): Promise<ConnectionRow & { authorize?: string }> {
  const parsed = inputSchema.safeParse(body);
  if (!parsed.success) throw refuse(400, 'Invalid connection');
  const input = parsed.data;
  const id =
    input.id ??
    input.name
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '');
  if (!slug.safeParse(id).success) throw refuse(400, 'Invalid connection id');
  const provider = input.provider ?? 'mcp';
  const owner = input.owner === 'me' ? ctx.session!.user.id : undefined;
  if (provider !== 'mcp' && provider !== 'env' && !ctx.integrations[provider]?.auth.user)
    throw refuse(400, 'This integration does not support user OAuth');
  if (provider === 'env' && input.auth && input.auth !== 'key')
    throw refuse(400, 'Environment connections require a key');
  if (provider !== 'env' && input.credential)
    throw refuse(400, 'Only environment connections use a credential');
  const auth =
    provider === 'env'
      ? 'key'
      : provider !== 'mcp'
        ? 'oauth'
        : (input.auth ?? (input.key ? 'key' : 'none'));
  if (auth === 'key' && !input.key && provider !== 'env') throw refuse(400, 'A key is required');
  if (input.key && auth !== 'key') throw refuse(400, 'A key needs key authentication');
  const connection: Connection = {
    id: owner ? `${owner}:${id}` : id,
    name: input.name,
    provider,
    ...(owner ? { owner } : {}),
    ...(input.access || provider === 'env' || provider === 'mcp'
      ? { access: input.access ?? (provider === 'env' ? 'write' : 'read') }
      : {}),
    auth,
    ...(input.endpoint ? { endpoint: input.endpoint } : {}),
    ...(input.keyIn ? { keyIn: input.keyIn } : {}),
    ...(input.key && provider !== 'env'
      ? { secret: encryptSecret(ctx.config, { key: input.key }) }
      : {}),
    createdAt: (ctx.now ?? Date.now)(),
  };
  if (!endpointAllowed(ctx, connection)) throw refuse(400, 'Invalid endpoint or read-only tools');
  if (await ctx.store.get('connection', connection.id))
    throw refuse(409, 'Connection already exists');
  let discovered: Awaited<ReturnType<typeof oauthResource>>;
  if (provider === 'mcp' && input.endpoint?.url && !input.auth && !input.key) {
    try {
      discovered = await oauthResource(ctx, input.endpoint.url, true);
      if (!discovered) {
        try {
          await connectionMcp({ ...connection, access: 'write' }, undefined, ctx.fetch);
        } catch (error) {
          if (!(error instanceof ConnectionRefused) || !error.authenticate) throw error;
          discovered = await oauthResource(ctx, input.endpoint.url, true, error.authenticate);
          if (!discovered) throw error;
        }
      }
      if (discovered) connection.auth = 'oauth';
    } catch (error) {
      if (error instanceof ConnectionRefused)
        throw new ConnectionError(
          400,
          `${new URL(input.endpoint.url).hostname} takes a key, not a sign-in.`,
          'key',
        );
      console.error('coder server: connection discovery failed', error);
      throw refuse(502, 'Could not start authorization');
    }
    if (connection.auth === 'oauth' && ctx.local?.port === 0)
      throw refuse(
        400,
        'Signing in needs a Coder server. Repeat with --server <url>, or add it in coder dash.',
      );
  }
  const credential =
    provider === 'env'
      ? await envCredential(ctx, (input.keyIn as { env: string }).env, input, owner)
      : undefined;
  if (credential) connection.credential = credential.id;
  const created = await ctx.store.withAppLock(`connection:${connection.id}`, store =>
    store.create('connection', connection.id, connection),
  );
  if (!created) {
    if (credential?.created) await removeCredential(ctx.store, credential.id);
    throw refuse(409, 'Connection already exists');
  }
  try {
    const authorize =
      connection.auth === 'oauth' ? await authorization(ctx, connection, discovered) : undefined;

    return {
      ...connectionRow(connection, owner, ctx.config),
      ...(authorize ? { authorize } : {}),
    };
  } catch (error) {
    if (!(error instanceof OAuthClientRequired))
      console.error('coder server: connection authorization failed', error);
    await ctx.store.withAppLock(`connection:${connection.id}`, async store => {
      const current = await store.get('connection', connection.id);
      if (isDeepStrictEqual(current, connection)) await store.delete('connection', connection.id);
    });
    throw error instanceof OAuthClientRequired
      ? refuse(400, error.message)
      : refuse(502, 'Could not start authorization');
  }
}

/** Rename, change access, or rotate the key of a connection; a new key clears its reconnect state. */
export async function changeConnection(
  ctx: ServerContext,
  id: string,
  body: unknown,
): Promise<ConnectionRow> {
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) throw refuse(400, 'Invalid connection settings');

  return ctx.store.withAppLock(`connection:${id}`, async store => {
    const current = await findConnection({ ...ctx, store }, id, ctx.session?.user.id);
    if (!current) throw refuse(404, 'Unknown connection');
    const { key, access, ...settings } = parsed.data;
    if (key && current.auth !== 'key') throw refuse(400, 'This connection does not use a key');
    const { access: _, ...kept } = current;
    const next = {
      ...(access === null ? kept : current),
      ...settings,
      ...(access ? { access } : {}),
      ...(key && current.provider !== 'env' ? { secret: encryptSecret(ctx.config, { key }) } : {}),
      ...(key ? { broken: undefined } : {}),
      updatedAt: (ctx.now ?? Date.now)(),
    };
    if (!endpointAllowed(ctx, next)) throw refuse(400, 'Invalid read-only tools');
    if (key && current.provider === 'env')
      next.credential = await rotateEnvCredential({ ...ctx, store }, current, key);
    await store.put('connection', next.id, next);

    return connectionRow(next, ctx.session?.user.id, ctx.config);
  });
}

/** Remove a connection; a member's native one also unlinks that account. Its credential stays. */
export async function removeConnection(ctx: ServerContext, id: string): Promise<void> {
  await ctx.store.withAppLock(`connection:${id}`, async store => {
    const connection = await findConnection({ ...ctx, store }, id, ctx.session?.user.id);
    if (!connection) throw refuse(404, 'Unknown connection');
    if (connection.owner && connection.provider !== 'mcp' && connection.provider !== 'env') {
      const accounts = (await ctx.auth?.linkedAccounts?.(connection.owner, store)) ?? [];
      for (const account of accounts.filter(
        account =>
          account.platform === connection.provider &&
          (!connection.account || account.platformUserId === connection.account),
      ))
        await ctx.auth?.unlink?.(connection.owner, account.platform, account.platformUserId, store);
    }
    await store.delete('connection', connection.id);
  });
}

/** Where the browser goes to finish, or redo, an OAuth connection. */
export async function connectionAuthorization(ctx: ServerContext, id: string): Promise<string> {
  const connection = await findConnection(ctx, id, ctx.session?.user.id);
  if (!connection || connection.auth !== 'oauth') throw refuse(404, 'Unknown OAuth connection');
  try {
    return await authorization(ctx, connection);
  } catch (error) {
    if (!(error instanceof OAuthClientRequired))
      console.error('coder server: connection authorization failed', error);
    throw error instanceof OAuthClientRequired
      ? refuse(400, error.message)
      : refuse(502, 'Could not start authorization');
  }
}

export async function listConnections(req: Request, ctx: ServerContext): Promise<Response> {
  const url = new URL(req.url);
  const authorization = url.searchParams.get('authorization') ?? undefined;
  const waiting = url.searchParams.get('wait');
  if (!authorization || !waiting) return json(await connectionRows(ctx, authorization));
  const changes = await ctx.store.watch('delivery', `connection-authorized:${authorization}`);
  const deadline = Date.now() + 25000;
  try {
    for (;;) {
      const rows = await connectionRows(ctx, authorization);
      const row = rows.find(row => row.id === waiting);
      if (!row || row.status === 'ok' || Date.now() >= deadline || req.signal.aborted)
        return json(rows);
      await changes.wait(Math.min(10000, deadline - Date.now()), req.signal);
    }
  } finally {
    changes.close();
  }
}

export async function createConnection(req: Request, ctx: ServerContext): Promise<Response> {
  const body = await readBody(req);

  return respond(() => addConnection(ctx, body), 201);
}

export async function updateConnection(
  req: Request,
  ctx: ServerContext,
  params: Params,
): Promise<Response> {
  const body = await readBody(req);

  return respond(() => changeConnection(ctx, params.id!, body));
}

export async function deleteConnection(
  req: Request,
  ctx: ServerContext,
  params: Params,
): Promise<Response> {
  return respond(async () => {
    await removeConnection(ctx, params.id!);

    return { ok: true };
  });
}

export async function authorizeConnection(
  req: Request,
  ctx: ServerContext,
  params: Params,
): Promise<Response> {
  return respond(async () => ({ url: await connectionAuthorization(ctx, params.id!) }));
}
