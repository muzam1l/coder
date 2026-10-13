import fs from 'node:fs';
import { type Params } from '../routes/match';
import {
  loadConfig,
  withDefaults,
  type CoderConfig,
  resolveUserConfigFile,
  validateConfig,
  writeUserConfig,
} from '../../core/config';
import { taskError } from '../tasks/admin';
import { json } from '../routes/http';
import { type ServerContext } from '../context';
import { type Store } from '../store/types';

/** The workspace's CLI config on the server: what `.coder/config.json` holds locally; a local server edits the user's own file. MCP servers are connections, not config. */

type Where = Pick<ServerContext, 'store' | 'config' | 'local' | 'settings'>;

export type StoredConfig = Partial<CoderConfig>;

export class ConfigError extends Error {}

const read = async (store: Store) => (await store.get('config', 'workspace')) ?? {};

/** The config a task runs with. */
export async function taskConfig(store: Store): Promise<Partial<CoderConfig>> {
  return read(store);
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

/** `config` without the `mcp` map a local user file may hold. */
function withoutMcp<T extends Partial<CoderConfig>>(config: T): T {
  const { mcp: _mcp, ...rest } = config;
  return rest as T;
}

/** The config as members see it. */
export async function shownConfig(where: Where): Promise<Partial<CoderConfig>> {
  return where.local ? withoutMcp(userConfig()) : read(where.store);
}

/** The config tasks run with: a local server's folder config, else the shown one over the defaults. */
export const effectiveConfig = (where: Where, config: Partial<CoderConfig>) =>
  where.local ? withoutMcp(loadConfig(where.local.cwd)) : withDefaults(config);

/** Validate and store a whole config. */
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
  if (next.mcp) throw new ConfigError('Add a connection in Settings to attach an MCP server');
  if (where.local) {
    const { mcp } = userConfig();
    writeUserConfig({ ...next, ...(mcp ? { mcp } : {}) } as CoderConfig);
    return shownConfig(where);
  }
  await where.store.put('config', 'workspace', next);
  return shownConfig(where);
}

const current = async (where: Where) =>
  where.local ? withoutMcp(userConfig()) : taskConfig(where.store);

/** Change part of the config, as `coder model` changes one file. */
export async function updateConfig(
  where: Where,
  change: (config: Partial<CoderConfig>) => void,
): Promise<Partial<CoderConfig>> {
  return serialize(where, async locked => {
    const config = structuredClone(await current(locked));
    change(config);
    return storeConfig(locked, config);
  });
}

/** RFC 7396 merge patch; validation applies to the resulting config. */
export function patchConfig(where: Where, patch: unknown): Promise<Partial<CoderConfig>> {
  return serialize(where, async locked =>
    storeConfig(locked, mergePatch(await current(locked), patch)),
  );
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

        return json({ config, effective: effectiveConfig(ctx, config) });
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
