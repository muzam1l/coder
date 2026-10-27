import { sha256 } from '../../utils/crypto';
import { type ProbeResult } from '../../client/types';
import { type Params } from '../routes/match';
import { type ServerContext } from '../context';
import {
  BUILTIN_MODELS,
  isAliasModel,
  isBuiltinAlias,
  isEndpointModel,
  parseEngineSpec,
  splitEngineSpec,
  removeModel,
  toggleModel,
  withDefaults,
  type CoderConfig,
  type CustomModelConfig,
  type ModelEntry,
} from '../../core/config';
import { probeEndpoint } from '../../core/models';
import { credentialEnv, runsOnEach } from './credentials';
import { ConfigError, shownConfig, body, change } from './config';
import { json } from '../routes/http';
import { workspaceAdmin } from '../routes/guards';
import { publicFetch } from '../outbound';

const MODEL_NAME = /^[a-z0-9][a-z0-9-]*$/;

const PROVIDER_HOSTS = new Set([
  'openrouter.ai',
  'ai-gateway.vercel.sh',
  'api.groq.com',
  'api.together.xyz',
]);

export function modelList(config: Partial<CoderConfig>) {
  return {
    builtin: BUILTIN_MODELS,
    models: config.models ?? {},
  };
}

/** One in-memory cache per server for answers fetched from outside: a TTL, a size cap and one request per key in flight. */
export class MemoryCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly pending = new Map<string, Promise<T | undefined>>();

  constructor(
    private readonly options: {
      ttlMs: number;
      max: number;
      now?: () => number;
      accept?: (value: T) => boolean;
    },
  ) {}

  /** The fresh value, else one fetch shared by concurrent callers; a failed refresh falls back to the expired value. */
  async get(key: string, fetch: () => Promise<T | undefined>): Promise<T | undefined> {
    const now = this.options.now ?? Date.now;
    const at = now();
    const cached = this.entries.get(key);
    if (cached && at - cached.at < this.options.ttlMs) return cached.value;

    let refresh = this.pending.get(key);
    if (!refresh) {
      refresh = Promise.resolve()
        .then(fetch)
        .then(value => {
          if (value === undefined) return cached?.value;
          if (this.options.accept && !this.options.accept(value)) return cached?.value ?? value;
          this.entries.set(key, { value, at: now() });
          const oldest = this.entries.keys().next().value;
          if (this.entries.size > this.options.max && oldest !== undefined)
            this.entries.delete(oldest);
          return value;
        })
        .catch(error => {
          console.error(`coder server: model probe failed for ${key}`, error);
          return cached?.value;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }

    return refresh;
  }
}

export async function probe(req: Request, ctx: ServerContext): Promise<Response> {
  const { baseUrl, envKey, key } = await body<{ baseUrl?: string; envKey?: string; key?: string }>(
    req,
  );
  if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !URL.canParse(baseUrl))
    return json({ error: 'An http or https base URL is required' }, 400);

  // A saved key only goes, for an admin, to a preset host or one a custom model already sends that key to.
  const saved =
    !key && envKey && workspaceAdmin(ctx) && (await knownHost(ctx, baseUrl, envKey))
      ? await credentialEnv(ctx, envKey)
      : undefined;
  const resolved = key || saved;
  const settings = (ctx.settings ??= {});
  const cache = (settings.probes ??= new MemoryCache<ProbeResult>({
    ttlMs: 600_000,
    max: 100,
    now: ctx.now,
    accept: value => value.reachable,
  }));
  const cacheKey = `${new URL(baseUrl).host}|${envKey ?? ''}|${sha256(String(resolved ?? ''))}`;

  return json(
    await cache.get(cacheKey, () =>
      probeEndpoint({ baseUrl }, { key: resolved, fetch: publicFetch(ctx) }),
    ),
  );
}

async function knownHost(ctx: ServerContext, baseUrl: string, envKey: string): Promise<boolean> {
  const host = new URL(baseUrl).host;
  if (PROVIDER_HOSTS.has(host)) return true;

  const models = (await shownConfig(ctx)).models ?? {};
  return Object.values(models).some(
    entry =>
      isEndpointModel(entry) && entry.envKey === envKey && new URL(entry.baseUrl).host === host,
  );
}

export async function listModels(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const shown = await shownConfig(ctx);

  return json({ ...modelList(shown), runsOn: await runsOnEach(ctx, shown) });
}

export async function createModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const input = await body<
    {
      name?: string;
    } & Record<string, unknown>
  >(req);
  const { name: added = '', ...entry } = input;
  if (!MODEL_NAME.test(added) || isBuiltinAlias(added))
    return json({ error: `Invalid model name "${added}"` }, 400);

  return change(ctx, config => {
    if (config.models?.[added]) throw new ConfigError(`"${added}" already exists`);
    config.models = { ...config.models, [added]: entry as ModelEntry };
  });
}

export async function deleteModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const name = params.name!;

  return change(ctx, config => {
    if (!config.models?.[name]) throw new ConfigError(`No model "${name}"`);
    removeModel(config, name);
  });
}

export async function updateModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const fields = await body<Partial<CustomModelConfig>>(req);

  return change(ctx, config => updateEntry(config, params.name!, fields));
}

/** Changes fields of a custom endpoint model. */
export function updateEntry(
  config: Partial<CoderConfig>,
  name: string,
  fields: Partial<CustomModelConfig>,
) {
  const existing = config.models?.[name];
  if (!existing || !isEndpointModel(existing)) throw new ConfigError(`No custom model "${name}"`);
  config.models = { ...config.models, [name]: { ...existing, ...fields } };
}

export async function aliasModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const { spec } = await body<{
    spec?: string;
  }>(req);

  return change(ctx, config => aliasEntry(config, params.name!, spec));
}

/** Names an engine spec, such as `fast` for `codex/luna`; an engine's own name sets what its bare name runs, `custom` an endpoint. */
export function aliasEntry(config: Partial<CoderConfig>, name: string, spec: string | undefined) {
  if (!MODEL_NAME.test(name)) throw new ConfigError(`Invalid alias name "${name}"`);

  const existing = config.models?.[name];
  if (existing && isEndpointModel(existing))
    throw new ConfigError(`"${name}" is a custom model name`);

  const parsed = parseEngineSpec(spec, withDefaults(config));
  const engine = name === 'codex' || name === 'claude' || name === 'custom' ? name : undefined;
  if (engine && parsed?.engine !== engine)
    throw new ConfigError(`The ${engine} alias names a ${engine} model`);
  if (!parsed?.model || (parsed.engine === 'custom' && engine !== 'custom'))
    throw new ConfigError(`"${spec}" does not name a codex or claude model`);

  const typed = splitEngineSpec(spec!);
  config.models = {
    ...config.models,
    [name]: [parsed.engine, typed.model ?? parsed.model, typed.effort].filter(Boolean).join('/'),
  };
}

export async function disableModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return change(ctx, config => toggleEntry(config, params.name!, true));
}

export async function enableModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return change(ctx, config => toggleEntry(config, params.name!, false));
}

/** Turns a built-in or custom model off or back on. */
export function toggleEntry(config: Partial<CoderConfig>, name: string, disabled: boolean) {
  try {
    toggleModel((config.models ??= {}), name, disabled);
  } catch (error) {
    throw new ConfigError((error as Error).message);
  }
}
