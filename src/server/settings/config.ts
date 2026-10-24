import fs from 'node:fs';
import { type Params } from '../routes/match';
import {
  CONFIG_VERSION,
  configJsonSchema,
  loadConfig,
  upgradeConfig,
  withDefaults,
  type CoderConfig,
  resolveUserConfigFile,
  validateConfig,
  writeUserConfig,
} from '../../core/config';
import { taskError } from '../tasks/admin';
import { json } from '../routes/http';
import { mergePatch } from '../../core/types';
import { type ServerContext } from '../context';
import { type Store } from '../store/types';
import { runsOnEach } from './credentials';

/** The workspace's CLI config on the server: what `.coder/config.json` holds locally; a local server edits the user's own file. MCP servers are connections, not config. */

type Where = Pick<ServerContext, 'store' | 'config' | 'local' | 'settings'>;

export type StoredConfig = Partial<CoderConfig>;

export class ConfigError extends Error {}

/** The stored workspace config; one at another config version is refused until the deploy migration rewrites it. */
export async function taskConfig(store: Store): Promise<StoredConfig> {
  const stored = await store.get('config', 'workspace');
  if (stored && stored.version !== CONFIG_VERSION)
    throw new ConfigError(
      `The workspace config is config version ${stored.version ?? 0}; this Coder reads version ${CONFIG_VERSION}.`,
    );

  return stored ?? {};
}

/** `$CODER_HOME/config.json`, the file `coder config` reads and writes, at this Coder's config version. */
function userConfig(): Partial<CoderConfig> {
  const file = resolveUserConfigFile();
  if (!fs.existsSync(file)) return {};
  try {
    return upgradeConfig(JSON.parse(fs.readFileSync(file, 'utf8'))).config;
  } catch (error) {
    throw new ConfigError(`Invalid config in ${file}: ${(error as Error).message}`);
  }
}

/** `config` without the `mcp` map a local user file may hold. */
function withoutMcp<T extends Partial<CoderConfig>>(config: T): T {
  const { mcp: _mcp, ...rest } = config;
  return rest as T;
}

/** The config as members see it. */
export async function shownConfig(where: Where): Promise<Partial<CoderConfig>> {
  return where.local ? withoutMcp(userConfig()) : taskConfig(where.store);
}

/** The config tasks run with: a local server's folder config, else the shown one over the defaults. */
export const effectiveConfig = (where: Where, config: Partial<CoderConfig>) =>
  where.local ? withoutMcp(loadConfig(where.local.cwd)) : withDefaults(config);

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

async function storeConfig(where: Where, value: unknown): Promise<Partial<CoderConfig>> {
  const next =
    value && typeof value === 'object' && !Array.isArray(value)
      ? { ...value, version: CONFIG_VERSION }
      : value;
  assertConfig(next);
  if (next.mcp) throw new ConfigError('Add a connection in Settings to attach an MCP server');
  if (where.local) {
    const { mcp } = userConfig();
    writeUserConfig({ ...next, ...(mcp ? { mcp } : {}) } as CoderConfig);
    return shownConfig(where);
  }
  await where.store.put('config', 'workspace', next);
  return withoutMcp(next);
}

/** Change part of the config, as `coder model` changes one file. */
export async function updateConfig(
  where: Where,
  change: (config: Partial<CoderConfig>) => void,
): Promise<Partial<CoderConfig>> {
  return serialize(where, async locked => {
    const config = structuredClone(await shownConfig(locked));
    change(config);
    return storeConfig(locked, config);
  });
}

/** RFC 7396 merge patch; validation applies to the resulting config. */
export function patchConfig(where: Where, patch: unknown): Promise<Partial<CoderConfig>> {
  return serialize(where, async locked =>
    storeConfig(locked, mergePatch(await shownConfig(locked), patch)),
  );
}

export async function body<T>(req: Request): Promise<T> {
  const value = (await req.json().catch(() => undefined)) as T | undefined;
  if (!value || typeof value !== 'object') throw new ConfigError('A JSON body is required');
  return value;
}

/** A model write, answered with the config and where its chain now runs. */
export async function change(
  ctx: ServerContext,
  apply: (config: Partial<CoderConfig>) => void,
): Promise<Response> {
  return updateConfig(ctx, apply)
    .then(config => withRunsOn(ctx, config))
    .then(json)
    .catch(taskError);
}

const withRunsOn = async (ctx: ServerContext, config: Partial<CoderConfig>) => ({
  ...config,
  runsOn: await runsOnEach(ctx, config),
});

/** `GET /schema/config.v1.json`: the config file's JSON Schema, which a file's `$schema` names. */
export const configSchemaDocument = () => json(configJsonSchema());

export async function readConfig(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return shownConfig(ctx)
    .then(config => json({ config, effective: effectiveConfig(ctx, config) }))
    .catch(taskError);
}

export async function patchConfiguration(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return req
    .json()
    .catch(() => {
      throw new ConfigError('A JSON body is required');
    })
    .then(async patch => {
      const config = await patchConfig(ctx, patch);
      // The Models tab shows where its chain runs once a save changes it.
      return ['chain', 'reviewModel', 'models'].some(key => key in patch)
        ? withRunsOn(ctx, config)
        : config;
    })
    .then(json)
    .catch(taskError);
}
