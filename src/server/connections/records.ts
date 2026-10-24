import { createHash, randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import * as z from 'zod/mini';
import type { AgentApp, Connection, ModelAttempt } from '../../agent/types';
import type { Integration } from '../../integrations/types';
import { handleKey, serverName } from '../../agent/mcp';
import type { ConnectionRow } from '../../client/types';
import { ACCESS, mcpEntrySchema } from '../../core/config';
import { mcpSecretValue } from '../../core/mcp';
import {
  connectionServerName,
  connectionToolName,
  connectionUrlAllowed,
  connectionMcp,
  ConnectionRefused,
  mcpClient,
} from '../../core/connections';
import { connectionEnvName } from '../../core/connection-env';
import type { LinkedAccount, ServerContext } from '../context';
import type { TaskStatus } from '../store/types';
import type { Params } from '../routes/match';
import { json } from '../routes/http';
import { requireWorkspaceAdmin } from '../routes/guards';
import { encryptSecret, decryptSecret, decryptCredential } from '../store/secrets';
import { authorizeUrl, oauthResource } from './oauth';
import { sharedApps } from '../agents/apps';
import { defaultAgent } from '../../agent/load';
import {
  addCredential,
  connectionFix,
  parseCredentialId,
  removeCredential,
  visibleCredentials,
  type ModelRun,
} from '../settings/credentials';

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

/** How long an account's connect notice in a task is remembered, as long as its conversation. */
const NOTICE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

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
  scope: z.optional(z.enum(['personal', 'workspace'])),
  access: z.optional(z.enum(ACCESS)),
  endpoint: z.optional(mcpEntrySchema),
  auth: z.optional(z.enum(['none', 'key', 'oauth'])),
  key: z.optional(z.string().check(z.minLength(1))),
  keyIn: z.optional(keyIn),
  credential: z.optional(z.string().check(z.minLength(1))),
});
const patchSchema = z.strictObject({
  name: z.optional(z.string().check(z.minLength(1))),
  access: z.optional(z.enum(ACCESS)),
  key: z.optional(z.string().check(z.minLength(1))),
});

function endpointAllowed(ctx: ServerContext, connection: Connection): boolean {
  const endpoint = connection.endpoint;
  if (connection.provider === 'env')
    return (
      !endpoint &&
      connection.auth === 'key' &&
      connection.access === 'auto' &&
      !!connection.keyIn &&
      'env' in connection.keyIn &&
      connectionEnvName(connection.keyIn.env)
    );
  if (connection.provider !== 'mcp') return !endpoint;
  if (
    !endpoint ||
    (endpoint.command && connection.access === 'read-only' && !endpoint.tools?.length)
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
  ownerName?: string,
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
    scope: connection.owner ? 'personal' : 'workspace',
    auth: connection.auth,
    ...(connection.access ? { access: connection.access } : {}),
    ...(connection.owner
      ? {
          owner: { id: connection.owner, ...(ownerName ? { name: ownerName } : {}) },
          ...(viewer === connection.owner ? { asker: true as const } : {}),
        }
      : {}),
    ...(connection.endpoint?.url ? { url: connection.endpoint.url } : {}),
    ...(connection.endpoint?.command ? { command: connection.endpoint.command } : {}),
    ...(connection.provider === 'env' && connection.keyIn && 'env' in connection.keyIn
      ? { env: connection.keyIn.env }
      : {}),
    ...(connection.account ? { account: connection.login ?? connection.account } : {}),
    status:
      connection.broken || (connection.auth === 'oauth' && !authorized)
        ? 'needs-auth'
        : 'connected',
    createdAt: connection.createdAt,
  };
}

export function nativeCredential(config: ConnectionContext['config'], sealed: string) {
  const value = decryptSecret<string | { app: string; token: string }>(config, sealed);

  return typeof value === 'string' ? { token: value, app: undefined } : value;
}

/** The connection id of a member's link to a platform account. */
export const nativeConnectionId = (owner: string, platform: string, platformUserId: string) =>
  `${owner}:${platform}-${createHash('sha256').update(platformUserId).digest('hex').slice(0, 12)}`;

/** `accounts` are the owner's linked accounts when the caller read them already. */
export async function nativeConnections(
  ctx: ConnectionContext,
  owner?: string,
  accounts?: LinkedAccount[],
): Promise<Connection[]> {
  if (!owner || !ctx.auth?.linkedAccounts) return [];
  return linkedConnections(
    ctx,
    owner,
    accounts ?? (await ctx.auth.linkedAccounts(owner, ctx.store)),
  );
}

function linkedConnections(
  ctx: ConnectionContext,
  owner: string,
  accounts: LinkedAccount[],
): Connection[] {
  return accounts
    .filter(
      account =>
        account.token &&
        account.organizationId === ctx.organizationId &&
        account.organizations?.includes(ctx.organizationId) &&
        ctx.integrations[account.platform]?.auth.user,
    )
    .map(account => ({
      id: nativeConnectionId(owner, account.platform, account.platformUserId),
      name: ctx.integrations[account.platform]!.name ?? account.platform,
      provider: account.platform,
      owner,
      auth: 'oauth',
      secret: account.token,
      account: account.platformUserId,
      ...(account.login ? { login: account.login } : {}),
      oauthApp: nativeCredential(ctx.config, account.token!).app,
      ...(account.refusedAt
        ? { broken: { at: account.refusedAt, reason: 'Needs reconnecting' } }
        : {}),
      createdAt: 0,
    }));
}

/** Every member's linked accounts in one read where the sign-in layer lists them, else those of `owners`. */
async function memberAccounts(
  ctx: ConnectionContext,
  owners: string[],
): Promise<Array<LinkedAccount & { userId: string }>> {
  if (ctx.auth?.organizationAccounts)
    return ctx.auth.organizationAccounts(ctx.organizationId, ctx.store);
  if (!ctx.auth?.linkedAccounts) return [];
  const linked = await Promise.all(
    owners.map(async userId =>
      (await ctx.auth!.linkedAccounts!(userId, ctx.store)).map(account => ({ ...account, userId })),
    ),
  );

  return linked.flat();
}

/** Asks a platform account that names no member to connect, when its turn skipped a Claude or Codex entry that an unconnected member's own subscription has: `notice` once per account per task, `failure` for a turn nothing ran. */
export async function connectNotice(
  ctx: ServerContext,
  integration: Integration,
  input: {
    task: string;
    actor: string;
    models: ModelRun[];
    attempts: ModelAttempt[];
    slug?: string;
  },
): Promise<{ url: string; failure: string; notice?: string } | undefined> {
  const { models, attempts } = input;
  const skipped = models
    .filter(
      run =>
        (run.option.engine === 'claude' || run.option.engine === 'codex') &&
        !attempts.some(attempt => attempt.model === run.model),
    )
    .map(run => run.option.engine);
  if (!skipped.length) return undefined;
  const owners = [
    ...new Set(
      (await ctx.store.list('credential')).flatMap(({ id }) => {
        const { owner, name } = parseCredentialId(id);
        return owner && skipped.some(engine => engine === name) ? [owner] : [];
      }),
    ),
  ];
  if (!owners.length) return undefined;
  const linked = (await memberAccounts(ctx, owners)).filter(
    account => account.platform === integration.id,
  );
  if (owners.every(owner => linked.some(account => account.userId === owner))) return undefined;
  const url = await connectionFix(ctx, integration.id, input.slug);
  const line = `[Connect ${integration.name}](${url}) to run on a personal subscription.`;
  const first = await ctx.store.create(
    'delivery',
    `notice:${input.task}:${integration.id}:${input.actor}`,
    { at: (ctx.now ?? Date.now)() },
    { ttlMs: NOTICE_TTL_MS },
  );

  return { url, failure: `No model could run. ${line}`, ...(first ? { notice: line } : {}) };
}

async function visibleRecords(
  ctx: ConnectionContext,
  owner?: string,
  secrets?: 'oauth' | 'all',
): Promise<Connection[]> {
  return (await ctx.store.list('connection', { visibleTo: owner, secrets }))
    .map(row => row.value)
    .filter(connection => !connection.owner || connection.owner === owner);
}

async function visibleConnections(
  ctx: ConnectionContext,
  owner?: string,
  secrets?: 'oauth' | 'all',
): Promise<Connection[]> {
  const native = await nativeConnections(ctx, owner);

  return withLinks(await visibleRecords(ctx, owner, secrets), native);
}

/** Whether a workspace connection or one of `viewer`'s own needs signing in again. */
export async function needsReconnect(ctx: ConnectionContext, viewer?: string): Promise<boolean> {
  return (await visibleConnections(ctx, viewer, 'oauth')).some(
    connection => connectionRow(connection, viewer, ctx.config).status === 'needs-auth',
  );
}

/** Members' platform records with their linked accounts' tokens, then the linked accounts no record holds. */
function withLinks(stored: Connection[], native: Connection[]): Connection[] {
  const records = stored.map(record => {
    if (!record.owner || record.provider === 'mcp' || record.auth !== 'oauth') return record;
    const linked = native.find(
      connection =>
        connection.owner === record.owner &&
        connection.provider === record.provider &&
        (!record.account || record.account === connection.account),
    );

    return {
      ...record,
      secret: linked?.secret,
      account: linked?.account ?? record.account,
      ...(linked?.login ? { login: linked.login } : {}),
      ...(linked?.broken && !record.broken ? { broken: linked.broken } : {}),
    };
  });

  return [
    ...records,
    ...native.filter(
      connection =>
        !records.some(
          record =>
            record.id === connection.id ||
            (record.owner === connection.owner &&
              record.provider === connection.provider &&
              record.account === connection.account),
        ),
    ),
  ];
}

/** `accounts` are the owner's linked accounts when the caller read them already. */
export async function findConnection(
  ctx: ConnectionContext,
  id: string,
  owner?: string,
  accounts?: LinkedAccount[],
): Promise<Connection | undefined> {
  const stored = await ctx.store.get('connection', id);
  if (stored) return !stored.owner || stored.owner === owner ? stored : undefined;

  return (await nativeConnections(ctx, owner, accounts)).find(connection => connection.id === id);
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
    if (
      input?.scope === 'personal' ||
      (input?.provider && !['mcp', 'env'].includes(input.provider))
    )
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
    // TODO: a picker naming each agent's app when more than one can sign in.
    const builtin = defaultAgent();
    const owned = own.map(row => row.value);
    apps = [
      ...shared,
      ...owned.filter(app => app.agent === builtin),
      ...owned.filter(app => app.agent !== builtin),
    ];
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

/** Every workspace connection and every member's own, as rows; a task's mark those it is not granted `disabled` and name the server of those it has. */
export async function connectionRows(
  ctx: ServerContext,
  authorization?: string,
): Promise<ConnectionRow[]> {
  // In a task, `asker` marks the rows of the member who asked this turn, in any conversation.
  const viewer = ctx.session?.user.id ?? ctx.taskPrincipal?.asker;
  const taskRead = ctx.taskPrincipal
    ? ctx.store.get('task', ctx.taskPrincipal.task).then(status => status?.task)
    : Promise.resolve(undefined);
  const apps = appRows(ctx, taskRead).catch(error => {
    console.error('coder server: could not list app installations', error);
    return [];
  });
  const stored = (await ctx.store.list('connection', { secrets: 'oauth' })).map(row => row.value);
  const accounts = await memberAccounts(ctx, [
    ...new Set([
      ...stored.flatMap(connection => connection.owner ?? []),
      ...(viewer ? [viewer] : []),
    ]),
  ]);
  const names = new Map(accounts.map(account => [account.userId, account.name]));
  if (ctx.session?.user.name) names.set(ctx.session.user.id, ctx.session.user.name);
  const records = withLinks(
    stored,
    accounts.flatMap(account => linkedConnections(ctx, account.userId, [account])),
  );
  const receipt = authorization
    ? await ctx.store.get('delivery', `connection-authorized:${authorization}`)
    : undefined;
  const task = await taskRead;
  const granted =
    task && new Set((await (await import('./resolve')).turnConnections(ctx, task)).ids);

  const rows = records.map(connection => {
    const row = connectionRow(
      connection,
      viewer,
      ctx.config,
      connection.owner && names.get(connection.owner),
    );
    if (
      authorization &&
      connection.auth === 'oauth' &&
      (!receipt ||
        !('target' in receipt) ||
        receipt.target !== `${connection.id}:${connection.createdAt}`)
    )
      row.status = 'needs-auth';
    if (granted && !granted.has(connection.id)) row.status = 'disabled';
    else if (granted && connection.provider !== 'env')
      row.server = connectionServerName(connection);

    return row;
  });

  return [...rows, ...(await apps)];
}

/** One workspace row per live installation of an agent's app; a task has the tool servers of its own agent's. */
async function appRows(
  ctx: ServerContext,
  taskRead: Promise<TaskStatus['task'] | undefined>,
): Promise<ConnectionRow[]> {
  const own = ctx.store.list('app');
  const [installations, stored, shared, task] = await Promise.all([
    ctx.store.list('installation', { active: true }),
    own,
    sharedApps(ctx, own),
    taskRead,
  ]);
  const apps = new Map([...stored.map(row => row.value), ...shared].map(app => [app.id, app]));
  const slugs = [...new Set(installations.flatMap(row => apps.get(row.value.app)?.agent ?? []))];
  const agents = new Map(
    (slugs.length ? await ctx.store.listAgentsWithVersions(slugs) : []).map(entry => [
      entry.record.id,
      entry,
    ]),
  );
  const event = task?.event && `${task.event.appId}:${task.event.installationId}`;

  return installations.flatMap(({ id, value }) => {
    const app = apps.get(value.app);
    const integration = ctx.integrations[value.integration];
    if (!app || !integration) return [];
    const agent = agents.get(app.agent);
    const readOnly =
      agent?.version?.definition.access === 'read-only' ||
      agent?.record.settings?.access === 'read-only';
    const row: ConnectionRow = {
      id,
      name: integration.name,
      provider: value.integration,
      scope: 'workspace',
      agent: app.agent,
      ...(readOnly ? { access: 'read-only' as const } : {}),
      auth: 'none',
      account: `${agent?.record.name ?? app.name}'s app in ${value.account.login}`,
      status: 'connected',
      createdAt: value.createdAt,
    };
    if (!task) return [row];
    if (
      app.agent !== task.agent ||
      !(value.integration in task.tools) ||
      (!task.event && !task.parent)
    )
      row.status = 'disabled';
    else
      row.server = serverName(
        handleKey(value.integration, id === event ? undefined : value.account.login),
      );

    return [row];
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
  // `connectionServerName` gives a member's own `<name>-user`.
  if (id.endsWith('-user'))
    throw refuse(400, "Names ending in -user are kept for members' own connections");
  const provider = input.provider ?? 'mcp';
  const personal = provider !== 'mcp' && provider !== 'env';
  if (personal && input.scope !== undefined)
    throw refuse(400, 'Platform connections are personal and take no scope.');
  const owner = personal || input.scope === 'personal' ? ctx.session?.user.id : undefined;
  if ((personal || input.scope === 'personal') && (!owner || !ctx.auth || ctx.local))
    throw refuse(400, 'Personal connections need a signed-in member');
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
    ...(input.access || provider === 'env' ? { access: input.access ?? 'auto' } : {}),
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
          const client = await mcpClient(
            connectionMcp({ ...connection, access: 'auto' }, undefined),
            ctx.fetch,
            AbortSignal.timeout(5_000),
          );
          await client.initialize().finally(() => client.close());
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
      ...connectionRow(connection, owner, ctx.config, ctx.session?.user.name),
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
    const next = {
      ...current,
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

    return connectionRow(next, ctx.session?.user.id, ctx.config, ctx.session?.user.name);
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
      if (!row || row.status === 'connected' || Date.now() >= deadline || req.signal.aborted)
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

export async function connectionGrants(
  ctx: ConnectionContext,
  requestedBy?: string,
  allowed?: string[],
): Promise<string[]> {
  const rows = await visibleConnections(ctx, requestedBy);

  return rows
    .filter(connection => allowed === undefined || allowed.includes(connection.id))
    .map(connection => connection.id);
}

/** A member's own connections the agent allows, and the linked accounts read for them. */
export interface PersonalGrants {
  ids: string[];
  accounts: LinkedAccount[];
}

/** A member's own connections the agent allows, offered on the turns they ask for. */
export async function personalGrants(
  ctx: ConnectionContext,
  owner: string,
  allowed?: string[],
): Promise<PersonalGrants> {
  const [accounts, records] = await Promise.all([
    ctx.auth?.linkedAccounts ? ctx.auth.linkedAccounts(owner, ctx.store) : [],
    visibleRecords(ctx, owner),
  ]);
  const ids = withLinks(records, await nativeConnections(ctx, owner, accounts))
    .filter(
      connection =>
        connection.owner === owner && (allowed === undefined || allowed.includes(connection.id)),
    )
    .map(connection => connection.id);

  return { ids, accounts };
}
