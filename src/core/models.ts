/** Custom endpoint models and aliases: list, probe, add, update, remove, alias, enable and disable. */
import process from 'node:process';

import { getCodexAvailability } from './engines/codex';
import {
  CLAUDE_EFFORTS,
  CLAUDE_MODELS,
  CODEX_EFFORTS,
  CODEX_MODELS,
  endpointCandidates,
  isAliasModel,
  isBuiltinAlias,
  isEndpointModel,
  loadConfig,
  normalizeBaseUrl,
  parseEngineSpec,
  removeModel,
  resolveUserConfigFile,
  resolveWorkspaceConfigFile,
} from './config';
import { CoderError } from './dispatch';
import { ensureCodexInstalled } from './hosts';
import { detectWireApi } from './engines/codex/wire';
import { resolveWorkspaceRoot } from './state';
import type { AliasModelConfig, CoderConfig, CustomModelConfig, ModelEntry } from './types';
import type { ProbeResult } from '../client/types';
import { writeConfigFile } from './config';

export const RESERVED = new Set(['codex', 'claude', 'custom']);

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
      const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = Array.isArray(body?.data)
        ? body.data.map(m => m.id).filter((id): id is string => typeof id === 'string')
        : null;
      if (!ids) {
        return { reachable: true, modelListed: null, models: null, detail: 'endpoint reachable' };
      }
      if (!entry.model) {
        return {
          reachable: true,
          modelListed: null,
          models: ids,
          detail: `endpoint reachable; ${ids.length} models listed`,
        };
      }
      const listed = ids.includes(entry.model);
      return {
        reachable: true,
        modelListed: listed,
        models: ids,
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

function writeModels(targetFile: string, mutate: (models: Record<string, ModelEntry>) => void) {
  writeConfigFile(targetFile, current => {
    current.models = current.models ?? {};
    mutate(current.models);
  });
}

export function resolveTargetFile(options: Record<string, any>, cwd: string): string {
  return options.workspace
    ? resolveWorkspaceConfigFile(resolveWorkspaceRoot(cwd))
    : resolveUserConfigFile();
}

// Compute the model-list rows shared by the text and JSON views (and the SDK):
// the per-provider rows, the custom endpoints, and any bare toggles.
export function buildModelRows(config: CoderConfig) {
  const models = config.models ?? {};
  const endpoints = Object.entries(models).filter((pair): pair is [string, CustomModelConfig] =>
    isEndpointModel(pair[1]),
  );
  const specOf = (entry: AliasModelConfig) =>
    `${entry.provider}:${entry.model}${entry.effort ? `:${entry.effort}` : ''}`;
  const aliasDetails = Object.entries(models)
    .filter((pair): pair is [string, AliasModelConfig] => isAliasModel(pair[1]))
    .map(([name, entry]) => {
      // An alias replaces a built-in row when it reuses its name (shadowing)
      // or resolves to the same concrete model id.
      const builtins = entry.provider === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
      const concrete = builtins[entry.model] ?? entry.model;
      const replaces = isBuiltinAlias(name)
        ? name
        : Object.entries(builtins).find(([, id]) => id === concrete)?.[0];
      return { name, spec: specOf(entry), replaces, disabled: Boolean(entry.disabled) };
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
  const disabled = (name: string) => Boolean(models[name]?.disabled);
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
      .filter(alias => alias.spec.startsWith(`${provider}:`))
      .map(({ name, spec, disabled }) => ({ alias: name, spec, disabled })),
  ];
  // Bare toggles on non-built-in names (raw engine slugs, entries from another
  // config layer) have no section of their own; surface them so a disabled
  // slug is never invisible.
  const toggledSlugs = Object.entries(models)
    .filter(
      ([name, entry]) => !isEndpointModel(entry) && !isAliasModel(entry) && !isBuiltinAlias(name),
    )
    .map(([name, entry]) => ({ name, disabled: Boolean(entry.disabled) }));
  return { models, endpoints, providerRows, toggledSlugs, disabled };
}

// Print-free core: the full model inventory with custom endpoints probed.
export async function modelListData(cwd: string) {
  const { endpoints, providerRows, toggledSlugs } = buildModelRows(loadConfig(cwd));
  const probed = await Promise.all(
    endpoints.map(async ([alias, entry]) => ({
      name: alias,
      ...entry,
      probe: await probeEndpoint(entry),
    })),
  );
  return {
    codex: providerRows('codex', CODEX_MODELS),
    claude: providerRows('claude', CLAUDE_MODELS),
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
export async function persistModel(
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

  writeModels(targetFile, models => {
    models[name] = entry;
  });

  const probe = await probeEndpoint(entry);
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

const ADD_USAGE = 'Usage: coder model add <name> --base-url <url> --model <id> [--env-key VAR]';
const UPDATE_USAGE =
  'Usage: coder model update <name> [--base-url <url>] [--model <id>] [--env-key VAR]';
const ALIAS_USAGE =
  'Usage: coder model alias <name> <spec>   (e.g. coder model alias fast codex:luna)';
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
  if (RESERVED.has(name) || (kind === 'model' && isBuiltinAlias(name)))
    throw new CoderError('invalid-option', `"${name}" is reserved; pick another name.`);
}

export interface ModelWriteOptions {
  baseUrl?: string;
  model?: string;
  envKey?: string;
  workspace?: boolean;
}

// Print-free core: add a custom (OpenAI-compatible) endpoint model.
export async function modelAddCore(
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
  };
  return persistModel(name, entry, resolveTargetFile({ workspace: opts.workspace }, cwd), cwd);
}

// Print-free core: update an existing custom endpoint model.
export async function modelUpdateCore(
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
  if (!opts.baseUrl && !opts.model && !opts.envKey)
    throw new CoderError(
      'invalid-option',
      'Nothing to update: pass --base-url, --model, or --env-key.',
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
  return persistModel(name, entry, resolveTargetFile({ workspace: opts.workspace }, cwd), cwd);
}

// Print-free core: remove a configured model entry.
export function modelRemoveCore(
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
  const targetFile = resolveTargetFile({ workspace: opts.workspace }, cwd);
  writeConfigFile(targetFile, current => removeModel(current, name));
  return { removed: name, file: targetFile };
}

// Print-free core: alias a name to a codex/claude model spec.
export function modelAliasCore(
  cwd: string,
  name: string | undefined,
  spec: string | undefined,
  opts: { workspace?: boolean } = {},
): AliasModelConfig & { alias: string; file: string } {
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
  if (parsed.engine === 'custom') {
    throw new CoderError(
      'invalid-option',
      `"${spec}" names a custom model, which is already dispatchable by name; aliases target codex/claude models.`,
    );
  }
  // Effort is only baked in when the spec named one; engine-default effort stays a dispatch concern.
  const effortGiven = spec
    .split(':')
    .some(part => CODEX_EFFORTS.has(part.trim()) || CLAUDE_EFFORTS.has(part.trim()));
  // Store the concrete model id so the alias never dangles if a built-in name is later shadowed.
  const builtins = parsed.engine === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
  const entry: AliasModelConfig = {
    provider: parsed.engine,
    model: builtins[parsed.model] ?? parsed.model,
    ...(effortGiven && parsed.effort ? { effort: parsed.effort } : {}),
  };
  const targetFile = resolveTargetFile({ workspace: opts.workspace }, cwd);
  writeModels(targetFile, models => {
    models[name] = entry;
  });
  return { alias: name, ...entry, file: targetFile };
}

// Print-free core: remove an alias entry.
export function modelUnaliasCore(
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
  const targetFile = resolveTargetFile({ workspace: opts.workspace }, cwd);
  writeConfigFile(targetFile, current => removeModel(current, name));
  return { unaliased: name, file: targetFile };
}

// Print-free core shared by disable/enable: flip a model's `disabled` flag.
export function modelToggleCore(
  cwd: string,
  name: string | undefined,
  disable: boolean,
  opts: { workspace?: boolean } = {},
): { name: string; disabled: boolean; file: string } {
  if (!name)
    throw new CoderError('invalid-option', 'Missing model name.', {
      hint: `Usage: coder model ${disable ? 'disable' : 'enable'} <name>`,
    });
  const configuredElsewhere = Boolean(loadConfig(cwd).models?.[name]);
  const targetFile = resolveTargetFile({ workspace: opts.workspace }, cwd);
  writeModels(targetFile, models => {
    const entry = models[name];
    if (!entry) {
      // No entry here: a bare toggle; enable only matters when another layer defines it.
      if (disable) {
        models[name] = { disabled: true };
      } else if (configuredElsewhere) {
        models[name] = { disabled: false };
      }
      return;
    }
    if (isEndpointModel(entry) || isAliasModel(entry)) {
      if (disable) {
        entry.disabled = true;
      } else {
        delete entry.disabled;
      }
    } else if (disable) {
      entry.disabled = true;
    } else {
      delete models[name];
    }
  });
  return { name, disabled: disable, file: targetFile };
}
