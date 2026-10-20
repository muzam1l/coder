import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { eventOptions } from '../../agent/definition';
import { decryptCredential, decryptSecret, encryptSecret } from '../store/secrets';
import {
  BROKERED,
  BROKERED_PLACEHOLDER,
  engineHosts,
  type BrokerRule,
} from '../runners/vercel-sandbox';
import type { Integration, TokenBound } from '../../integrations/types';
import type { AgentEvent, Installation } from '../../agent/types';
import type { EngineCredential, Store, TaskStatus } from '../store/types';
import { dropKey, heldKey, type HeldToken } from '../store/tokens';
import type { ServerContext } from '../context';
import type { CoderConfig } from '../../core/config';
import { taskConfig } from '../settings/config';
import { resolveCredential } from '../settings/credentials';
import {
  resolvedTaskConnections,
  connectionSecretValues,
  taskConnectionSecrets,
  readTaskConnectionSecrets,
} from '../connections/resolve';
import type { McpServerSpec } from '../../core/types';
import { taskWarnings } from './logs';
import { LocalStore } from '../store/local';
import { mcpSecretValue } from '../../core/mcp';
import { findConnection, nativeCredential, nativeApp } from '../connections/records';
import { updateMetadata } from '../store';
import { handleKey } from '../../agent/mcp';

/** Installation tokens are encrypted at rest; integrations see plaintext only in memory. */
export function unsealed(ctx: ServerContext, installation: Installation): Installation {
  return installation.token
    ? {
        ...installation,
        token: decryptSecret<string>(ctx.config, installation.token),
      }
    : installation;
}

/** A held token is reused only while more than this remains. */
const REUSE_MARGIN_MS = 5 * 60 * 1000;

export {
  dropKey,
  heldKey,
  type HeldToken,
  type HeldWrite,
  type TokenDrop,
  type TokenState,
} from '../store/tokens';
/** Outlives any mint in flight when tokens are dropped. */
const DROP_FENCE_TTL_MS = 60 * 60 * 1000;

/** Forgets every token held for an installation, or given an app id, for all of its installations. */
export async function dropTokens(store: Store, id: string): Promise<void> {
  await store.put('snapshot', dropKey(id), { drop: randomUUID() }, { ttlMs: DROP_FENCE_TTL_MS });
  for (const row of await store.list<HeldToken>('snapshot', { prefix: heldKey(id) }))
    await store.delete('snapshot', row.id);
}

export async function uninstall(store: Store, id: string, now: number): Promise<void> {
  await store.withAppLock(`installation:${id}`, async locked => {
    const current = await locked.get('installation', id);
    if (!current || current.deletedAt) return;
    await updateMetadata(locked, 'installation', id, { deletedAt: now, uninstalled: true });
    await dropTokens(locked, id);
  });
}

/** The installation's token through its integration, reused from the store per exact scope where it can be; a refreshed one is stored again, sealed. A task's token must outlive `taskMs`. */
export async function installationToken(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  credentials: unknown,
  bound?: TokenBound,
  taskMs = 0,
): Promise<string> {
  const expected = installation.token;
  const read = unsealed(ctx, installation);
  return integration.auth.token(read, credentials, bound, {
    fetch: ctx.fetch,
    async hold(reuse, mint) {
      const key = heldKey(installation.id, reuse);
      const state = await ctx.store.heldTokens([installation.id], [installation.app]);
      const held = state.held.get(key);
      const now = (ctx.now ?? Date.now)();
      // A task's token covers its timeout, plus the margin when a fresh one would.
      const fresh = held ? held.expiresAt - held.mintedAt : 0;
      const needed = taskMs + (taskMs + REUSE_MARGIN_MS <= fresh ? REUSE_MARGIN_MS : 0);
      if (held && held.expiresAt - now > Math.max(needed, REUSE_MARGIN_MS)) {
        try {
          return decryptSecret<string>(ctx.config, held.token);
        } catch (error) {
          console.error('coder server: held token unreadable, minting again', error);
        }
      }

      // Held only while the drops it was read under stand, so a mint that began before a drop is never kept.
      const minted = await mint();
      await ctx.store.holdToken({
        key,
        value: {
          token: encryptSecret(ctx.config, minted.token),
          expiresAt: minted.expiresAt,
          mintedAt: now,
        },
        ttlMs: Math.max(minted.expiresAt - now - REUSE_MARGIN_MS, 0),
        drops: [installation.id, installation.app].map(id => ({
          key: dropKey(id),
          drop: state.drops.get(dropKey(id)),
        })),
      });

      return minted.token;
    },
    // Lands only over the exact token it refreshed, or that token resealed; otherwise another refresh won.
    async save(token) {
      const sealed = encryptSecret(ctx.config, token);
      let winner: string | undefined;
      await ctx.store.withCredential('installation', installation.id, async current => {
        if (!current) return undefined;
        const same =
          current.token === expected ||
          (!!current.token && decryptSecret<string>(ctx.config, current.token) === read.token);
        if (!same) {
          winner = current.token;
          return undefined;
        }

        return [{ id: installation.id, value: { ...current, token: sealed } }];
      });
      installation.token = winner ?? sealed;

      return winner && decryptSecret<string>(ctx.config, winner);
    },
  });
}

/** A platform installation an event may act through; its token is minted on first use. */
export interface PlatformAccess {
  /** The installation's store id. */
  installation: string;
  record?: Installation;
  /** A read token for the whole installation. */
  token(): Promise<string | undefined>;
  fetch: typeof fetch;
}

/** Access by integration id. */
export type TokenSource = (integration: string) => Promise<PlatformAccess | undefined>;

/** An event's access, with every token it minted. */
export type EventTokens = TokenSource & { minted: string[] };

/** The linked member's own platform token, refreshed and stored again when it had expired. */
export async function requesterToken(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  credentials: unknown,
): Promise<string | undefined> {
  if (!integration.auth.user || !ctx.auth) return undefined;
  const user = await ctx.auth.linkedUser(integration.id, event.actor.id);
  if (!user?.token || !user.organizations?.includes(ctx.organizationId)) return undefined;
  const stored = nativeCredential(ctx.config, user.token);
  const needsApp = stored.app && stored.app !== event.appId;
  const app = needsApp ? await nativeApp(ctx, integration.id, stored.app) : undefined;
  if (needsApp && !app) return undefined;
  const access = await integration.auth.user.access(
    stored.token,
    app ? decryptSecret(ctx.config, app.credentials) : credentials,
    { fetch: ctx.fetch ?? fetch, now: (ctx.now ?? Date.now)() },
  );
  if (access.refreshed)
    await ctx.auth.link(user, integration.id, event.actor.id, {
      token: encryptSecret(
        ctx.config,
        stored.app ? { app: stored.app, token: access.refreshed } : access.refreshed,
      ),
    });
  return access.accessToken;
}

/** A task's platform token: the requester's own when its trigger acts as them, else the installation's narrowed to `bound`. */
export async function taskToken(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  event: AgentEvent,
  credentials: unknown,
  bound: TokenBound,
  actAs?: 'requester',
): Promise<string> {
  const own =
    actAs === 'requester'
      ? await requesterToken(ctx, integration, event, credentials).catch(() => undefined)
      : undefined;
  return (
    own ??
    installationToken(ctx, integration, installation, credentials, bound, ctx.config.taskTimeoutMs)
  );
}

/** Dispatch's access: the event installation's read token, minted once when asked for. */
export function dispatchTokens(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  event: AgentEvent,
  credentials: unknown,
): EventTokens {
  const minted: string[] = [];
  let token: Promise<string | undefined> | undefined;
  const access: PlatformAccess = {
    installation: installation.id,
    record: installation,
    fetch: ctx.fetch ?? fetch,
    token: () =>
      (token ??= installationToken(ctx, integration, installation, credentials, {
        tools: integration.tools.presets.read,
      }).then(value => {
        minted.push(value);
        return value;
      })),
  };

  return Object.assign(async (id: string) => (id === event.integration ? access : undefined), {
    minted,
  });
}

/** The live installations of the agent's apps, read once per task start and shared by its readers for a minute. */
export function agentInstallations(
  ctx: ServerContext,
  task: Pick<TaskStatus['task'], 'id' | 'agent'>,
): Promise<Installation[]> {
  const cache = ((ctx.settings ??= {}).agentInstallations ??= new Map());
  const key = `${ctx.organizationId}:${task.id}`;
  let rows = cache.get(key);
  if (!rows) {
    rows = ctx.store
      .list('installation', { agent: task.agent, active: true })
      .then(rows => rows.map(row => row.value));
    cache.set(key, rows);
    setTimeout(() => cache.delete(key), 60_000).unref();
  }

  return rows;
}

const tokenFailed = (id: string) => (error: unknown) => {
  console.error(`coder server: could not mint a token for ${id}`, error);

  return undefined;
};

/** The task's tokens by handle: the event installation's, then one per other installation of the agent's apps. */
export async function eventTokens(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<Record<string, string>> {
  const event = task.event!;
  const integration = ctx.integrations[event.integration];
  if (!integration) throw new Error(`Unknown integration "${event.integration}"`);

  const [app, installation] = await Promise.all([
    ctx.store.get('app', event.appId),
    ctx.store.get('installation', `${event.appId}:${event.installationId}`),
  ]);
  if (!app) throw new Error(`Unknown app "${event.appId}"`);
  if (!installation || installation.deletedAt) throw new Error('Installation is gone');

  // A review that posts needs the comment scope and nothing more.
  const posts = task.flow === 'review' && task.args?.post === true;
  const eventToken = await taskToken(
    ctx,
    integration,
    installation,
    event,
    decryptSecret(ctx.config, app.credentials),
    { tools: task.tools[event.integration] ?? (posts ? integration.tools.presets.read : []) },
    taskActAs(task),
  );
  const tokens: Record<string, string> = { [event.integration]: eventToken };
  const others = (await agentInstallations(ctx, task)).filter(
    other => other.id !== installation.id && other.integration in task.tools,
  );
  const apps = new Map(
    (await ctx.store.getApps([...new Set(others.map(other => other.app))])).map(row => [
      row.id,
      row.value,
    ]),
  );
  await Promise.all(
    others.map(async other => {
      const target = ctx.integrations[other.integration];
      const owner = apps.get(other.app);
      if (!target || !owner) return;
      const token = await installationToken(
        ctx,
        target,
        other,
        decryptSecret(ctx.config, owner.credentials),
        { tools: task.tools[other.integration] ?? [] },
        ctx.config.taskTimeoutMs,
      ).catch(tokenFailed(other.id));
      if (token) tokens[handleKey(other.integration, other.account.login)] = token;
    }),
  );

  return tokens;
}

/** A personal token only in a 1:1 conversation; in a shared one anyone may steer, so the task acts as the app. */
function taskActAs(task: TaskStatus['task']) {
  const event = task.event!;
  return event.chat && !event.chat.thread.isDM
    ? undefined
    : eventOptions(task.definition.integrations[event.integration], event.type)?.actAs;
}

export async function taskContext(
  ctx: ServerContext,
  status: TaskStatus,
): Promise<{
  task: TaskStatus['task'];
  tokens: Record<string, string>;
  nativeTokens: Record<string, string>;
  postToken?: string;
  credential: EngineCredential;
  engineCredentials?: Array<{ id: string; credential: EngineCredential }>;
  config: Partial<CoderConfig>;
  connections: Record<string, McpServerSpec>;
  connectionEnv: Record<string, string>;
  connectionSecrets: string[];
}> {
  const task = status.task;
  const [tokens, config, credential]: [
    Record<string, string>,
    Partial<CoderConfig>,
    EngineCredential,
  ] = await Promise.all([
    task.event ? eventTokens(ctx, status.task) : {},
    ctx.local ? {} : taskConfig(ctx.store),
    taskCredential(ctx, task),
  ]);

  let postToken: string | undefined;
  const event = task.event;
  if (task.flow === 'default' && event?.chat && task.source === event.integration) {
    const integration = ctx.integrations[event.integration]!;
    const read = integration.tools.presets.read;
    const tools = task.tools[event.integration] ?? [];
    // The app's tool token posts too when its scopes are exactly the read scopes.
    const shared =
      !taskActAs(task) &&
      tools.length === read.length &&
      read.every(scope => tools.includes(scope));
    if (shared) postToken = tokens[event.integration];
    else {
      const [app, installation] = await Promise.all([
        ctx.store.get('app', event.appId),
        ctx.store.get('installation', `${event.appId}:${event.installationId}`),
      ]);
      if (!app || !installation || installation.deletedAt)
        throw new Error('Conversation installation is gone');
      postToken = await installationToken(
        ctx,
        integration,
        installation,
        decryptSecret(ctx.config, app.credentials),
        { tools: read },
        ctx.config.taskTimeoutMs,
      );
    }
  }

  const resolved = await resolvedTaskConnections(ctx, status, tokens);
  const engineCredentials = task.engineChain?.length
    ? await taskEngineCredentials(ctx, task)
    : undefined;
  const connectionEnv = { ...resolved.env };
  const warnings = [...resolved.warnings];
  for (const name of Object.keys(connectionEnv)) {
    if (
      credential.env[name] === undefined &&
      !engineCredentials?.some(row => row.credential.env[name] !== undefined)
    )
      continue;
    delete connectionEnv[name];
    warnings.push(`${name} is temporarily unavailable; skipped for this task.`);
  }
  const currentSecrets = await connectionSecretValues(ctx, task);
  const safeTask = { ...task, tools: resolved.tools };
  const connectionSecrets = await taskConnectionSecrets(ctx, task.id, [
    ...resolved.secrets,
    ...currentSecrets,
    ...Object.values(resolved.tokens),
    ...Object.values(tokens),
    ...(postToken ? [postToken] : []),
    ...credentialSecrets(credential.env),
    ...(engineCredentials?.flatMap(row => credentialSecrets(row.credential.env)) ?? []),
  ]);
  await taskWarnings(ctx, task.id, warnings);
  const common = {
    task: safeTask,
    tokens: { ...resolved.tokens, ...tokens },
    nativeTokens: resolved.nativeTokens,
    ...(postToken ? { postToken } : {}),
    credential,
    ...(engineCredentials ? { engineCredentials } : {}),
    config,
    connections: resolved.mcp,
    connectionEnv,
    connectionSecrets,
  };
  if (task.runner !== 'vercel-sandbox') return common;
  const brokered = (credential: EngineCredential) => {
    const names = new Set(brokeredKeys(config, task, credential).map(rule => rule.name));
    return {
      ...credential,
      env: Object.fromEntries(
        Object.entries(credential.env).map(([name, value]) => [
          name,
          names.has(name) ? BROKERED_PLACEHOLDER : value,
        ]),
      ),
    };
  };
  return {
    ...common,
    credential: brokered(credential),
    ...(engineCredentials
      ? {
          engineCredentials: engineCredentials.map(row => ({
            ...row,
            credential: brokered(row.credential),
          })),
        }
      : {}),
  };
}

/** The task's engine credential; a member's own runner falls back to the machine's logins. */
export async function taskCredential(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<EngineCredential> {
  const engine = (task.usage?.engine ??
    task.definition.engine ??
    'claude') as EngineCredential['engine'];
  const selected = task.credential
    ? await ctx.store.get('credential', task.credential)
    : (await resolveCredential(ctx, engine, task.requester, { model: task.usage?.model }))?.value;
  if (selected) return { engine, ...decryptCredential(ctx.config, selected) };
  if (!task.runnerId && !ctx.local) throw new Error('no-credential');

  return { engine, env: {} };
}

export async function taskEngineCredentials(ctx: ServerContext, task: TaskStatus['task']) {
  const engine = task.usage?.engine ?? task.definition.engine;
  const chain = task.engineChain ?? [];
  const remaining = chain.slice(Math.max(0, chain.indexOf(engine ?? '')) + 1);
  const rows = await Promise.all(
    remaining.map(async engine => {
      const id = task.engineCredentials?.[engine];
      const value = id ? await ctx.store.get('credential', id) : undefined;
      return value && (!value.owner || value.owner === task.requester)
        ? {
            id: id!,
            credential: {
              engine: engine as EngineCredential['engine'],
              ...decryptCredential(ctx.config, value),
            },
          }
        : undefined;
    }),
  );

  return [
    ...(task.credential
      ? [{ id: task.credential, credential: await taskCredential(ctx, task) }]
      : []),
    ...rows.flatMap(row => (row ? [row] : [])),
  ];
}

const hostOf = (url: string | undefined) =>
  url && URL.canParse(url) ? [new URL(url).hostname] : [];

/** What a sandbox firewall injects for a credential: the engine API keys at their hosts, and for a custom model its key as a bearer at the endpoints the task may use. */
export function brokeredKeys(
  config: Partial<CoderConfig>,
  task: Pick<TaskStatus['task'], 'usage'>,
  credential: EngineCredential,
): BrokerRule[] {
  if (credential.engine !== 'custom') return BROKERED;
  const models = config.models ?? {};
  const selected = task.usage?.model ? models[task.usage.model] : undefined;
  const entries = selected && 'baseUrl' in selected ? [selected] : Object.values(models);
  const custom = entries.flatMap(entry =>
    'baseUrl' in entry && entry.envKey && URL.canParse(entry.baseUrl)
      ? [
          {
            name: entry.envKey,
            host: new URL(entry.baseUrl).hostname,
            header: 'authorization',
            prefix: 'Bearer ',
          },
        ]
      : [],
  );

  return [...BROKERED, ...custom];
}

/** Hosts a task below `auto` may reach from its machine: engine, integrations, connections, MCP, the allowlist. */
export async function taskHosts(
  ctx: ServerContext,
  task: TaskStatus['task'],
  credential: EngineCredential,
): Promise<string[] | undefined> {
  if (task.permissions === 'auto') return undefined;
  const config: Partial<CoderConfig> = ctx.local ? {} : await taskConfig(ctx.store);
  const integrations = new Set([
    ...(task.event ? [task.event.integration] : []),
    ...Object.keys(task.tools),
  ]);
  const hosts = engineHosts(credential.engine, credential.env);
  if (credential.engine === 'custom')
    for (const entry of Object.values(config.models ?? {}))
      if ('baseUrl' in entry) hosts.push(...hostOf(entry.baseUrl));

  for (const id of task.connections ?? []) {
    const connection = await findConnection(ctx, id, task.requester);
    if (connection?.provider === 'mcp') hosts.push(...hostOf(connection.endpoint?.url));
    else if (connection) integrations.add(connection.provider);
  }
  for (const id of integrations) hosts.push(...(ctx.integrations[id]?.hosts ?? []));
  for (const entry of Object.values(task.definition.mcp ?? {})) hosts.push(...hostOf(entry.url));
  for (const name of task.mcp ?? []) hosts.push(...hostOf(config.mcp?.[name]?.url));
  for (const host of config.approvals?.allowedNetworkHosts ?? []) {
    const name = host.replace(/^\[(.*)\](?::\d+)?$/, '$1').replace(/^([^:]+):\d+$/, '$1');
    hosts.push(name, ...(net.isIP(name) ? [] : [`*.${name}`]));
  }

  return [...new Set(hosts)];
}

/** A brokering runner's firewall for the task's machine: the credential its firewall injects, the
 * only hosts it reaches (undefined: all) and the keys it brokers; undefined without a credential. */
export async function machineFirewall(ctx: ServerContext, task: TaskStatus['task']) {
  const credential = await taskCredential(ctx, task);
  if (!credential) return undefined;
  const credentials = [
    credential,
    ...(await taskEngineCredentials(ctx, task)).map(row => row.credential),
  ];
  const hosts = await Promise.all(credentials.map(value => taskHosts(ctx, task, value)));
  const config = await taskConfig(ctx.store);

  return {
    credential: Object.assign({}, ...credentials.map(value => value.env).reverse()) as Record<
      string,
      string
    >,
    hosts: hosts.some(value => value === undefined)
      ? undefined
      : [...new Set(hosts.flatMap(value => value ?? []))],
    brokered: credentials.flatMap(value => brokeredKeys(config, task, value)),
  };
}

function credentialSecrets(env: Record<string, string>): string[] {
  const secrets: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (!/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH)/i.test(name) && !mcpSecretValue(value))
      continue;
    secrets.push(value);
    if (name.endsWith('_AUTH_JSON')) {
      const auth = JSON.parse(value) as {
        OPENAI_API_KEY?: string;
        tokens?: Record<string, string>;
      };
      secrets.push(
        ...[
          auth.OPENAI_API_KEY,
          ...Object.entries(auth.tokens ?? {})
            .filter(([name]) => /TOKEN|KEY|SECRET/i.test(name))
            .map(([, value]) => value),
        ].filter((entry): entry is string => typeof entry === 'string'),
      );
    }
  }

  return secrets;
}

async function storedPlatformSecrets(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<string[]> {
  if (!task.event) return [];

  return (await agentInstallations(ctx, task)).flatMap(row =>
    row.token ? [decryptSecret<string>(ctx.config, row.token)] : [],
  );
}

export async function taskLogSecrets(ctx: ServerContext, status: TaskStatus): Promise<string[]> {
  const [connections, credential, platform]: [string[], EngineCredential, string[]] =
    await Promise.all([
      readTaskConnectionSecrets(ctx, status.task),
      taskCredential(ctx, status.task).catch(error => {
        if (error instanceof Error && error.message === 'no-credential')
          return { engine: 'codex' as const, env: {} };
        throw error;
      }),
      storedPlatformSecrets(ctx, status.task),
    ]);
  const recovered =
    ctx.store instanceof LocalStore &&
    status.task.event &&
    !(
      await ctx.store.list('snapshot', {
        prefix: `connection-secrets:${status.task.id}:`,
        limit: 1,
      })
    ).length
      ? Object.values(await eventTokens(ctx, status.task))
      : [];

  if (recovered.length)
    await taskConnectionSecrets(ctx, status.task.id, [...connections, ...platform, ...recovered]);

  return [...connections, ...platform, ...recovered, ...credentialSecrets(credential.env)].filter(
    value => value.length >= 8,
  );
}
