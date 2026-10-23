/** Custom endpoint models and aliases: list, probe, add, update, remove, alias, enable and disable. */
import process from 'node:process';
import path from 'node:path';

import { getCodexAvailability } from './engines/codex';
import {
  BUILTIN_MODELS,
  EFFORTS,
  aliasTarget,
  endpointCandidates,
  isAliasModel,
  isBuiltinAlias,
  isEndpointModel,
  loadConfig,
  normalizeBaseUrl,
  parseEngineSpec,
  splitEngineSpec,
  removeModel,
  toggleModel,
  configTargetFile,
} from './config';
import { CoderError } from './dispatch';
import { ensureCodexInstalled } from './hosts';
import type { CoderConfig, CustomModelConfig, ModelEntry } from './types';
import type { ProbeResult } from '../client/types';
import { writeConfigFile } from './config';
import { connect, type ServerOptions } from './remote';

const RESERVED = new Set(['codex', 'claude', 'custom']);

/**
 * Probe an OpenAI-compatible endpoint: GET <baseUrl>/models, bearer-authed
 * with `key`, else the entry's env key when set. Reachability is the signal;
 * model listing is best-effort (some gateways don't implement /models).
 */
export async function probeEndpoint(
  entry: { baseUrl: string; model?: string; envKey?: string },
  options: { key?: string; fetch?: typeof fetch } = {},
): Promise<ProbeResult> {
  const key = 'key' in options ? options.key : entry.envKey ? process.env[entry.envKey] : undefined;
  const request = options.fetch ?? fetch;
  // A bare host may serve the API under /v1; a 404 falls through to the next
  // candidate, and only an all-candidates 404 counts as "no /models route".
  const urls = endpointCandidates(entry.baseUrl, 'models');
  let lastFailure: ProbeResult | null = null;
  for (const url of urls) {
    try {
      const response = await request(url, {
        headers: key ? { Authorization: `Bearer ${key}` } : {},
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        // No /models route is fine (not every gateway implements it); any other
        // failure (401/403/5xx) means the endpoint itself needs attention.
        lastFailure =
          response.status === 404
            ? {
                reachable: true,
                modelListed: null,
                models: null,
                detail: 'endpoint reachable (no model list to verify against)',
              }
            : {
                reachable: false,
                modelListed: null,
                models: null,
                detail: `${url} -> HTTP ${response.status}`,
              };
        continue;
      }
      const body = (await response.json().catch(() => null)) as { data?: ListedModel[] } | null;
      const ids = Array.isArray(body?.data)
        ? body.data.map(m => m.id).filter((id): id is string => typeof id === 'string')
        : null;
      if (!ids) {
        return { reachable: true, modelListed: null, models: null, detail: 'endpoint reachable' };
      }

      const listedWindows = Object.fromEntries(
        body!.data!.flatMap(m => {
          const tokens = tokenCount(m.context_window ?? m.context_length ?? m.max_model_len);
          return typeof m.id === 'string' && tokens ? [[m.id, tokens]] : [];
        }),
      );
      const windows = Object.keys(listedWindows).length
        ? listedWindows
        : await showContextWindows(entry.baseUrl, entry.model ? [entry.model] : ids, key, request);
      const contextWindows = Object.keys(windows).length ? { contextWindows: windows } : {};
      if (!entry.model) {
        return {
          reachable: true,
          modelListed: null,
          models: ids,
          ...contextWindows,
          detail: `endpoint reachable; ${ids.length} models listed`,
        };
      }
      const listed = ids.includes(entry.model);
      return {
        reachable: true,
        modelListed: listed,
        models: ids,
        ...contextWindows,
        detail: listed
          ? `endpoint reachable; model "${entry.model}" listed`
          : `endpoint reachable, but "${entry.model}" is not in its model list`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastFailure = {
        reachable: false,
        modelListed: null,
        models: null,
        detail: `${url} unreachable (${message})`,
      };
    }
  }
  return lastFailure!;
}

/** A `/models` row; the window field differs by provider (AI Gateway, OpenRouter, vLLM). */
interface ListedModel {
  id?: string;
  context_window?: unknown;
  context_length?: unknown;
  max_model_len?: unknown;
}

const tokenCount = (value: unknown) =>
  Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;

/** Ollama lists no windows; its native `/api/show` reports each model's. Stops when the first model gets none. */
async function showContextWindows(
  baseUrl: string,
  ids: string[],
  key: string | undefined,
  request: typeof fetch,
): Promise<Record<string, number>> {
  const url = `${normalizeBaseUrl(baseUrl).replace(/\/v1$/, '')}/api/show`;
  const show = async (model: string) => {
    const response = await request(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    const body = response?.ok
      ? ((await response.json().catch(() => null)) as {
          model_info?: Record<string, unknown>;
        } | null)
      : null;
    const info = body?.model_info ?? {};
    const field = Object.keys(info).find(name => name.endsWith('.context_length'));
    return field ? tokenCount(info[field]) : undefined;
  };

  const [first, ...rest] = ids;
  const firstWindow = first ? await show(first) : undefined;
  if (!firstWindow) return {};

  const windows = await Promise.all(rest.map(async id => [id, await show(id)] as const));
  return Object.fromEntries(
    [[first!, firstWindow] as const, ...windows].filter((pair): pair is readonly [string, number] =>
      Boolean(pair[1]),
    ),
  );
}

function writeModels(targetFile: string, mutate: (models: Record<string, ModelEntry>) => void) {
  writeConfigFile(targetFile, current => {
    current.models = current.models ?? {};
    mutate(current.models);
  });
}

/** One engine's built-in aliases, as name -> the model id each runs. */
const builtinIds = (engine: string, builtin: Record<string, string> = BUILTIN_MODELS) =>
  Object.fromEntries(
    Object.entries(builtin).flatMap(([name, spec]) => {
      const [own, model] = spec.split('/');
      return own === engine && model ? [[name, model]] : [];
    }),
  );

// Compute the model-list rows shared by the text and JSON views (and the SDK):
// the per-provider rows, the custom endpoints, and any names turned off.
function buildModelRows(config: CoderConfig) {
  const models = config.models ?? {};
  const endpoints = Object.entries(models).filter((pair): pair is [string, CustomModelConfig] =>
    isEndpointModel(pair[1]),
  );
  const aliasDetails = Object.entries(models)
    .filter((pair): pair is [string, string] => isAliasModel(pair[1]))
    .map(([name, entry]) => {
      // An alias replaces a built-in row when it reuses its name (shadowing)
      // or resolves to the same concrete model id.
      const target = aliasTarget(entry, config);
      const builtins = builtinIds(target.engine);
      const concrete = (target.model && builtins[target.model]) ?? target.model;
      const specOf = () =>
        [target.engine, target.model, target.effort].filter(Boolean).join('/');
      const replaces = isBuiltinAlias(name)
        ? name
        : Object.entries(builtins).find(([, id]) => id === concrete)?.[0];
      return { name, spec: specOf(), replaces, disabled: false };
    });
  // A name-shadowing alias always claims the built-in row (it shadows
  // resolution); a same-model alias only claims it when nothing shadows.
  const overriding = new Map<string, { name: string; spec: string; disabled: boolean }>();
  for (const alias of aliasDetails) {
    if (
      alias.replaces &&
      (alias.name === alias.replaces || !overriding.has(alias.replaces)) &&
      overriding.get(alias.replaces)?.name !== alias.replaces
    ) {
      overriding.set(alias.replaces, alias);
    }
  }
  const disabled = (name: string) => models[name] === false;
  const standaloneAliases = aliasDetails.filter(
    alias => ![...overriding.values()].some(item => item.name === alias.name),
  );
  // Built-ins and user aliases are the same thing (a name -> engine spec),
  // built-ins just ship pre-seeded; list them together per provider, with
  // overriding aliases shown in place of the row they shadow.
  const providerRows = (provider: 'codex' | 'claude', map: Record<string, string>) => [
    ...Object.entries(map).map(([alias, model]) => {
      const override = overriding.get(alias);
      return override
        ? {
            alias: override.name,
            spec: override.spec,
            overrides: alias,
            disabled: override.disabled,
          }
        : { alias, model, builtin: true, disabled: disabled(alias) };
    }),
    ...standaloneAliases
      .filter(alias => alias.spec.startsWith(`${provider}/`))
      .map(({ name, spec, disabled }) => ({ alias: name, spec, disabled })),
  ];
  // Names turned off that are no built-in (raw engine slugs, entries from another
  // config layer) have no section of their own; surface them so a disabled
  // slug is never invisible.
  const toggledSlugs = Object.entries(models)
    .filter(([name, entry]) => entry === false && !isBuiltinAlias(name))
    .map(([name]) => ({ name, disabled: true }));
  return { models, endpoints, providerRows, toggledSlugs, disabled };
}

// Print-free core: the full model inventory, this machine's custom endpoints probed, or a server's as it lists them.
async function modelListData(cwd: string, server?: ServerOptions) {
  const listed = server ? await connect(server).models.list() : undefined;
  const { endpoints, providerRows, toggledSlugs } = buildModelRows(
    listed ? ({ models: listed.models } as CoderConfig) : loadConfig(cwd),
  );
  const probed = await Promise.all(
    endpoints.map(async ([alias, entry]) => ({
      name: alias,
      ...entry,
      ...(listed ? {} : { probe: await probeEndpoint(entry) }),
    })),
  );
  return {
    codex: providerRows('codex', builtinIds('codex', listed?.builtin)),
    claude: providerRows('claude', builtinIds('claude', listed?.builtin)),
    custom: probed,
    ...(toggledSlugs.length ? { toggles: toggledSlugs } : {}),
  };
}

export interface PersistedModel {
  name: string;
  entry: CustomModelConfig;
  file: string;
  probe: ProbeResult;
  codex: ReturnType<typeof getCodexAvailability>;
  install: ReturnType<typeof ensureCodexInstalled>;
  nativeResponses: boolean;
  keyMissing: boolean;
  ready: boolean;
}

// Print-free core shared by add/update and the SDK: detect the wire protocol,
// persist the entry, probe the endpoint, ensure the codex engine, report state.
async function persistModel(
  name: string,
  entry: CustomModelConfig,
  targetFile: string,
  cwd: string,
): Promise<PersistedModel> {
  // Wire protocol is detected, not asked: native Responses endpoints get
  // codex directly, chat-completions endpoints go through the bridge. A
  // definitive answer is written explicitly (so runtime never re-probes); when
  // nothing answered, the field stays unset and runtime detects on first use.
  const detected = await detectWireApi(entry);
  const nativeResponses = detected?.wireApi === 'responses';
  if (detected) {
    entry.wireApi = detected.wireApi;
    entry.baseUrl = detected.baseUrl ?? entry.baseUrl;
  } else {
    delete entry.wireApi;
  }

  const probe = await probeEndpoint(entry);
  const reported = probe.contextWindows?.[entry.model];
  if (!entry.contextWindow && reported) entry.contextWindow = reported;

  writeModels(targetFile, models => {
    models[name] = entry;
  });

  // Custom models run on the codex engine; install it on the spot if missing
  // (no codex login is needed for third-party endpoints).
  const install = ensureCodexInstalled(getCodexAvailability(cwd));
  const codex = getCodexAvailability(cwd);
  const keyMissing = Boolean(entry.envKey && !process.env[entry.envKey]);
  return {
    name,
    entry,
    file: targetFile,
    probe,
    codex,
    install,
    nativeResponses,
    keyMissing,
    ready: probe.reachable && codex.available,
  };
}

const ADD_USAGE =
  'Usage: coder model add <name> --base-url <url> --model <id> [--env-key VAR] [--context-window <tokens>]';
const UPDATE_USAGE =
  'Usage: coder model update <name> [--base-url <url>] [--model <id>] [--env-key VAR] [--context-window <tokens>]';
const ALIAS_USAGE =
  'Usage: coder model alias <name> <spec>   (e.g. coder model alias fast codex/luna)';
const LIST_HINT = 'List them: coder model list';

function checkModelName(
  name: string | undefined,
  kind: 'model' | 'alias',
  usage: string,
): asserts name is string {
  if (!name) throw new CoderError('invalid-option', 'Missing model name.', { hint: usage });
  if (!/^[a-z][a-z0-9-]*$/.test(name))
    throw new CoderError(
      'invalid-option',
      `Invalid model name "${name}". Use lowercase kebab-case (e.g. qwen-local).`,
    );
  if (EFFORTS.has(name) || (kind === 'model' && (RESERVED.has(name) || isBuiltinAlias(name))))
    throw new CoderError('invalid-option', `"${name}" is reserved; pick another name.`);
}

export interface ModelWriteOptions {
  baseUrl?: string;
  model?: string;
  envKey?: string;
  contextWindow?: number;
  workspace?: boolean;
}

// Print-free core: add a custom (OpenAI-compatible) endpoint model.
async function modelAddCore(
  cwd: string,
  name: string | undefined,
  opts: ModelWriteOptions,
): Promise<PersistedModel> {
  checkModelName(name, 'model', ADD_USAGE);
  const existing = loadConfig(cwd).models?.[name];
  if (existing) {
    throw new CoderError(
      'invalid-option',
      isEndpointModel(existing)
        ? `Custom model "${name}" already exists.`
        : `"${name}" is already configured as an ${isAliasModel(existing) ? 'alias' : 'entry'}; remove it first.`,
      {
        hint: `Change it: coder model update ${name} [--base-url|--model|--env-key], or remove it first.`,
      },
    );
  }
  if (!opts.baseUrl || !opts.model)
    throw new CoderError('invalid-option', 'Missing --base-url or --model.', { hint: ADD_USAGE });
  const entry: CustomModelConfig = {
    baseUrl: normalizeBaseUrl(opts.baseUrl),
    model: opts.model,
    ...(opts.envKey ? { envKey: opts.envKey } : {}),
    ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
  };
  return persistModel(name, entry, configTargetFile(cwd, opts.workspace), cwd);
}

// Print-free core: update an existing custom endpoint model.
async function modelUpdateCore(
  cwd: string,
  name: string | undefined,
  opts: ModelWriteOptions,
): Promise<PersistedModel> {
  const found = name ? loadConfig(cwd).models?.[name] : undefined;
  const existing = found && isEndpointModel(found) ? found : undefined;
  if (!name || !existing) {
    throw new CoderError(
      'invalid-option',
      name ? `No custom model named "${name}".` : 'Missing model name.',
      {
        hint: name ? LIST_HINT : UPDATE_USAGE,
      },
    );
  }
  if (!opts.baseUrl && !opts.model && !opts.envKey && !opts.contextWindow)
    throw new CoderError(
      'invalid-option',
      'Nothing to update: pass --base-url, --model, --env-key, or --context-window.',
      {
        hint: UPDATE_USAGE,
      },
    );
  const entry: CustomModelConfig = {
    ...existing,
    ...(opts.baseUrl ? { baseUrl: normalizeBaseUrl(opts.baseUrl) } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.envKey ? { envKey: opts.envKey } : {}),
  };
  // Another model or endpoint has its own window; refill it unless one is given.
  if (opts.contextWindow) entry.contextWindow = opts.contextWindow;
  else if (entry.model !== existing.model || entry.baseUrl !== existing.baseUrl)
    delete entry.contextWindow;
  return persistModel(name, entry, configTargetFile(cwd, opts.workspace), cwd);
}

// Print-free core: remove a configured model entry.
function modelRemoveCore(
  cwd: string,
  name: string | undefined,
  opts: { workspace?: boolean } = {},
): { removed: string; file: string } {
  if (!name || !loadConfig(cwd).models?.[name]) {
    throw new CoderError(
      'invalid-option',
      name ? `No custom model named "${name}".` : 'Missing model name.',
      {
        hint: name ? LIST_HINT : 'Usage: coder model remove <name>',
      },
    );
  }
  const targetFile = configTargetFile(cwd, opts.workspace);
  writeConfigFile(targetFile, current => removeModel(current, name));
  return { removed: name, file: targetFile };
}

// Print-free core: alias a name to a codex/claude model spec.
function modelAliasCore(
  cwd: string,
  name: string | undefined,
  spec: string | undefined,
  opts: { workspace?: boolean } = {},
): { alias: string; model: string; file: string } {
  checkModelName(name, 'alias', ALIAS_USAGE);
  const config = loadConfig(cwd);
  const existing = config.models?.[name];
  if (existing && isEndpointModel(existing))
    throw new CoderError(
      'invalid-option',
      `"${name}" is a custom model name; pick another alias name.`,
    );
  if (!spec) throw new CoderError('invalid-option', 'Missing alias spec.', { hint: ALIAS_USAGE });

  // Validate the spec resolves now (throws on disabled/unknown parts too).
  let parsed: ReturnType<typeof parseEngineSpec>;
  try {
    parsed = parseEngineSpec(spec, config);
  } catch (error) {
    throw new CoderError('invalid-option', error instanceof Error ? error.message : String(error), {
      hint: ALIAS_USAGE,
    });
  }
  if (!parsed || !parsed.model)
    throw new CoderError('invalid-option', `Alias spec "${spec}" does not resolve to a model.`, {
      hint: ALIAS_USAGE,
    });
  // An engine's own alias is what its bare name runs, so it stays on that engine.
  if (RESERVED.has(name) && parsed.engine !== name)
    throw new CoderError('invalid-option', `The ${name} alias names a ${name} model.`, {
      hint: ALIAS_USAGE,
    });
  if (parsed.engine === 'custom' && name !== 'custom') {
    throw new CoderError(
      'invalid-option',
      `"${spec}" names a custom model, which is already dispatchable by name; aliases target codex/claude models.`,
    );
  }
  // The spec as typed, with its engine; effort only when it named one.
  const typed = splitEngineSpec(spec);
  const entry = [parsed.engine, typed.model ?? parsed.model, typed.effort].filter(Boolean).join('/');
  const targetFile = configTargetFile(cwd, opts.workspace);
  writeModels(targetFile, models => {
    models[name] = entry;
  });
  return { alias: name, model: entry, file: targetFile };
}

// Print-free core: remove an alias entry.
function modelUnaliasCore(
  cwd: string,
  name: string | undefined,
  opts: { workspace?: boolean } = {},
): { unaliased: string; file: string } {
  const entry = name ? loadConfig(cwd).models?.[name] : undefined;
  if (!name || !entry || !isAliasModel(entry)) {
    throw new CoderError(
      'invalid-option',
      name ? `No alias named "${name}".` : 'Missing alias name.',
      {
        hint: name ? LIST_HINT : 'Usage: coder model unalias <name>',
      },
    );
  }
  const targetFile = configTargetFile(cwd, opts.workspace);
  writeConfigFile(targetFile, current => removeModel(current, name));
  return { unaliased: name, file: targetFile };
}

// Print-free core shared by disable/enable: flip a model's `disabled` flag.
function modelToggleCore(
  cwd: string,
  name: string | undefined,
  disable: boolean,
  opts: { workspace?: boolean } = {},
): { name: string; disabled: boolean; file: string } {
  if (!name)
    throw new CoderError('invalid-option', 'Missing model name.', {
      hint: `Usage: coder model ${disable ? 'disable' : 'enable'} <name>`,
    });
  const targetFile = configTargetFile(cwd, opts.workspace);
  writeModels(targetFile, models => toggleModel(models, name, disable));
  return { name, disabled: disable, file: targetFile };
}

/** Where a model write lands: this machine's config under `cwd`, or the workspace's on `server`. */
type ModelServer = { cwd?: string; server?: ServerOptions['server'] };

export const models = {
  /** Register a custom OpenAI-compatible endpoint model. */
  add: (name: string, opts: ModelWriteOptions & { cwd?: string }) =>
    modelAddCore(path.resolve(opts.cwd ?? '.'), name, opts),
  /** Update fields of a configured model entry; with `server`, the workspace's there. */
  update: (name: string, opts: ModelWriteOptions & ModelServer) =>
    opts.server === undefined
      ? modelUpdateCore(path.resolve(opts.cwd ?? '.'), name, opts)
      : connect({ server: opts.server }).models.update(name, {
          ...(opts.baseUrl ? { baseUrl: opts.baseUrl } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.envKey ? { envKey: opts.envKey } : {}),
          ...(opts.contextWindow ? { contextWindow: opts.contextWindow } : {}),
        }),
  /** Remove a configured model entry. */
  remove: (name: string, opts: { workspace?: boolean; cwd?: string } = {}) =>
    modelRemoveCore(path.resolve(opts.cwd ?? '.'), name, opts),
  /** Every dispatchable model: built-ins, aliases, custom endpoints; with `server`, the workspace's there. */
  list: ({
    cwd,
    workspace,
    ...server
  }: { cwd?: string; workspace?: string } & ServerOptions = {}) =>
    modelListData(
      path.resolve(cwd ?? '.'),
      server.server === undefined
        ? undefined
        : { ...server, organization: server.organization ?? workspace },
    ),
  /** Alias a name to an engine spec, e.g. alias('fast', 'codex/luna'). */
  alias: (name: string, spec: string, opts: { workspace?: boolean } & ModelServer = {}) =>
    opts.server === undefined
      ? modelAliasCore(path.resolve(opts.cwd ?? '.'), name, spec, opts)
      : connect({ server: opts.server }).models.alias(name, spec),
  /** Remove a user-defined alias. */
  unalias: (name: string, opts: { workspace?: boolean; cwd?: string } = {}) =>
    modelUnaliasCore(path.resolve(opts.cwd ?? '.'), name, opts),
  /** Disable a model name (built-in, alias, or raw slug) without removing it. */
  disable: (name: string, opts: { workspace?: boolean } & ModelServer = {}) =>
    opts.server === undefined
      ? modelToggleCore(path.resolve(opts.cwd ?? '.'), name, true, opts)
      : connect({ server: opts.server }).models.disable(name),
  /** Re-enable a disabled model name. */
  enable: (name: string, opts: { workspace?: boolean } & ModelServer = {}) =>
    opts.server === undefined
      ? modelToggleCore(path.resolve(opts.cwd ?? '.'), name, false, opts)
      : connect({ server: opts.server }).models.enable(name),
};

/** Wire-protocol detection for custom models: POST /responses at each candidate base; auth or validation errors still prove the route exists. */
type WireDetection =
  // The route was found at baseUrl (e.g. with /v1 appended): responses means
  // codex hits `<baseUrl>/responses` directly, chat means the bridge fronts
  // `<baseUrl>/chat/completions`. Persisting both fields pins the endpoint so
  // later turns do no guessing.
  | { wireApi: 'responses' | 'chat'; baseUrl: string }
  // Reachable, but neither route proven (or nothing answered when reachable is
  // false when the endpoint is down or has no network. Do not persist a baseUrl.
  | { wireApi: 'chat'; baseUrl?: undefined }
  | null;

// Does POSTing `route` at some candidate base prove the route exists?
// (404/405/501 means no such route. Any other response, including auth or
// validation errors, proves it.) Returns the base it was found at.
async function probeRoute(
  entry: CustomModelConfig,
  route: string,
  body: Record<string, unknown>,
): Promise<{ baseUrl: string } | { reachable: boolean }> {
  const key = entry.envKey ? process.env[entry.envKey] : undefined;
  let reachable = false;
  for (const url of endpointCandidates(entry.baseUrl, route)) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      reachable = true;
      if (response.status !== 404 && response.status !== 405 && response.status !== 501) {
        return { baseUrl: url.slice(0, -(route.length + 1)) };
      }
    } catch {
      // unreachable candidate; keep trying the rest
    }
  }
  return { reachable };
}

export async function detectWireApi(entry: CustomModelConfig): Promise<WireDetection> {
  const responses = await probeRoute(entry, 'responses', {
    model: entry.model,
    input: [],
    stream: false,
  });
  if ('baseUrl' in responses) {
    return { wireApi: 'responses', baseUrl: responses.baseUrl };
  }
  const chat = await probeRoute(entry, 'chat/completions', {
    model: entry.model,
    messages: [],
    stream: false,
  });
  if ('baseUrl' in chat) {
    return { wireApi: 'chat', baseUrl: chat.baseUrl };
  }
  return responses.reachable || chat.reachable ? { wireApi: 'chat' } : null;
}
