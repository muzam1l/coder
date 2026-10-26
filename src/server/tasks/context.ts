import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { decryptCredential, decryptSecret, encryptSecret } from '../store/secrets';
import {
  BROKERED,
  BROKERED_PLACEHOLDER,
  engineHosts,
  type BrokerRule,
} from '../runners/kinds/vercel-sandbox';
import type { Integration, TokenBound } from '../../integrations/types';
import type { AgentApp, AgentEvent, Installation } from '../../agent/types';
import { effectiveSettings } from '../../agent/definition';
import type { EngineCredential, Store, TaskStatus } from '../store/types';
import { dropKey, heldKey, type HeldToken } from '../store/types';
import type { ServerContext } from '../context';
import type { CoderConfig } from '../../core/config';
import { effectiveConfig, taskConfig } from '../settings/config';
import {
  credentialNames,
  modelAttempts,
  parseCredentialId,
  pickCredentials,
  resolveModels,
} from '../settings/credentials';
import { isEndpointModel, splitEngineSpec } from '../../core/config';
import { modelList, resolveTaskOptions } from '../../core/dispatch';
import { turnStarter } from './access';
import {
  resolvedTaskConnections,
  connectionSecretValues,
  taskAsker,
  taskConnectionSecrets,
  readTaskConnectionSecrets,
  turnConnections,
} from '../connections/resolve';
import type { McpServerSpec } from '../../core/types';
import { taskWarnings } from './logs';
import { LocalStore } from '../store/local';
import { mcpSecretValue } from '../../core/mcp';
import { findConnection } from '../connections/records';
import { updateMetadata } from '../store';
import { handleKey } from '../../agent/mcp';
import { dashPath, organizationSlug } from '../auth/members';
import type { RemoteSkill } from '../../runner/skills';

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
type EventTokens = TokenSource & { minted: string[] };

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
        tools: integration.tools.presets['read-only'],
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
function agentInstallations(
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

/** The task's tokens by handle: the event installation's, then one per other installation of the agent's apps; a task with no event has them only as a child. An event on a pull request also gets a checks-only token, kept apart from them. */
export async function eventTokens(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<{ tokens: Record<string, string>; checksToken?: string; app?: AgentApp }> {
  const tokens: Record<string, string> = {};
  let checksToken: string | undefined;
  let app: AgentApp | undefined;
  const event = task.event;
  if (!event && !task.parent) return { tokens };

  let installation: Installation | undefined;
  if (event) {
    const integration = ctx.integrations[event.integration];
    if (!integration) throw new Error(`Unknown integration "${event.integration}"`);
    const [row, found] = await Promise.all([
      ctx.store.get('app', event.appId),
      ctx.store.get('installation', `${event.appId}:${event.installationId}`),
    ]);
    if (!row) throw new Error(`Unknown app "${event.appId}"`);
    app = row;
    if (!found || found.deletedAt) throw new Error('Installation is gone');
    installation = found;

    tokens[event.integration] = await installationToken(
      ctx,
      integration,
      installation,
      decryptSecret(ctx.config, app.credentials),
      {
        tools: task.tools[event.integration] ?? [],
      },
      ctx.config.taskTimeoutMs,
    );
    if (integration.repos?.reviews && integration.repos.pullRequest(event) !== undefined)
      checksToken = await installationToken(
        ctx,
        integration,
        installation,
        decryptSecret(ctx.config, app.credentials),
        { purpose: 'checks' },
        ctx.config.taskTimeoutMs,
      ).catch(tokenFailed(installation.id));
  }
  const others = (await agentInstallations(ctx, task)).filter(
    other => other.id !== installation?.id && other.integration in task.tools,
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

  return { tokens, ...(checksToken ? { checksToken } : {}), ...(app ? { app } : {}) };
}

/** The agent's skill sources as its runner fetches them: the clone URL and, when a workspace installation covers the repository, its read-only token, the event's own reused. */
export async function taskSkills(
  ctx: ServerContext,
  task: TaskStatus['task'],
  minted?: ReturnType<typeof eventTokens>,
): Promise<RemoteSkill[] | undefined> {
  const sources = task.usage?.skills;
  const integration = Object.values(ctx.integrations).find(entry => entry.repos);
  const repos = integration?.repos;
  if (!sources?.length || !integration || !repos) return undefined;

  const event = task.event;
  const installations = ctx.store.list('installation', { active: true });

  return Promise.all(
    sources.map(async source => {
      const remote = { ...source, cloneUrl: `${repos.url(source.repo)}.git` };
      const found = (await installations).find(
        ({ value }) =>
          value.integration === integration.id &&
          value.repos?.some(name => name.toLowerCase() === source.repo.toLowerCase()),
      )?.value;
      if (!found) return remote;

      const own = minted && event && found.id === `${event.appId}:${event.installationId}`;
      const app = own ? undefined : await ctx.store.get('app', found.app);
      const token = own
        ? (await minted).tokens[event.integration]
        : app &&
          (await installationToken(
            ctx,
            integration,
            found,
            decryptSecret(ctx.config, app.credentials),
            { purpose: 'contents' },
          ).catch(tokenFailed(found.id)));

      return token ? { ...remote, token } : remote;
    }),
  );
}

/** The task's default commit identity: the bot of the agent's app whose installation pushes, the event's app when it commits, else the agent's other app holding a token; its user id read once and kept on the app. A member's identity comes only from a turn approved to act as them, never from the task's own user. */
export async function commitIdentity(
  ctx: ServerContext,
  task: TaskStatus['task'],
  tokens: Record<string, string>,
  app?: AgentApp,
): Promise<{ name: string; email: string } | undefined> {
  const event = task.event;
  let token = app && event && tokens[event.integration];
  if (!app || !ctx.integrations[app.integration]?.repos?.commitAuthor) {
    const pushing = Object.keys(tokens).length
      ? (await agentInstallations(ctx, task)).find(
          row =>
            ctx.integrations[row.integration]?.repos?.commitAuthor &&
            tokens[handleKey(row.integration, row.account.login)],
        )
      : undefined;
    token = pushing && tokens[handleKey(pushing.integration, pushing.account.login)];
    app = pushing && (await ctx.store.get('app', pushing.app));
  }
  const integration = app && ctx.integrations[app.integration];
  if (!app || !integration?.repos?.commitAuthor || !token) return undefined;
  try {
    const login = integration.author?.(app.name) ?? app.name;
    const bot = await integration.repos.commitAuthor({ login, id: app.botId }, token, ctx.fetch);
    if (app.botId === undefined) await updateMetadata(ctx.store, 'app', app.id, { botId: bot.id });

    return { name: bot.name, email: bot.email };
  } catch (error) {
    console.error(`coder server: commit identity lookup failed for ${task.id}`, error);
    return undefined;
  }
}

/** The workspace's dashboard on this server's public URL, where a task's Coder tools link. */
export async function taskDashboard(
  ctx: ServerContext,
  workspace?: { slug?: string },
): Promise<string | undefined> {
  const base = ctx.config.publicUrl?.replace(/\/$/, '');

  return base ? `${base}${dashPath(await organizationSlug(ctx, workspace))}` : undefined;
}

export async function taskContext(
  ctx: ServerContext,
  status: TaskStatus,
  workspace?: { slug?: string },
): Promise<{
  task: TaskStatus['task'];
  tokens: Record<string, string>;
  checksToken?: string;
  dashboard?: string;
  reviewAssets?: string;
  gitAuthor?: { name: string; email: string };
  postToken?: string;
  credential: EngineCredential;
  engineCredentials?: Array<{ id: string; credential: EngineCredential }>;
  config: Partial<CoderConfig>;
  connections: Record<string, McpServerSpec>;
  connectionEnv: Record<string, string>;
  connectionSecrets: string[];
  skills?: RemoteSkill[];
}> {
  const task = await withModels(ctx, status.task);
  const minted = eventTokens(ctx, status.task);
  const [{ tokens, checksToken, app }, config, credential, skills]: [
    Awaited<ReturnType<typeof eventTokens>>,
    Partial<CoderConfig>,
    EngineCredential,
    RemoteSkill[] | undefined,
  ] = await Promise.all([
    minted,
    ctx.local ? {} : taskConfig(ctx.store),
    taskCredential(ctx, task),
    taskSkills(ctx, task, minted),
  ]);

  let postToken: string | undefined;
  const event = task.event;
  if (event?.chat && task.source === event.integration) {
    const integration = ctx.integrations[event.integration]!;
    const read = integration.tools.presets['read-only'];
    const tools = task.tools[event.integration] ?? [];
    // The app's tool token posts too when its scopes are exactly the read scopes.
    const shared = tools.length === read.length && read.every(scope => tools.includes(scope));
    if (shared) postToken = tokens[event.integration];
    else {
      const installation = await ctx.store.get(
        'installation',
        `${event.appId}:${event.installationId}`,
      );
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

  const gitAuthor = await commitIdentity(ctx, task, tokens, app);

  const { actAsRefusal } = await import('./changes');
  const resolved = await resolvedTaskConnections(ctx, status, tokens, connection =>
    actAsRefusal(ctx, status, connection),
  );
  const dashboard = await taskDashboard(ctx, workspace);
  // A path resolves against this server's public URL; an absolute URL stays as it is.
  const reviewAssets =
    ctx.config.reviewAssets && URL.parse(ctx.config.reviewAssets, ctx.config.publicUrl)?.href;
  const engineCredentials = await taskEngineCredentials(ctx, task, effectiveConfig(ctx, config));
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
  const currentSecrets = resolved.saved ? [] : await connectionSecretValues(ctx, task);
  // A task stored before its settings link was kept gets the agent's settings page from here.
  const safeTask = {
    ...task,
    ...(!task.settingsUrl && dashboard
      ? { settingsUrl: `${dashboard}/agents/${encodeURIComponent(task.agent)}/settings` }
      : {}),
  };
  const connectionSecrets = await taskConnectionSecrets(ctx, task.id, [
    ...resolved.secrets,
    ...currentSecrets,
    ...Object.values(resolved.tokens),
    ...Object.values(tokens),
    ...(postToken ? [postToken] : []),
    ...(checksToken ? [checksToken] : []),
    ...(skills?.flatMap(skill => (skill.token ? [skill.token] : [])) ?? []),
    ...credentialSecrets(credential.env),
    ...(engineCredentials?.flatMap(row => credentialSecrets(row.credential.env)) ?? []),
  ]);
  await taskWarnings(ctx, task.id, warnings);
  const common = {
    task: safeTask,
    tokens: { ...resolved.tokens, ...tokens },
    ...(checksToken ? { checksToken } : {}),
    ...(dashboard ? { dashboard } : {}),
    ...(reviewAssets ? { reviewAssets } : {}),
    ...(gitAuthor ? { gitAuthor } : {}),
    ...(postToken ? { postToken } : {}),
    credential,
    ...(engineCredentials ? { engineCredentials } : {}),
    config,
    connections: resolved.mcp,
    connectionEnv,
    connectionSecrets,
    ...(skills ? { skills } : {}),
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

/** The model a task's turn starts with: the first of its list. */
export function firstModel(task: TaskStatus['task']) {
  const first = task.models?.[0]?.model;

  return first ? splitEngineSpec(first).model : undefined;
}

/** The engine a credential row runs: a subscription's or an engine key's own, else the custom models'. */
function credentialEngine(id: string): EngineCredential['engine'] {
  const { name } = parseCredentialId(id);
  if (name === 'claude' || name === 'ANTHROPIC_API_KEY' || name === 'CLAUDE_CODE_OAUTH_TOKEN')
    return 'claude';

  return name === 'codex' || name === 'OPENAI_API_KEY' ? 'codex' : 'custom';
}

/** The task with the attempts its turn runs: those frozen at admission, else the ones its asker may run now. */
async function withModels(ctx: ServerContext, task: TaskStatus['task']) {
  if (task.models) return task;
  const { models } = await resolveModels(ctx, effectiveSettings(task), turnStarter(task));

  return { ...task, models: modelAttempts(models, Boolean(task.runnerId || ctx.local)) };
}

/** The credential a task's turn starts on: its first attempt's; one without runs on a member's own runner or a local server's logins. */
export async function taskCredential(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<EngineCredential> {
  const [first] = (await withModels(ctx, task)).models ?? [];
  const engine = (
    first ? splitEngineSpec(first.model).engine : 'claude'
  ) as EngineCredential['engine'];
  const selected = first?.credential && (await ctx.store.get('credential', first.credential));
  if (selected) return { engine, ...decryptCredential(ctx.config, selected) };
  if (!task.runnerId && !ctx.local) throw new Error('no-credential');

  return { engine, env: {} };
}

/** Every credential a turn may switch to, best first: the starter's own on their turn, then the workspace's, for each model its list, its review model and its flow steps reach. */
export async function taskEngineCredentials(
  ctx: ServerContext,
  task: TaskStatus['task'],
  config: CoderConfig,
) {
  const option = (model?: string) => {
    try {
      return [resolveTaskOptions({ model }, config)];
    } catch {
      return [];
    }
  };
  const { models } = await withModels(ctx, task);
  const options = [
    ...(models ?? []).flatMap(attempt => option(attempt.model)),
    ...option(config.reviewModel).flatMap(first => modelList(config, first)),
    ...option().flatMap(first => modelList(config, first)),
  ];
  const names = [...new Set(options.flatMap(each => credentialNames(each, config)))];
  const starter = turnStarter(task);
  const listed = await ctx.store.listCredentials({ owner: task.requestedBy });
  const frozen = new Set(models?.flatMap(attempt => attempt.credential ?? []));
  const picked = pickCredentials(listed, names, starter);
  const rows = [
    ...listed.filter(
      row =>
        frozen.has(row.id) &&
        !picked.includes(row) &&
        (!row.value.owner || row.value.owner === starter),
    ),
    ...picked,
  ];

  return rows.map(row => ({
    id: row.id,
    credential: { engine: credentialEngine(row.id), ...decryptCredential(ctx.config, row.value) },
  }));
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
  const entries = isEndpointModel(selected) ? [selected] : Object.values(models);
  const custom = entries.flatMap(entry =>
    isEndpointModel(entry) && entry.envKey && URL.canParse(entry.baseUrl)
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
  if (task.access === 'auto') return undefined;
  const config: Partial<CoderConfig> = ctx.local ? {} : await taskConfig(ctx.store);
  const integrations = new Set([
    ...(task.event ? [task.event.integration] : []),
    ...Object.keys(task.tools),
  ]);
  const hosts = engineHosts(credential.engine, credential.env);
  if (credential.engine === 'custom')
    for (const entry of Object.values(config.models ?? {}))
      if (isEndpointModel(entry)) hosts.push(...hostOf(entry.baseUrl));

  const turn = await turnConnections(ctx, task);
  for (const id of turn.ids) {
    const connection = await findConnection(ctx, id, taskAsker(task), turn.accounts);
    if (connection?.provider === 'mcp') hosts.push(...hostOf(connection.endpoint?.url));
    else if (connection) integrations.add(connection.provider);
  }
  for (const id of integrations) hosts.push(...(ctx.integrations[id]?.hosts ?? []));
  for (const entry of Object.values(task.definition.mcp ?? {})) hosts.push(...hostOf(entry.url));
  for (const name of task.mcp ?? []) hosts.push(...hostOf(config.mcp?.[name]?.url));
  for (const host of config.network?.allowedHosts ?? []) {
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
  const config = await taskConfig(ctx.store);
  const credentials = [
    credential,
    ...(await taskEngineCredentials(ctx, task, effectiveConfig(ctx, config))).map(
      row => row.credential,
    ),
  ];
  const hosts = await Promise.all(credentials.map(value => taskHosts(ctx, task, value)));

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
  const [connections, credentials, platform] = await Promise.all([
    readTaskConnectionSecrets(ctx, status.task),
    taskConfig(ctx.store).then(config =>
      taskEngineCredentials(ctx, status.task, effectiveConfig(ctx, config)),
    ),
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
      ? Object.values((await eventTokens(ctx, status.task)).tokens)
      : [];

  if (recovered.length)
    await taskConnectionSecrets(ctx, status.task.id, [...connections, ...platform, ...recovered]);

  return [
    ...connections,
    ...platform,
    ...recovered,
    ...credentials.flatMap(row => credentialSecrets(row.credential.env)),
  ].filter(value => value.length >= 8);
}
