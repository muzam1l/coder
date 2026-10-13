import { randomUUID } from 'node:crypto';
import { eventOptions } from '../../agent/definition';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { BROKERED, BROKERED_PLACEHOLDER } from '../runners/vercel-sandbox';
import type { Integration, TokenBound } from '../../integrations/types';
import type { AgentEvent, InstallationLink, Installation } from '../../agent/types';
import type { EngineCredential, Store, TaskStatus } from '../store/types';
import type { ServerContext } from '../context';
import type { CoderConfig } from '../../core/config';
import { taskConfig } from '../settings/config';
import { credentialValue, resolveCredential } from '../settings/credentials';
import {
  resolvedTaskConnections,
  connectionSecretValues,
  taskConnectionSecrets,
  readTaskConnectionSecrets,
} from '../connections/resolve';
import type { McpServerSpec } from '../../core/types';
import { connectionWarnings } from './logs';
import { LocalStore } from '../store/local';
import { mcpSecretValue } from '../../core/mcp';
import { nativeCredential, nativeApp } from '../connections/records';

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

/** A minted token held for reuse, sealed. */
export interface HeldToken {
  token: string;
  expiresAt: number;
  mintedAt: number;
}

/** An installation's or app's latest token drop. */
export interface TokenDrop {
  drop: string;
}

const heldKey = (id: string, key = '') => `token:${id}:${key}`;
const dropKey = (id: string) => `token-drop:${id}`;
/** Outlives any mint in flight when tokens are dropped. */
const DROP_FENCE_TTL_MS = 60 * 60 * 1000;

/** The installation's and its app's latest drops, so a mint that began before one is never held. */
const drops = (store: Store, installation: Installation) =>
  Promise.all(
    [installation.id, installation.app].map(id => store.get<TokenDrop>('snapshot', dropKey(id))),
  ).then(rows => rows.map(row => row?.drop).join());

/** Forgets every token held for an installation, or given an app id, for all of its installations. */
export async function dropTokens(store: Store, id: string): Promise<void> {
  await store.put('snapshot', dropKey(id), { drop: randomUUID() }, { ttlMs: DROP_FENCE_TTL_MS });
  for (const row of await store.list<HeldToken>('snapshot', { prefix: heldKey(id) }))
    await store.delete('snapshot', row.id);
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
      const held = await ctx.store.get<HeldToken>('snapshot', key);
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

      const drop = await drops(ctx.store, installation);
      const minted = await mint();
      if ((await drops(ctx.store, installation)) !== drop) return minted.token;
      await ctx.store.put(
        'snapshot',
        key,
        {
          token: encryptSecret(ctx.config, minted.token),
          expiresAt: minted.expiresAt,
          mintedAt: now,
        },
        { ttlMs: Math.max(minted.expiresAt - now - REUSE_MARGIN_MS, 0) },
      );
      if ((await drops(ctx.store, installation)) !== drop) await ctx.store.delete('snapshot', key);

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
  /** A token that can see `repo` (`owner/name`), by default the access's own repository. */
  token(repo?: string): Promise<string | undefined>;
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

/** A bound on one repository, when there is one, and the tools a token serves. */
export function tokenBound(
  repo: { owner: string; name: string } | undefined,
  tools: string[],
): TokenBound {
  return { ...(repo ? { repo: { owner: repo.owner, name: repo.name } } : {}), tools };
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

const repoName = (value: string | undefined) => {
  const match = value && /^([^/]+)\/([^/]+)$/.exec(value);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
};

/** A connected installation that can mint, narrowed to the task's frozen bound, or before a task to its config repository read-only. */
async function connection(
  ctx: ServerContext,
  integration: string,
  link: InstallationLink,
  task?: Pick<TaskStatus['task'], 'tools' | 'toolScopes'>,
): Promise<
  | {
      installation: string;
      repo: { owner: string; name: string };
      mint(repo?: { owner: string; name: string }): Promise<string>;
    }
  | undefined
> {
  const linked = await ctx.store.get('installation', link.id);
  if (!linked || linked.deletedAt) return undefined;

  const app = await ctx.store.get('app', linked.app);
  const target = ctx.integrations[integration];
  if (!app || !target) return undefined;

  const repo = task ? task.toolScopes?.[integration]?.repo : repoName(linked.settings?.configRepo);
  if (!repo) return undefined;

  return {
    installation: linked.id,
    repo,
    mint: async (read = repo) =>
      installationToken(
        ctx,
        target,
        linked,
        decryptSecret(ctx.config, app.credentials),
        tokenBound(read, task ? (task.tools[integration] ?? []) : target.tools.presets.observe),
        task && ctx.config.taskTimeoutMs,
      ),
  };
}

const connectionFailed = (integration: string) => (error: unknown) => {
  console.error(`coder server: could not mint a connected ${integration} token`, error);

  return undefined;
};

/** Dispatch's access: the event installation's read token and connected installations' config repository tokens, none minted until asked for. */
export function dispatchTokens(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  event: AgentEvent,
  credentials: unknown,
): EventTokens {
  const minted: string[] = [];
  const scoped = (
    own: { owner: string; name: string } | undefined,
    mint: (repo: typeof own) => Promise<string | undefined>,
  ) => {
    const tokens = new Map<string, Promise<string | undefined>>();
    return (repo?: string) => {
      const bound = repo ? repoName(repo) : own;
      if (repo && !bound) return Promise.resolve(undefined);

      const key = bound ? `${bound.owner}/${bound.name}` : '';
      let token = tokens.get(key);
      if (!token) {
        token = mint(bound).then(value => {
          if (value) minted.push(value);
          return value;
        });
        tokens.set(key, token);
      }

      return token;
    };
  };
  const access = async (id: string): Promise<PlatformAccess | undefined> => {
    const fetcher = ctx.fetch ?? fetch;
    if (id === event.integration)
      return {
        installation: installation.id,
        fetch: fetcher,
        token: scoped(event.repo, repo =>
          installationToken(
            ctx,
            integration,
            installation,
            credentials,
            tokenBound(repo, integration.tools.presets.observe),
          ),
        ),
      };
    const link = installation.connections?.[id];
    const linked = link && (await connection(ctx, id, link));
    return (
      linked && {
        installation: linked.installation,
        fetch: fetcher,
        token: scoped(linked.repo, repo => linked.mint(repo).catch(connectionFailed(id))),
      }
    );
  };
  const found = new Map<string, Promise<PlatformAccess | undefined>>();

  return Object.assign(
    (id: string) => {
      if (!found.has(id)) found.set(id, access(id));
      return found.get(id)!;
    },
    { minted },
  );
}
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
    tokenBound(
      task.toolScopes?.[event.integration]?.repo ?? event.repo,
      task.tools[event.integration] ?? (posts ? integration.tools.presets.comment : []),
    ),
    eventOptions(task.definition.integrations[event.integration], event.type)?.actAs,
  );
  const tokens: Record<string, string> = { [event.integration]: eventToken };
  await Promise.all(
    Object.entries(installation.connections ?? {}).map(async ([id, link]) => {
      if (id === event.integration || !(id in task.tools)) return;
      const linked = await connection(ctx, id, link, task);
      const token = await linked?.mint().catch(connectionFailed(id));
      if (token) tokens[id] = token;
    }),
  );

  return tokens;
}

export async function taskContext(
  ctx: ServerContext,
  status: TaskStatus,
): Promise<{
  task: TaskStatus['task'];
  tokens: Record<string, string>;
  nativeTokens: Record<string, string>;
  credential: EngineCredential;
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
  const resolved = await resolvedTaskConnections(ctx, status, tokens);
  const connectionEnv = { ...resolved.env };
  const warnings = [...resolved.warnings];
  for (const name of Object.keys(connectionEnv)) {
    if (credential.env[name] === undefined) continue;
    delete connectionEnv[name];
    warnings.push(`${name} is temporarily unavailable; skipped for this task.`);
  }
  const currentSecrets = await connectionSecretValues(ctx, task);
  const safeTask = { ...task, tools: resolved.tools, toolScopes: resolved.toolScopes };
  const connectionSecrets = await taskConnectionSecrets(ctx, task.id, [
    ...resolved.secrets,
    ...currentSecrets,
    ...Object.values(resolved.tokens),
    ...Object.values(tokens),
    ...credentialSecrets(credential.env),
  ]);
  await connectionWarnings(ctx, task.id, warnings);
  const common = {
    task: safeTask,
    tokens: { ...resolved.tokens, ...tokens },
    nativeTokens: resolved.nativeTokens,
    credential,
    config,
    connections: resolved.mcp,
    connectionEnv,
    connectionSecrets,
  };
  if (task.runner !== 'vercel-sandbox') return common;
  const env = Object.fromEntries(
    Object.entries(credential.env).map(([name, value]) => [
      name,
      name in BROKERED ? BROKERED_PLACEHOLDER : value,
    ]),
  );
  return { ...common, credential: { ...credential, env } };
}

/** The task's engine credential; a member's own runner falls back to the machine's logins. */
export async function taskCredential(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<EngineCredential> {
  const selected = task.credential
    ? await ctx.store.get('credential', task.credential)
    : (
        await resolveCredential(
          ctx.store,
          task.usage?.engine ?? task.definition.engine,
          task.requester,
        )
      )?.value;
  if (selected) return credentialValue(ctx.config, selected);
  if (!task.runnerId && !ctx.local) throw new Error('no-credential');

  return {
    engine: (task.usage?.engine ??
      task.definition.engine ??
      'claude') as EngineCredential['engine'],
    env: {},
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
  const installation = await ctx.store.get(
    'installation',
    `${task.event.appId}:${task.event.installationId}`,
  );
  const secrets: string[] = [];
  for (const row of [
    installation,
    ...(await Promise.all(
      Object.values(installation?.connections ?? {})
        .filter(link => link.kind === 'installation')
        .map(link => ctx.store.get('installation', link.id)),
    )),
  ])
    if (row?.token) secrets.push(decryptSecret<string>(ctx.config, row.token));

  return secrets;
}

export async function taskLogSecrets(ctx: ServerContext, status: TaskStatus): Promise<string[]> {
  const [connections, credential, platform]: [string[], EngineCredential, string[]] =
    await Promise.all([
      readTaskConnectionSecrets(ctx, status.task),
      taskCredential(ctx, status.task),
      storedPlatformSecrets(ctx, status.task),
    ]);
  const recovered =
    ctx.store instanceof LocalStore &&
    status.task.event &&
    !ctx.store.connectionSecrets?.get(status.task.id)?.length
      ? Object.values(await eventTokens(ctx, status.task))
      : [];

  if (recovered.length)
    await taskConnectionSecrets(ctx, status.task.id, [...connections, ...platform, ...recovered]);

  return [...connections, ...platform, ...recovered, ...credentialSecrets(credential.env)].filter(
    value => value.length >= 8,
  );
}
