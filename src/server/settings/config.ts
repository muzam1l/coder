import fs from 'node:fs';
import { type Params } from '../routes/match';
import {
  loadConfig,
  withDefaults,
  type CoderConfig,
  type McpConfigEntry,
  resolveUserConfigFile,
  validateConfig,
  writeUserConfig,
} from '../../core/config';
import { taskError } from '../tasks/admin';
import { json } from '../routes/http';
import { type ServerConfig, type ServerContext } from '../context';
import { decryptSecret, encryptSecret, keyVersion, secretKeyVersion } from '../store/secrets';
import { type Store } from '../store/types';

/** The workspace's CLI config on the server: what `.coder/config.json` holds locally; a local server edits the user's own file. */

type Keys = Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>;
type Where = Pick<ServerContext, 'store' | 'config' | 'local' | 'settings'>;
type Secrets = Record<string, Pick<McpConfigEntry, 'env' | 'headers'>>;

/** Stored form: MCP `env` and `headers` values sealed together in `sealed`. */
export type StoredConfig = Partial<CoderConfig> & { sealed?: string };

export class ConfigError extends Error {}

const read = async (store: Store) => (await store.get('config', 'workspace')) ?? {};

/** The config a task runs with, secrets included. */
export async function taskConfig(store: Store, keys: Keys): Promise<Partial<CoderConfig>> {
  const { sealed, ...config } = await read(store);
  if (!sealed) return config;
  const secrets = decryptSecret<Secrets>(keys, sealed);
  return {
    ...config,
    mcp: Object.fromEntries(
      Object.entries(config.mcp ?? {}).map(([name, entry]) => [
        name,
        { ...entry, ...secrets[name] },
      ]),
    ),
  };
}

/** `$CODER_HOME/config.json`, the file `coder config` reads and writes. */
function userConfig(): Partial<CoderConfig> {
  const file = resolveUserConfigFile();
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Invalid JSON in ${file}: ${(error as Error).message}`);
  }
}

/** `config` with every MCP `env` and `headers` value masked. */
export function maskedMcp<T extends Partial<CoderConfig>>(config: T): T {
  return config.mcp
    ? {
        ...config,
        mcp: Object.fromEntries(
          Object.entries(config.mcp).map(([name, entry]) => [name, masked(entry)]),
        ),
      }
    : config;
}

/** The config as members see it: MCP secret values masked. */
export async function shownConfig(where: Where): Promise<Partial<CoderConfig>> {
  if (where.local) return maskedMcp(userConfig());
  const { sealed: _sealed, ...config } = await read(where.store);
  return config;
}

/** Validate and store a whole config; a masked value keeps the stored one. */
export async function saveConfig(
  where: Where,
  next: Partial<CoderConfig>,
): Promise<Partial<CoderConfig>> {
  return serialize(where, locked => storeConfig(locked, next));
}

async function serialize<T>(where: Where, work: (locked: Where) => Promise<T>): Promise<T> {
  const settings = (where.settings ??= {});
  const pending = (settings.configUpdate ?? Promise.resolve())
    .catch(() => {})
    .then(() =>
      where.local ? work(where) : where.store.withConfigLock(store => work({ ...where, store })),
    );
  settings.configUpdate = pending;
  try {
    return await pending;
  } finally {
    if (settings.configUpdate === pending) delete settings.configUpdate;
  }
}

function assertConfig(next: unknown): asserts next is Partial<CoderConfig> {
  const errors = validateConfig(next);
  if (errors.length) throw new ConfigError(errors.join('; '));
}

async function storeConfig(where: Where, next: unknown): Promise<Partial<CoderConfig>> {
  assertConfig(next);
  const current = where.local ? userConfig() : await taskConfig(where.store, where.config);
  const plain: NonNullable<CoderConfig['mcp']> = {};
  const secrets: Secrets = {};
  const mcp = Object.fromEntries(
    Object.entries(next.mcp ?? {}).map(([name, entry]) => {
      const kept = (field: 'env' | 'headers') =>
        entry[field] &&
        Object.fromEntries(
          Object.entries(entry[field]).map(([key, value]) => [
            key,
            value === MASK ? (current.mcp?.[name]?.[field]?.[key] ?? '') : value,
          ]),
        );
      const env = kept('env');
      const headers = kept('headers');
      if (env || headers)
        secrets[name] = { ...(env ? { env } : {}), ...(headers ? { headers } : {}) };
      plain[name] = { ...entry, ...secrets[name] };
      return [name, masked(entry)];
    }),
  );
  if (where.local) {
    writeUserConfig({ ...next, ...(next.mcp ? { mcp: plain } : {}) } as CoderConfig);
    return shownConfig(where);
  }
  const stored: StoredConfig = {
    ...next,
    ...(next.mcp ? { mcp } : {}),
    ...(Object.keys(secrets).length ? { sealed: encryptSecret(where.config, secrets) } : {}),
  };
  await where.store.put('config', 'workspace', stored);
  return shownConfig(where);
}

/** Change part of the config, as `coder model` and `coder mcp` change one file. */
export async function updateConfig(
  where: Where,
  change: (config: Partial<CoderConfig>) => void,
): Promise<Partial<CoderConfig>> {
  return serialize(where, async locked => {
    const config = structuredClone(
      locked.local ? userConfig() : await taskConfig(locked.store, locked.config),
    );
    change(config);
    return storeConfig(locked, config);
  });
}

/** RFC 7396 merge patch; validation applies to the resulting config. */
export function patchConfig(where: Where, patch: unknown): Promise<Partial<CoderConfig>> {
  return serialize(where, async locked => {
    const current = locked.local ? userConfig() : await taskConfig(locked.store, locked.config);
    const next = mergePatch(current, patch);
    return storeConfig(locked, next);
  });
}

function mergePatch(target: unknown, patch: unknown): unknown {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const result: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? Object.fromEntries(Object.entries(target))
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else
      Object.defineProperty(result, key, {
        value: mergePatch(Object.hasOwn(result, key) ? result[key] : undefined, value),
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  return result;
}

const MASK = '********';

function masked(entry: McpConfigEntry): McpConfigEntry {
  const hide = (values?: Record<string, string>) =>
    values && Object.fromEntries(Object.keys(values).map(key => [key, MASK]));
  return {
    ...entry,
    ...(entry.env ? { env: hide(entry.env) } : {}),
    ...(entry.headers ? { headers: hide(entry.headers) } : {}),
  };
}

/** Re-seal the MCP secrets under the current key. */
export async function resealConfig(store: Store, keys: Keys): Promise<number> {
  return store.withConfigLock(async locked => {
    const stored = await read(locked);
    if (!stored.sealed || secretKeyVersion(keys, stored.sealed) === keyVersion(keys.encryptionKey!))
      return 0;
    await locked.put('config', 'workspace', {
      ...stored,
      sealed: encryptSecret(keys, decryptSecret(keys, stored.sealed)),
    });
    return 1;
  });
}

export async function body<T>(req: Request): Promise<T> {
  const value = (await req.json().catch(() => undefined)) as T | undefined;
  if (!value || typeof value !== 'object') throw new ConfigError('A JSON body is required');
  return value;
}

export async function change(
  ctx: ServerContext,
  apply: (config: Partial<CoderConfig>) => void,
): Promise<Response> {
  try {
    return json(await updateConfig(ctx, apply));
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);
    throw error;
  }
}

export async function readConfig(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  try {
    {
      {
        const config = await shownConfig(ctx);

        return json({
          config,
          effective: ctx.local ? maskedMcp(loadConfig(ctx.local.cwd)) : withDefaults(config),
        });
      }
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);

    return taskError(error);
  }
}

export async function patchConfiguration(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  try {
    {
      {
        const patch = await req.json().catch(() => {
          throw new ConfigError('A JSON body is required');
        });

        return json(await patchConfig(ctx, patch));
      }
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);

    return taskError(error);
  }
}

export async function saveConfiguration(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  try {
    {
      return json(await saveConfig(ctx, await body(req)));
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);

    return taskError(error);
  }
}
