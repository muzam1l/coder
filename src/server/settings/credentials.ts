import * as z from 'zod/mini';
import process from 'node:process';
import { type Params } from '../routes/match';
import { type ServerConfig, type ServerContext } from '../context';
import { workspaceAdmin } from '../routes/guards';
import { decodeCursor, json, page, pageLimit, paged } from '../routes/http';
import { engineSignIn, engineSignOut, engineStatus } from '../tasks/local';
import { type Installation } from '../../agent/types';
import { type CredentialChange, type EngineCredential, type Store } from '../store/types';
import {
  decryptCredential,
  decryptSecret,
  encryptCredential,
  encryptSecret,
  keyVersion,
  secretKeyVersion,
  type EncryptedCredential,
} from '../store/secrets';
import { resealConfig } from './config';

/** Engine credentials stored for a workspace or a member; every row change goes through `store.withCredential`. */

export interface StoredCredential extends EncryptedCredential {
  engine: EngineCredential['engine'];
  /** Wular user id of a personal credential; absent for a workspace one. */
  owner?: string;
  account?: CredentialAccount;
  isDefault?: boolean;
  createdAt?: number;
}

export interface CredentialAccount {
  email?: string;
  plan?: string;
}

export interface CredentialSummary {
  label: string;
  engine: EngineCredential['engine'];
  scope: 'personal' | 'workspace';
  isDefault: boolean;
  createdAt: number;
  env: string[];
  /** The secret with all but its ends hidden. */
  masked: string;
  account?: CredentialAccount;
}

type CredentialRow = { id: string; value: StoredCredential };
type Change = CredentialChange<'credential'>;

/** Store id: the label for a workspace credential, `<owner>/<label>` for a personal one. */
export function credentialId(owner: string | undefined, label: string): string {
  return owner ? `${owner}/${label}` : label;
}

export function parseCredentialId(id: string): {
  owner?: string;
  label: string;
} {
  const at = id.lastIndexOf('/');
  return at < 0 ? { label: id } : { owner: id.slice(0, at), label: id.slice(at + 1) };
}

export class CredentialCheckError extends Error {
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

/** The requester's own default for the engine, then the workspace's; tasks without a requester use the workspace's only. */
export async function resolveCredential(
  store: Store,
  engine: string | undefined,
  requester?: string,
): Promise<{ id: string; value: StoredCredential } | undefined> {
  const rows = store.listCredentials
    ? await store.listCredentials({ owner: requester, engine })
    : await store.list('credential');
  const pick = (owner: string | undefined) => {
    const scoped = rows.filter(
      row => row.value.owner === owner && (!engine || row.value.engine === engine),
    );
    return scoped.find(row => row.value.isDefault) ?? scoped[0];
  };
  return (requester ? pick(requester) : undefined) ?? pick(undefined);
}

/** Workspace credentials plus the caller's own; nobody sees another member's. */
export async function visibleCredentials(
  store: Store,
  user: string | undefined,
): Promise<Array<{ id: string; value: StoredCredential }>> {
  return (
    store.listCredentials
      ? await store.listCredentials({ owner: user })
      : await store.list('credential')
  ).filter(row => !row.value.owner || row.value.owner === user);
}

/** The caller's saved value for an env variable, then the workspace's; the local server falls back to its environment. */
export async function credentialEnv(ctx: ServerContext, name: string): Promise<string | undefined> {
  const user = ctx.session?.user.id;
  const rows = await visibleCredentials(ctx.store, user);
  const saved = (owner: string | undefined) =>
    rows
      .filter(row => row.value.owner === owner)
      .sort((a, b) => Number(Boolean(b.value.isDefault)) - Number(Boolean(a.value.isDefault)))
      .map(row => credentialValue(ctx.config, row.value).env[name])
      .find(Boolean);

  return (
    (user ? saved(user) : undefined) ??
    saved(undefined) ??
    (ctx.local ? process.env[name] : undefined)
  );
}

function availableLabel(rows: CredentialRow[], base: string): string {
  const taken = new Set(rows.map(row => parseCredentialId(row.id).label));
  let label = base;
  for (let n = 2; taken.has(label); n++) label = `${base}-${n}`;

  return label;
}

const peers = (rows: CredentialRow[], id: string, engine: string) =>
  rows.filter(row => row.id !== id && row.value.engine === engine);
const flag = (row: CredentialRow, isDefault: boolean): Change => ({
  id: row.id,
  value: { ...row.value, isDefault },
});

/** The flag changes that leave `id` as its engine's only default. */
function makeDefault(rows: CredentialRow[], id: string, engine: string): Change[] {
  return peers(rows, id, engine)
    .filter(row => row.value.isDefault)
    .map(row => flag(row, false));
}

/** The flag change that hands a departing default over to the engine's first remaining peer. */
function handOver(rows: CredentialRow[], id: string, engine: string): Change[] {
  const next = peers(rows, id, engine)[0];
  return next ? [flag(next, true)] : [];
}

/** Insert or replace a credential; automatic labels are chosen under the lock. Returns the label. */
export async function addCredential(
  store: Store,
  config: Pick<ServerConfig, 'encryptionKey'>,
  input: {
    label?: string;
    owner?: string;
    credential: EngineCredential;
    account?: CredentialAccount;
    makeDefault?: boolean;
  },
  now: () => number = Date.now,
): Promise<string> {
  const owner = input.owner || undefined;
  const engine = input.credential.engine;
  const chosen = input.label?.trim();
  let label =
    chosen || (input.credential.env.CLAUDE_CODE_OAUTH_TOKEN ? 'claude-token' : `${engine}-key`);

  await store.withCredential('credential', credentialId(owner, label), async (_, rows) => {
    if (!chosen) label = availableLabel(rows, label);
    const id = credentialId(owner, label);
    const existing = rows.find(row => row.id === id)?.value;
    const isDefault = Boolean(
      input.makeDefault ||
      (existing?.isDefault && existing.engine === engine) ||
      !peers(rows, id, engine).some(row => row.value.isDefault),
    );
    const value: StoredCredential = {
      ...encryptCredential(config, { env: input.credential.env }),
      engine,
      ...(owner ? { owner } : {}),
      ...(input.account ? { account: input.account } : {}),
      isDefault,
      createdAt: existing?.createdAt ?? now(),
    };

    return [
      { id, value },
      ...(isDefault ? makeDefault(rows, id, engine) : []),
      ...(existing?.isDefault && existing.engine !== engine
        ? handOver(rows, id, existing.engine)
        : []),
    ];
  });

  return label;
}

/** Remove one credential; a removed default hands over to the next in its scope. */
export function removeCredential(store: Store, id: string): Promise<boolean> {
  return store.withCredential(
    'credential',
    id,
    async (current, rows) =>
      current && [
        { id, value: null },
        ...(current.isDefault ? handOver(rows, id, current.engine) : []),
      ],
  );
}

/** Flag one credential as its owner's default for its engine; false when it does not exist. */
export function setDefault(store: Store, id: string): Promise<boolean> {
  return store.withCredential(
    'credential',
    id,
    async (current, rows) =>
      current && [flag({ id, value: current }, true), ...makeDefault(rows, id, current.engine)],
  );
}

/** A finished sign-in's credential, saved as the owner's default while the login is marked done. */
export async function completeLogin(
  store: Store,
  id: string,
  tokenHash: string,
  label: string,
  credential: StoredCredential,
): Promise<boolean> {
  const login = await store.get('login', id);
  if (!login) return false;
  const target = credentialId(login.owner, label);

  return store.withCredential('credential', target, async (current, rows, locked) => {
    const done = await locked.patchLogin(
      id,
      { state: 'done', label },
      { state: ['starting', 'open', 'verifying'], tokenHash, owner: login.owner },
    );
    if (!done) return;
    const value: StoredCredential = {
      ...credential,
      owner: login.owner,
      engine: login.engine,
      isDefault: true,
      createdAt: current?.createdAt ?? credential.createdAt,
    };

    return [{ id: target, value }, ...makeDefault(rows, target, login.engine)];
  });
}

export function credentialValue(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  stored: StoredCredential,
): EngineCredential {
  return {
    ...decryptCredential(config, stored),
    engine: stored.engine,
  };
}

function mask(env: Record<string, string>): string {
  if (env.CODEX_AUTH_JSON) return 'auth.json';
  const value = Object.values(env)[0] ?? '';
  return value.length > 16 ? `${value.slice(0, 7)}…${value.slice(-4)}` : '••••';
}

export function credentialSummary(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  id: string,
  stored: StoredCredential,
): CredentialSummary {
  const value = credentialValue(config, stored);
  return {
    label: parseCredentialId(id).label,
    engine: stored.engine,
    scope: stored.owner ? 'personal' : 'workspace',
    isDefault: Boolean(stored.isDefault),
    createdAt: stored.createdAt ?? 0,
    env: Object.keys(value.env).sort(),
    masked: mask(value.env),
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
    const { env } = credentialValue(config, current);
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
): Promise<number> {
  if (!config.encryptionKey) throw new Error('SERVER_ENCRYPTION_KEY is required to rotate keys');
  const current = keyVersion(config.encryptionKey);
  const stale = (sealed: string) => secretKeyVersion(config, sealed) !== current;
  const renew = (sealed: string) =>
    stale(sealed) ? encryptSecret(config, decryptSecret(config, sealed)) : sealed;
  const resealed = (value: Installation): Installation | undefined => {
    const token = value.token && renew(value.token);
    const connections =
      value.connections &&
      Object.fromEntries(
        Object.entries(value.connections).map(([key, connection]) => [
          key,
          connection.kind === 'oauth' && stale(connection.token)
            ? { ...connection, token: renew(connection.token) }
            : connection,
        ]),
      );
    if (
      token === value.token &&
      !Object.entries(connections ?? {}).some(
        ([key, connection]) => connection !== value.connections![key],
      )
    )
      return;

    return { ...value, ...(token ? { token } : {}), ...(connections ? { connections } : {}) };
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
            ...encryptCredential(config, { env: credentialValue(config, value).env }),
          },
        },
      ];
    });
    if (written) moved++;
  }

  return moved + (await resealConfig(store, config));
}

/** The one-click fix for a missing credential: the Credentials page, open at that engine. */
export function credentialFix(ctx: ServerContext, engine: string): string {
  return `${ctx.config.publicUrl?.replace(/\/$/, '') ?? ''}/dash/settings/credentials?engine=${encodeURIComponent(engine)}`;
}

const credentialSchema = z.object({
  label: z.optional(z.string().check(z.regex(/^[^/\s][^/]*$/))),
  env: z.record(z.string(), z.string().check(z.minLength(1))),
  engine: z.enum(['claude', 'codex', 'custom']),
  workspace: z.optional(z.boolean()),
  default: z.optional(z.boolean()),
  noCheck: z.optional(z.boolean()),
});

const ADMINS_ONLY = 'Only an owner or admin of this workspace can change workspace credentials.';

function scopedId(ctx: ServerContext, url: URL, label: string) {
  const user = ctx.session?.user.id;
  const workspace = url.searchParams.has('workspace') || !user;
  return { workspace, id: credentialId(workspace ? undefined : user, label) };
}

export async function listCredentials(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const label = params.label!;
  const user = ctx.session?.user.id;
  const key = (row: CredentialSummary) => `${row.engine}/${row.scope}/${row.label}`;
  const compare = (a: string, b: string) => a.localeCompare(b) || (a < b ? -1 : a > b ? 1 : 0);
  const rows = (await visibleCredentials(ctx.store, user))
    .map(row => credentialSummary(ctx.config, row.id, row.value))
    .sort((a, b) => compare(key(a), key(b)));
  if (!paged(url)) return json(rows);

  const after = decodeCursor<string>(url);
  const q = url.searchParams.get('q')?.trim().toLowerCase();
  const matching = rows
    .filter(
      row =>
        !q ||
        [row.label, row.engine, row.account?.email ?? '', ...row.env].some(value =>
          value.toLowerCase().includes(q),
        ),
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
  const label = params.label!;
  const user = ctx.session?.user.id;

  const body = await req.json().catch(() => undefined);
  const parsed = credentialSchema.safeParse(body);
  if (
    !parsed.success ||
    !Object.keys(parsed.data.env).length ||
    Object.keys(parsed.data.env).some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
  )
    return json({ error: 'Invalid credential' }, 400);

  const { env, engine } = parsed.data;
  const workspace = Boolean(parsed.data.workspace) || !user;
  if (workspace && !workspaceAdmin(ctx)) return json({ error: ADMINS_ONLY }, 403);
  if (env.CODEX_AUTH_JSON)
    return json({ error: 'Sign in with Codex on the Credentials page instead.' }, 400);
  // A pasted setup-token is your own, and only where subscription sign-in is off.
  if (env.CLAUDE_CODE_OAUTH_TOKEN && ((workspace && ctx.auth) || ctx.config.subscriptions?.claude))
    return json({ error: 'Sign in with Claude on the Credentials page instead.' }, 400);

  const owner = workspace ? undefined : user;

  try {
    if (!parsed.data.noCheck) await checkCredential({ engine, env }, ctx.fetch ?? fetch);

    const label = await addCredential(
      ctx.store,
      ctx.config,
      {
        label: parsed.data.label?.trim() || undefined,
        ...(owner ? { owner } : {}),
        credential: { env, engine },
        makeDefault: parsed.data.default,
      },
      ctx.now ?? Date.now,
    );

    return json({ ok: true, label });
  } catch (error) {
    return json(
      { error: error instanceof Error ? error.message : String(error) },
      error instanceof CredentialCheckError ? error.status : 400,
    );
  }
}

export async function deleteCredential(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const label = params.label!;
  const user = ctx.session?.user.id;
  const { workspace, id } = scopedId(ctx, url, label!);
  const unknown = () => json({ error: 'Unknown credential' }, 404);
  if (workspace && !workspaceAdmin(ctx)) return json({ error: ADMINS_ONLY }, 403);

  return (await removeCredential(ctx.store, id)) ? json({ ok: true }) : unknown();
}

export async function defaultCredential(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const label = params.label!;
  const user = ctx.session?.user.id;
  const { workspace, id } = scopedId(ctx, url, label!);
  const unknown = () => json({ error: 'Unknown credential' }, 404);
  if (workspace && !workspaceAdmin(ctx)) return json({ error: ADMINS_ONLY }, 403);

  return (await setDefault(ctx.store, id)) ? json({ ok: true }) : unknown();
}

const now = (ctx: ServerContext) => (ctx.now ?? Date.now)();

export async function signInEngine(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const engine = params.engine as 'claude' | 'codex';
  engineSignIn(engine);

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

  return json(await engineStatus());
}
