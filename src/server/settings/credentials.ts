import * as z from 'zod/mini';
import process from 'node:process';
import { type Params } from '../routes/match';
import { type ServerConfig, type ServerContext } from '../context';
import { workspaceAdmin } from '../routes/guards';
import { decodeCursor, json, page, pageLimit, paged } from '../routes/http';
import { engineSignIn, engineSignOut, engineStatus, machineSignedIn } from '../tasks/local';
import { type Installation } from '../../agent/types';
import { type EngineCredential, type Store } from '../store/types';
import {
  decryptCredential,
  decryptSecret,
  encryptCredential,
  encryptSecret,
  keyVersion,
  secretKeyVersion,
  type EncryptedCredential,
} from '../store/secrets';
import { dashPath, organizationSlug } from '../auth/members';
import { modelList, resolveTaskOptions } from '../../core/dispatch';
import { isEndpointModel, modelName, type CoderConfig } from '../../core/config';
import { formatEngineSpec } from '../../core/state';
import { effectiveConfig, shownConfig } from './config';
import type { ResolvedTaskOptions } from '../../core/types';
import type { ModelAttempt } from '../../agent/types';
import { type LoginEngine } from './logins';

/** Engine credentials for a workspace or a member, one per variable or subscription in each scope; every row change goes through `store.withCredential`. */

export interface StoredCredential extends EncryptedCredential {
  /** Wular user id of a personal credential; absent for a workspace one. */
  owner?: string;
  account?: CredentialAccount;
  createdAt?: number;
}

export interface CredentialAccount {
  email?: string;
  plan?: string;
}

export interface CredentialSummary {
  /** The variable of an API key, the engine of a subscription. */
  name: string;
  scope: 'personal' | 'workspace';
  subscription: boolean;
  createdAt: number;
  /** The first five characters of the secret, followed by four bullets. */
  masked: string;
  account?: CredentialAccount;
}

type CredentialRow = { id: string; value: StoredCredential };

/** The API key variable each engine reads. */
const ENGINE_KEYS = { claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY' } as const;
/** The variable a subscription is kept in. */
const SUBSCRIPTION_KEYS = { claude: 'CLAUDE_CODE_OAUTH_TOKEN', codex: 'CODEX_AUTH_JSON' } as const;

/** Store id: the name for a workspace credential, `<owner>/<name>` for a personal one. */
export function credentialId(owner: string | undefined, name: string): string {
  return owner ? `${owner}/${name}` : name;
}

export function parseCredentialId(id: string): {
  owner?: string;
  name: string;
} {
  const at = id.lastIndexOf('/');
  return at < 0 ? { name: id } : { owner: id.slice(0, at), name: id.slice(at + 1) };
}

/** A credential's name: the engine of a subscription, else its one variable. */
function credentialName(env: Record<string, string>): string {
  const [name = ''] = Object.keys(env);
  const engine = (Object.keys(SUBSCRIPTION_KEYS) as LoginEngine[]).find(
    engine => SUBSCRIPTION_KEYS[engine] === name,
  );

  return engine ?? name;
}

class CredentialCheckError extends Error {
  constructor(
    readonly status: number,
    statusText: string,
  ) {
    super(`Credential check failed: ${status}${statusText ? ` ${statusText}` : ''}`);
  }
}

function codexToken(env: Record<string, string>): string | undefined {
  if (env.OPENAI_API_KEY) return env.OPENAI_API_KEY;
  if (!env.CODEX_AUTH_JSON) return undefined;
  try {
    const value = JSON.parse(env.CODEX_AUTH_JSON) as {
      OPENAI_API_KEY?: string;
      access_token?: string;
      tokens?: { access_token?: string };
    };
    return value.OPENAI_API_KEY ?? value.tokens?.access_token ?? value.access_token;
  } catch {
    throw new Error('CODEX_AUTH_JSON is not valid JSON');
  }
}

/** Make one inexpensive provider request before accepting a built-in engine credential. */
export async function checkCredential(
  credential: EngineCredential,
  request: typeof fetch = fetch,
): Promise<void> {
  if (credential.engine === 'custom') return;
  let url: string;
  let headers: Record<string, string>;
  if (credential.engine === 'claude') {
    const apiKey = credential.env.ANTHROPIC_API_KEY;
    const token = credential.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!apiKey && !token)
      throw new Error('Claude credentials need ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN');
    url = 'https://api.anthropic.com/v1/models';
    headers = {
      'anthropic-version': '2023-06-01',
      ...(apiKey
        ? { 'x-api-key': apiKey }
        : {
            authorization: `Bearer ${token}`,
            'anthropic-beta': 'oauth-2025-04-20',
          }),
    };
  } else {
    const token = codexToken(credential.env);
    if (!token) throw new Error('Codex credentials need OPENAI_API_KEY or CODEX_AUTH_JSON');
    url = 'https://api.openai.com/v1/models';
    headers = { authorization: `Bearer ${token}` };
  }
  const response = await request(url, { method: 'GET', headers });
  if (!response.ok) throw new CredentialCheckError(response.status, response.statusText);
}

/** The names a model reads, best first: its engine's subscription, then its API key; a custom model reads the variable it names. */
export function credentialNames(
  option: { engine: string; model?: string | null },
  config: Pick<CoderConfig, 'models'>,
): string[] {
  if (option.engine === 'claude' || option.engine === 'codex')
    return [option.engine, ENGINE_KEYS[option.engine]];
  const entry = option.model ? config.models?.[option.model] : undefined;

  return [(entry && isEndpointModel(entry) && entry.envKey) || ENGINE_KEYS.codex];
}

/** The rows that serve `names`: the asker's own, then the workspace's, each in name order; turns no member pays for use the workspace's only. */
export function pickCredentials<T extends { id: string }>(
  rows: T[],
  names: string[],
  asker?: string,
): T[] {
  return (asker ? [asker, undefined] : [undefined]).flatMap(owner =>
    names.flatMap(name => rows.filter(row => row.id === credentialId(owner, name))),
  );
}

/** One model of a task's list as it runs for one member: its credentials best first, or this machine's own logins. */
export interface ModelRun {
  /** `engine/model/effort`. */
  model: string;
  option: ResolvedTaskOptions;
  credentials: string[];
  machine?: boolean;
}

/** What runs a turn and on whose account: the task pick, else the agent's model, else the chain's first, then the rest of the chain, each model on the asker's credentials before the workspace's. One read of config and credentials. */
export async function resolveModels(
  ctx: ServerContext,
  settings: { engine?: string; model?: string; effort?: string },
  asker?: string,
): Promise<{ models: ModelRun[]; attempts: ModelAttempt[]; first: ResolvedTaskOptions }> {
  const [shown, rows] = await Promise.all([
    shownConfig(ctx),
    ctx.store.listCredentials({ owner: asker }),
  ]);
  const config = effectiveConfig(ctx, shown);
  const list = modelList(config, resolveTaskOptions(settings, config));
  const models = await modelRuns(ctx, config, rows, list, asker);

  return { models, attempts: modelAttempts(models), first: list[0]! };
}

async function modelRuns(
  ctx: ServerContext,
  config: CoderConfig,
  rows: CredentialRow[],
  list: ResolvedTaskOptions[],
  asker?: string,
): Promise<ModelRun[]> {
  return Promise.all(
    list.map(async (option): Promise<ModelRun> => {
      const credentials = pickCredentials(rows, credentialNames(option, config), asker).map(
        row => row.id,
      );

      return {
        model: formatEngineSpec(option),
        option,
        credentials,
        ...(!credentials.length && (await machineSignedIn(ctx, option)) ? { machine: true } : {}),
      };
    }),
  );
}

/** An agent's model list for `viewer`, and the engines, and custom models as `custom/<name>`, no workspace credential runs; one read of config and credentials. */
export async function agentModels(
  ctx: ServerContext,
  settings: { engine?: string; model?: string; effort?: string },
  viewer?: string,
) {
  const [shown, rows] = await Promise.all([
    shownConfig(ctx),
    ctx.store.listCredentials({ owner: viewer }),
  ]);
  const config = effectiveConfig(ctx, shown);
  const choices = [
    'claude',
    'codex',
    ...Object.entries(config.models ?? {}).flatMap(([model, entry]) =>
      isEndpointModel(entry) ? [`custom/${model}`] : [],
    ),
  ];
  const [models, checked] = await Promise.all([
    modelRuns(ctx, config, rows, modelList(config, resolveTaskOptions(settings, config)), viewer),
    modelRuns(
      ctx,
      config,
      rows,
      choices.map(choice => resolveTaskOptions({ model: choice }, config)),
    ),
  ]);

  return {
    models,
    unrunnable: choices.filter(
      (_, index) => !checked[index]!.credentials.length && !checked[index]!.machine,
    ),
  };
}

/** A task's attempts in order: each model on each of its credentials; a model with none runs once on the machine's logins when `machine` allows it, else it is skipped. */
export function modelAttempts(models: ModelRun[], machine = false): ModelAttempt[] {
  return models.flatMap(run =>
    run.credentials.length
      ? run.credentials.map(credential => ({ model: run.model, credential }))
      : run.machine || machine
        ? [{ model: run.model }]
        : [],
  );
}

const ENGINE_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', custom: 'Custom' };

/** Where one model runs for `viewer`, such as "sol on the personal Codex subscription, then the workspace's Codex key". */
export function runsOn(run: ModelRun, viewer?: string): string {
  const name = modelName(run.option);
  const engine = ENGINE_NAMES[run.option.engine] ?? run.option.engine;
  if (run.machine) return `${name} on this machine's ${engine} sign-in`;
  if (!run.credentials.length) return `${name}: no credential, skipped`;
  const accounts = run.credentials.map(id => {
    const { owner, name: label } = parseCredentialId(id);
    const whose = !owner ? "the workspace's" : owner === viewer ? 'the personal' : "the starter's";
    if (Object.hasOwn(SUBSCRIPTION_KEYS, label)) return `${whose} ${engine} subscription`;

    return `${whose} ${Object.values(ENGINE_KEYS).includes(label as never) ? `${engine} key` : label}`;
  });

  return `${name} on ${accounts.join(', then ')}`;
}

/** Where each chain model and the review model of `shown` run for `viewer`, by the spec as written; one the config can't resolve says why. */
export async function runsOnEach(
  ctx: ServerContext,
  shown: Partial<CoderConfig>,
  viewer = ctx.session?.user.id,
): Promise<Record<string, string>> {
  const rows = await ctx.store.listCredentials({ owner: viewer });
  const config = effectiveConfig(ctx, shown);
  const lines = await Promise.all(
    [...config.chain, config.reviewModel].map(async (spec): Promise<[string, string]> => {
      try {
        const option = resolveTaskOptions({ model: spec }, config);
        const [run] = await modelRuns(ctx, config, rows, [option], viewer);
        return [spec, runsOn(run!, viewer)];
      } catch (error) {
        return [spec, `${spec}: ${(error as Error).message}`];
      }
    }),
  );

  return Object.fromEntries(lines);
}

/** Where a whole list runs for `viewer`: each model a credential or this machine runs, in order. */
export function listRunsOn(models: ModelRun[], viewer?: string): string {
  const runnable = models.filter(run => run.credentials.length || run.machine);

  return runnable.length
    ? runnable.map(run => runsOn(run, viewer)).join(', then ')
    : 'No credential runs any listed model';
}

/** Why an agent's own model can't run in a shared thread, where only workspace credentials and a local server's own logins count; `link` makes the fix a link. */
export async function modelProblem(
  ctx: ServerContext,
  settings: { engine?: string; model?: string },
  link = false,
): Promise<string | undefined> {
  if (!settings.engine && !settings.model) return undefined;
  const [first] = (await resolveModels(ctx, settings)).models;
  if (first!.credentials.length || first!.machine) return undefined;
  const engine = first!.option.engine;
  const name = ENGINE_NAMES[engine] ?? engine;
  const add = `Add one in Settings → ${engine === 'custom' ? 'Models' : 'Credentials'}`;

  return `No workspace credential runs ${settings.model ? `${settings.model} (${name})` : name}. ${link ? `[${add}](${await credentialFix(ctx, engine)})` : add}, or pick another model.`;
}

/** Workspace credentials plus the caller's own; nobody sees another member's. */
export async function visibleCredentials(
  store: Store,
  user: string | undefined,
  limit?: number,
): Promise<Array<{ id: string; value: StoredCredential }>> {
  return (await store.listCredentials({ owner: user, limit })).filter(
    row => !row.value.owner || row.value.owner === user,
  );
}

/** The caller's saved value for an env variable, then the workspace's; the local server falls back to its environment. */
export async function credentialEnv(ctx: ServerContext, name: string): Promise<string | undefined> {
  const user = ctx.session?.user.id;
  const [row] = pickCredentials(await visibleCredentials(ctx.store, user), [name], user);

  return (
    (row ? decryptCredential(ctx.config, row.value).env[name] : undefined) ??
    (ctx.local ? process.env[name] : undefined)
  );
}

/** Save a credential under its name in its scope, replacing the one saved there. */
export async function addCredential(
  store: Store,
  config: Pick<ServerConfig, 'encryptionKey'>,
  input: { owner?: string; env: Record<string, string>; account?: CredentialAccount },
  now: () => number = Date.now,
): Promise<{ id: string; replaced: boolean }> {
  const owner = input.owner || undefined;
  const id = credentialId(owner, credentialName(input.env));
  let replaced = false;

  await store.withCredential('credential', id, async current => {
    replaced = Boolean(current);
    const value: StoredCredential = {
      ...encryptCredential(config, { env: input.env }),
      ...(owner ? { owner } : {}),
      ...(input.account ? { account: input.account } : {}),
      createdAt: now(),
    };

    return [{ id, value }];
  });

  return { id, replaced };
}

export function removeCredential(store: Store, id: string): Promise<boolean> {
  return store.withCredential('credential', id, async current => current && [{ id, value: null }]);
}

/** A finished sign-in's subscription, replacing the owner's one for that engine while the login is marked done. */
export async function completeLogin(
  store: Store,
  id: string,
  tokenHash: string,
  credential: StoredCredential,
): Promise<boolean> {
  const login = await store.get('login', id);
  if (!login) return false;
  const target = credentialId(login.owner, login.engine);

  return store.withCredential('credential', target, async (_, __, locked) => {
    const done = await locked.patchLogin(
      id,
      { state: 'done' },
      { state: ['starting', 'open', 'verifying'], tokenHash, owner: login.owner },
    );
    if (!done) return;

    return [{ id: target, value: { ...credential, owner: login.owner } }];
  });
}

function mask(env: Record<string, string>): string {
  if (env.CODEX_AUTH_JSON) return '••••';
  const value = Object.values(env)[0] ?? '';
  return value.length > 16 ? `${value.slice(0, 5)}••••` : '••••';
}

export function credentialSummary(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  id: string,
  stored: StoredCredential,
): CredentialSummary {
  const { name } = parseCredentialId(id);
  return {
    name,
    scope: stored.owner ? 'personal' : 'workspace',
    subscription: Object.hasOwn(SUBSCRIPTION_KEYS, name),
    createdAt: stored.createdAt ?? 0,
    masked: mask(decryptCredential(config, stored).env),
    ...(stored.account ? { account: stored.account } : {}),
  };
}

const lastRefresh = (authJson: string | undefined) => {
  try {
    return Date.parse((JSON.parse(authJson ?? '') as { last_refresh?: string }).last_refresh ?? '');
  } catch {
    return Number.NaN;
  }
};

/** A task's rotated Codex `auth.json`; kept only when its `last_refresh` is newer than the stored one. */
export function writeBackCodexAuth(
  store: Store,
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  id: string,
  authJson: string,
): Promise<boolean> {
  return store.withCredential('credential', id, async current => {
    if (!current) return;
    const { env } = decryptCredential(config, current);
    if (!env.CODEX_AUTH_JSON || !(lastRefresh(authJson) > (lastRefresh(env.CODEX_AUTH_JSON) || 0)))
      return;

    return [
      {
        id,
        value: {
          ...current,
          ...encryptCredential(config, { env: { ...env, CODEX_AUTH_JSON: authJson } }),
        },
      },
    ];
  });
}

function encryptedVersion(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  value: EncryptedCredential,
): number {
  return secretKeyVersion(
    config,
    value.iv === 'plain'
      ? `plain.${value.ciphertext}`
      : `${value.iv}.${value.tag}.${value.ciphertext}`,
  );
}

/** Re-seal every stored secret that is not already protected by the current key, each reread under its lock. */
export async function reseal(
  store: Store,
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  now: () => number = Date.now,
): Promise<number> {
  if (!config.encryptionKey) throw new Error('SERVER_ENCRYPTION_KEY is required to rotate keys');
  const current = keyVersion(config.encryptionKey);
  const stale = (sealed: string) => secretKeyVersion(config, sealed) !== current;
  const renew = (sealed: string) =>
    stale(sealed) ? encryptSecret(config, decryptSecret(config, sealed)) : sealed;
  const resealed = (value: Installation): Installation | undefined => {
    const token = value.token && renew(value.token);
    if (token === value.token) return;

    return { ...value, token };
  };
  let moved = 0;
  for (const { id } of await store.list('app')) {
    const written = await store.withAppLock(id, async locked => {
      const value = await locked.get('app', id);
      if (!value || !stale(value.credentials)) return false;
      await locked.put('app', id, { ...value, credentials: renew(value.credentials) });

      return true;
    });
    if (written) moved++;
  }
  for (const { id } of await store.list('installation')) {
    const written = await store.withCredential('installation', id, async value => {
      const next = value && resealed(value);

      return next && [{ id, value: next }];
    });
    if (written) moved++;
  }
  for (const { id } of await store.list('connection')) {
    const written = await store.withAppLock(`connection:${id}`, async locked => {
      const value = await locked.get('connection', id);
      if (!value?.secret || !stale(value.secret)) return false;
      await locked.put('connection', id, { ...value, secret: renew(value.secret) });

      return true;
    });
    if (written) moved++;
  }
  for (const { id } of await store.list('snapshot')) {
    const taskId = id.startsWith('connection-secrets:')
      ? id.slice('connection-secrets:'.length).replace(/:[a-f0-9]{24}$/, '')
      : id.startsWith('connections:')
        ? id.slice('connections:'.length).replace(/:\d+:\d+:[a-f0-9]{12}$/, '')
        : undefined;
    const written = await store.withAppLock(taskId ? `connections:${taskId}` : id, async locked => {
      const value = await locked.get('snapshot', id);
      if (!value) return false;
      const field =
        'resolvedConnections' in value
          ? 'resolvedConnections'
          : 'secret' in value
            ? 'secret'
            : undefined;
      if (!field) return false;
      const status = taskId ? await locked.get('task', taskId) : undefined;
      if (!status || ['completed', 'failed', 'cancelled'].includes(status.status)) {
        await locked.delete('snapshot', id);
        return false;
      }
      const sealed = (value as { resolvedConnections?: string; secret?: string })[field]!;
      if (!stale(sealed)) return false;
      await locked.put(
        'snapshot',
        id,
        { ...value, [field]: renew(sealed) },
        {
          ttlMs:
            'expiresAt' in value && typeof value.expiresAt === 'number'
              ? Math.max(1, value.expiresAt - now())
              : 60 * 60 * 1000,
        },
      );

      return true;
    });
    if (written) moved++;
  }
  for (const { id } of await store.list('runner')) {
    const written = await store.withCredential('runner', id, async value => {
      if (!value || !stale(value.secret)) return;

      return [{ id, value: { ...value, secret: renew(value.secret) } }];
    });
    if (written) moved++;
  }
  for (const { id } of await store.list('credential')) {
    const written = await store.withCredential('credential', id, async value => {
      if (!value || encryptedVersion(config, value) === current) return;

      return [
        {
          id,
          value: {
            ...value,
            ...encryptCredential(config, decryptCredential(config, value)),
          },
        },
      ];
    });
    if (written) moved++;
  }

  return moved;
}

/** The one-click fix for a missing credential: the Credentials page, open at that engine. */
export async function credentialFix(
  ctx: ServerContext,
  engine: string,
  slug?: string,
): Promise<string> {
  const page = dashPath(
    slug ?? (await organizationSlug(ctx)),
    engine === 'custom' ? '/settings/models' : '/settings/credentials',
  );

  return `${ctx.config.publicUrl?.replace(/\/$/, '') ?? ''}${page}${engine === 'custom' ? '' : `?engine=${encodeURIComponent(engine)}`}`;
}

/** Where a platform account connects to its member: the Connections page, open at that platform. */
export async function connectionFix(
  ctx: ServerContext,
  integration: string,
  slug?: string,
): Promise<string> {
  const page = dashPath(slug ?? (await organizationSlug(ctx)), '/settings/connections');

  return `${ctx.config.publicUrl?.replace(/\/$/, '') ?? ''}${page}?connect=${encodeURIComponent(integration)}`;
}

/** What a thread gets when a run fails without an answer. */
export async function failureText(
  ctx: ServerContext,
  engine: string,
  slug?: string,
): Promise<string> {
  return `There was a problem with your connected model. If you have access to it, [Check the model](${await credentialFix(ctx, engine, slug)}).`;
}

const credentialSchema = z.object({
  env: z.record(z.string().check(z.regex(/^[A-Z_][A-Z0-9_]*$/)), z.string().check(z.minLength(1))),
  workspace: z.optional(z.boolean()),
  noCheck: z.optional(z.boolean()),
});

const ADMINS_ONLY = 'Only an owner or admin of this workspace can change workspace credentials.';

export async function listCredentials(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const user = ctx.session?.user.id;
  const key = (row: CredentialSummary) => `${row.scope}/${row.name}`;
  const compare = (a: string, b: string) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0);
  const fields = url.searchParams.get('fields');
  if (fields && fields !== 'id') return json({ error: 'Invalid fields' }, 400);
  if (fields === 'id') {
    const after = decodeCursor<string>(url);
    const limit = pageLimit(url, 200);
    const records = await ctx.store.list('credential', {
      visibleTo: user,
      ...(after ? { after } : {}),
      limit: paged(url) ? limit + 1 : limit,
    });
    const ids = records.map(({ id }) => ({ id }));
    return json(paged(url) ? page(ids, limit, row => row.id) : ids);
  }
  const rows = (
    await visibleCredentials(ctx.store, user, paged(url) ? undefined : pageLimit(url, 200))
  )
    .map(row => credentialSummary(ctx.config, row.id, row.value))
    .sort((a, b) => compare(key(a), key(b)));
  if (!paged(url)) return json(rows.slice(0, pageLimit(url, 200)));

  const after = decodeCursor<string>(url);
  const q = url.searchParams.get('q')?.trim().toLowerCase();
  const matching = rows
    .filter(
      row =>
        !q || [row.name, row.account?.email ?? ''].some(value => value.toLowerCase().includes(q)),
    )
    .filter(row => !after || compare(key(row), after) > 0);

  return json(page(matching, pageLimit(url), key));
}

export async function createCredential(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const user = ctx.session?.user.id;

  const body = await req.json().catch(() => undefined);
  const parsed = credentialSchema.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data.env).length !== 1)
    return json({ error: 'Invalid credential' }, 400);

  const { env } = parsed.data;
  const workspace = Boolean(parsed.data.workspace) || !user;
  if (workspace && !workspaceAdmin(ctx)) return json({ error: ADMINS_ONLY }, 403);
  if (env.CODEX_AUTH_JSON)
    return json({ error: 'Sign in with Codex on the Credentials page instead.' }, 400);
  // A pasted setup-token is a subscription: your own, and only where subscription sign-in is on.
  if (env.CLAUDE_CODE_OAUTH_TOKEN && !ctx.config.subscriptions?.claude)
    return json({ error: 'Claude subscriptions are off on this server; add an API key.' }, 400);
  if (env.CLAUDE_CODE_OAUTH_TOKEN && workspace && ctx.auth)
    return json({ error: 'A Claude subscription is personal; add it without --workspace.' }, 400);

  const owner = workspace ? undefined : user;
  const engine = env.CLAUDE_CODE_OAUTH_TOKEN
    ? 'claude'
    : ((Object.keys(ENGINE_KEYS) as LoginEngine[]).find(engine => ENGINE_KEYS[engine] in env) ??
      'custom');

  try {
    if (!parsed.data.noCheck) await checkCredential({ engine, env }, ctx.fetch ?? fetch);

    const { id, replaced } = await addCredential(
      ctx.store,
      ctx.config,
      { ...(owner ? { owner } : {}), env },
      ctx.now ?? Date.now,
    );

    return json({ ok: true, name: parseCredentialId(id).name, replaced });
  } catch (error) {
    if (error instanceof CredentialCheckError) return json({ error: error.message }, error.status);
    console.error('coder server: could not save credential', error);

    return json({ error: 'Could not save credential. Please try again.' }, 500);
  }
}

export async function deleteCredential(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const user = ctx.session?.user.id;
  const workspace = url.searchParams.has('workspace') || !user;
  if (workspace && !workspaceAdmin(ctx)) return json({ error: ADMINS_ONLY }, 403);
  const id = credentialId(workspace ? undefined : user, params.name!);

  return (await removeCredential(ctx.store, id))
    ? json({ ok: true })
    : json({ error: 'Unknown credential' }, 404);
}

export async function signInEngine(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const engine = params.engine as 'claude' | 'codex';
  engineSignIn(engine);
  if (ctx.local) ctx.local.engineChecks = undefined;

  return json(await engineStatus());
}

export async function signOutEngine(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const engine = params.engine as 'claude' | 'codex';
  await engineSignOut(engine);
  if (ctx.local) ctx.local.engineChecks = undefined;

  return json(await engineStatus());
}
