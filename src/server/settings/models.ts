import { sha256 } from '../../utils/crypto';
import { type ProbeResult } from '../../client/types';
import { MemoryCache } from '../context/cache';
import { type Params } from '../routes/match';
import { type ServerContext } from '../context';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  CODEX_MODELS,
  isAliasModel,
  isBuiltinAlias,
  isEndpointModel,
  parseEngineSpec,
  removeModel,
  withDefaults,
  type CoderConfig,
  type ModelEntry,
} from '../../core/config';
import { probeEndpoint } from '../../core/models';
import { credentialEnv } from './credentials';
import { ConfigError, shownConfig, body, change } from './config';
import { json } from '../routes/http';

const MODEL_NAME = /^[a-z0-9][a-z0-9-]*$/;

const PROVIDER_HOSTS = new Set([
  'openrouter.ai',
  'ai-gateway.vercel.sh',
  'api.groq.com',
  'api.together.xyz',
]);

function modelList(config: Partial<CoderConfig>) {
  return {
    builtin: { codex: CODEX_MODELS, claude: CLAUDE_MODELS },
    models: config.models ?? {},
  };
}

export async function probe(req: Request, ctx: ServerContext): Promise<Response> {
  const { baseUrl, envKey, key } = await body<{ baseUrl?: string; envKey?: string; key?: string }>(
    req,
  );
  if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !URL.canParse(baseUrl))
    return json({ error: 'An http or https base URL is required' }, 400);

  // A saved key only goes to a preset host or one a custom model already sends that key to.
  const saved =
    !key && envKey && (await knownHost(ctx, baseUrl, envKey))
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
      probeEndpoint({ baseUrl }, { key: resolved, fetch: ctx.fetch }),
    ),
  );
}

async function knownHost(ctx: ServerContext, baseUrl: string, envKey: string): Promise<boolean> {
  const host = new URL(baseUrl).host;
  if (PROVIDER_HOSTS.has(host)) return true;

  const models = (await shownConfig(ctx)).models ?? {};
  return Object.values(models).some(
    entry => 'baseUrl' in entry && entry.envKey === envKey && new URL(entry.baseUrl).host === host,
  );
}

export async function listModels(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return json(modelList(await shownConfig(ctx)));
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

export async function aliasModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const name = params.name!;

  const { spec } = await body<{
    spec?: string;
  }>(req);

  return change(ctx, config => {
    if (!MODEL_NAME.test(name)) throw new ConfigError(`Invalid alias name "${name}"`);

    const existing = config.models?.[name];
    if (existing && isEndpointModel(existing))
      throw new ConfigError(`"${name}" is a custom model name`);

    const parsed = parseEngineSpec(spec, withDefaults(config));
    if (!parsed?.model || parsed.engine === 'custom')
      throw new ConfigError(`"${spec}" does not name a codex or claude model`);

    const builtins = parsed.engine === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
    const effort = spec!
      .split(':')
      .some(part => CODEX_EFFORTS.has(part) || CLAUDE_EFFORTS.has(part));
    config.models = {
      ...config.models,
      [name]: {
        provider: parsed.engine,
        model: builtins[parsed.model] ?? parsed.model,
        ...(effort && parsed.effort ? { effort: parsed.effort } : {}),
      },
    };
  });
}

export async function disableModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const name = params.name!;

  return change(ctx, config => {
    const models = (config.models ??= {});
    const entry = models[name];
    if (entry && (isEndpointModel(entry) || isAliasModel(entry))) entry.disabled = true;
    else models[name] = { disabled: true };
  });
}

export async function enableModel(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const name = params.name!;

  return change(ctx, config => {
    const models = (config.models ??= {});
    const entry = models[name];
    if (entry && (isEndpointModel(entry) || isAliasModel(entry))) delete entry.disabled;
    else delete models[name];
  });
}
