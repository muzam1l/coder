/**
 * `coder model <sub>`: manage every model coder can dispatch to - built-in
 * aliases, user aliases, and custom (OpenAI-compatible) endpoints, which form
 * the `custom` agent and run on the codex engine pointed at the configured URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs, str } from '../lib/args.js';
import { getCodexAvailability } from '../lib/codex-core.js';
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
  parseAgentSpec,
  resolveUserConfigFile,
  validateConfig,
} from '../lib/config.js';
import { ensureCodexInstalled } from '../lib/plugins.js';
import { detectWireApi } from '../lib/wire.js';
import { resolveWorkspaceRoot } from '../lib/state.js';
import { fail, outStyle, printJson, resolveCwd } from '../lib/ui.js';
import type {
  AliasModelConfig,
  CoderConfig,
  CustomModelConfig,
  ModelEntry,
} from '../lib/types.js';

const RESERVED = new Set(['codex', 'claude', 'custom']);

export interface ProbeResult {
  reachable: boolean;
  modelListed: boolean | null;
  detail: string;
}

/**
 * Probe an OpenAI-compatible endpoint: GET <baseUrl>/models, bearer-authed
 * when the entry names an env key that is set. Reachability is the signal;
 * model listing is best-effort (some gateways don't implement /models).
 */
async function probeEndpoint(entry: CustomModelConfig): Promise<ProbeResult> {
  const key = entry.envKey ? process.env[entry.envKey] : undefined;
  // A bare host may serve the API under /v1; a 404 falls through to the next
  // candidate, and only an all-candidates 404 counts as "no /models route".
  const urls = endpointCandidates(entry.baseUrl, 'models');
  let lastFailure: ProbeResult | null = null;
  for (const url of urls) {
    try {
      const response = await fetch(url, {
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
                detail: 'endpoint reachable (no model list to verify against)',
              }
            : { reachable: false, modelListed: null, detail: `${url} -> HTTP ${response.status}` };
        continue;
      }
      const body = (await response.json().catch(() => null)) as { data?: { id?: string }[] } | null;
      const ids = Array.isArray(body?.data) ? body.data.map(m => m.id) : null;
      if (!ids) {
        return { reachable: true, modelListed: null, detail: 'endpoint reachable' };
      }
      const listed = ids.includes(entry.model);
      return {
        reachable: true,
        modelListed: listed,
        detail: listed
          ? `endpoint reachable; model "${entry.model}" listed`
          : `endpoint reachable, but "${entry.model}" is not in its model list`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lastFailure = {
        reachable: false,
        modelListed: null,
        detail: `${url} unreachable (${message})`,
      };
    }
  }
  return lastFailure!;
}

// Mutate a config file in place: read (or start empty), apply, drop keys that
// went empty (older coder versions reject unknown/empty config keys outright),
// validate, write.
function writeConfigFile(targetFile: string, mutate: (config: Record<string, any>) => void) {
  const current: Record<string, any> = fs.existsSync(targetFile)
    ? JSON.parse(fs.readFileSync(targetFile, 'utf8'))
    : {};
  mutate(current);
  if (current.models && Object.keys(current.models).length === 0) {
    delete current.models;
  }
  const errors = validateConfig(current);
  if (errors.length) {
    fail(`Refusing to write invalid config:\n  ${errors.join('\n  ')}`);
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
}

function writeModels(targetFile: string, mutate: (models: Record<string, ModelEntry>) => void) {
  writeConfigFile(targetFile, current => {
    current.models = current.models ?? {};
    mutate(current.models);
  });
}

// Flags shared by add/update/remove/list.
const MODEL_FLAG_SPEC = z.object({
  ...baseOptions,
  'base-url': str,
  model: str,
  'env-key': str,
  workspace: flag,
});

function resolveTargetFile(options: Record<string, any>, cwd: string): string {
  return options.workspace
    ? path.join(resolveWorkspaceRoot(cwd), 'coder.config.json')
    : resolveUserConfigFile();
}

// Compute the model-list rows shared by the text and JSON views (and the SDK):
// the per-provider rows, the custom endpoints, and any bare toggles.
function buildModelRows(config: CoderConfig) {
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

async function commandModelList(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  if (positionals.length) {
    fail('model list takes no arguments.', { hint: 'Usage: coder model list [--json]' });
  }
  const cwd = resolveCwd(options);
  const s = outStyle;
  const config = loadConfig(cwd);
  const { endpoints, providerRows, toggledSlugs, disabled } = buildModelRows(config);

  if (options.json) {
    printJson(await modelListData(cwd));
    return;
  }

  const mark = (name: string) => (disabled(name) ? s.dim('∅') : s.green('✔'));
  const suffix = (name: string) => (disabled(name) ? ` ${s.dim('(disabled)')}` : '');
  const lines: string[] = [];

  const providerSection = (
    title: string,
    provider: 'codex' | 'claude',
    map: Record<string, string>,
  ) => {
    lines.push(s.bold(title));
    for (const row of providerRows(provider, map)) {
      if ('overrides' in row) {
        lines.push(
          `  ${row.disabled ? s.dim('∅') : s.cyan('↳')} ${row.alias.padEnd(14)} ${s.dim(`-> ${row.spec} (overrides ${row.overrides})`)}${row.disabled ? ` ${s.dim('(disabled)')}` : ''}`,
        );
      } else if ('builtin' in row) {
        lines.push(
          `  ${mark(row.alias)} ${row.alias.padEnd(14)} ${s.dim(`-> ${row.model}`)}${suffix(row.alias)}`,
        );
      } else {
        lines.push(
          `  ${row.disabled ? s.dim('∅') : s.cyan('↳')} ${row.alias.padEnd(14)} ${s.dim(`-> ${row.spec}`)}${row.disabled ? ` ${s.dim('(disabled)')}` : ''}`,
        );
      }
    }
    lines.push('');
  };
  providerSection('Codex models', 'codex', CODEX_MODELS);
  providerSection('Claude models', 'claude', CLAUDE_MODELS);

  lines.push(s.bold('Custom models'), '');
  if (!endpoints.length) {
    lines.push(
      s.dim('  none — coder model add <name> --base-url <url> --model <id> [--env-key VAR]'),
    );
  } else {
    for (const [alias, entry] of endpoints) {
      const probe = await probeEndpoint(entry);
      const reach = entry.disabled ? s.dim('∅') : probe.reachable ? s.green('✔') : s.red('✘');
      lines.push(
        `  ${reach} ${alias.padEnd(14)} ${entry.model} ${s.dim(`@ ${entry.baseUrl} — ${probe.detail}`)}${suffix(alias)}`,
      );
    }
  }
  lines.push('');

  if (toggledSlugs.length) {
    lines.push(s.bold('Other'), '');
    for (const toggle of toggledSlugs) {
      lines.push(
        `  ${toggle.disabled ? s.dim('∅') : s.green('✔')} ${toggle.name.padEnd(14)} ${s.dim('raw model id')}${toggle.disabled ? ` ${s.dim('(disabled)')}` : ''}`,
      );
    }
    lines.push('');
  }

  lines.push(
    s.dim('Alias one: coder model alias <name> <spec>  (e.g. fast codex:spark)'),
    s.dim('Use one:   coder run --model <name> "<task>"  (or coder run --agent custom)'),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
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

// Shared by add and update: persist the entry, probe it, report readiness.
async function saveModel(
  name: string,
  entry: CustomModelConfig,
  options: Record<string, any>,
  cwd: string,
  verb: 'saved' | 'updated',
): Promise<void> {
  const targetFile = resolveTargetFile(options, cwd);
  const s = outStyle;
  const { probe, codex, install, nativeResponses, keyMissing } = await persistModel(
    name,
    entry,
    targetFile,
    cwd,
  );

  if (options.json) {
    printJson({
      name,
      ...entry,
      file: targetFile,
      probe,
      codex,
      ...(install ? { codexInstall: install } : {}),
      ready: probe.reachable && codex.available,
    });
    return;
  }

  const good = (text: string) => `  ${s.green('✔')} ${text}`;
  const bad = (text: string) => `  ${s.red('✘')} ${text}`;
  const lines = [
    `${verb} ${s.cyan(name)} -> ${entry.model} @ ${entry.baseUrl}  ${s.dim(`(${targetFile})`)}`,
    '',
    probe.reachable
      ? good(
          `${probe.detail} ${s.dim(`(${nativeResponses ? 'responses api, direct' : 'chat api, auto-translated'})`)}`,
        )
      : bad(probe.detail),
    codex.available
      ? good(
          install?.installed
            ? `${install.note} ${s.dim(`(${codex.detail})`)}`
            : `codex engine ${s.dim(`(${codex.detail})`)}`,
        )
      : bad(install?.note ?? 'codex CLI not installed - run: npm install -g @openai/codex'),
  ];
  if (keyMissing) {
    lines.push(bad(`env var ${entry.envKey} is not set in this shell`));
  }
  lines.push(
    '',
    s.dim(
      [
        `Use it:       coder run --model ${name} "<task>"`,
        `Make default: coder config set agents.custom.model ${name}`,
      ].join('\n'),
    ),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}

function validateName(name: string | undefined, usage: string, kind: 'model' | 'alias'): string {
  if (!name) {
    fail('Missing model name.', { hint: usage });
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    fail(`Invalid model name "${name}". Use lowercase kebab-case (e.g. qwen-local).`);
  }
  if (RESERVED.has(name) || (kind === 'model' && isBuiltinAlias(name))) {
    fail(`"${name}" is reserved; pick another name.`);
  }
  return name;
}

async function commandModelAdd(argv: string[]): Promise<void> {
  const usage = 'Usage: coder model add <name> --base-url <url> --model <id> [--env-key VAR]';
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = validateName(positionals[0], usage, 'model');
  const config = loadConfig(cwd);
  const existing = config.models?.[name];
  if (existing) {
    fail(
      isEndpointModel(existing)
        ? `Custom model "${name}" already exists.`
        : `"${name}" is already configured as an ${isAliasModel(existing) ? 'alias' : 'entry'}; remove it first.`,
      {
        hint: `Change it: coder model update ${name} [--base-url|--model|--env-key], or remove it first.`,
      },
    );
  }
  if (!options['base-url'] || !options.model) {
    fail('Missing --base-url or --model.', { hint: usage });
  }
  const entry: CustomModelConfig = {
    baseUrl: normalizeBaseUrl(options['base-url']),
    model: options.model,
    ...(options['env-key'] ? { envKey: options['env-key'] } : {}),
  };
  await saveModel(name, entry, options, cwd, 'saved');
}

async function commandModelUpdate(argv: string[]): Promise<void> {
  const usage =
    'Usage: coder model update <name> [--base-url <url>] [--model <id>] [--env-key VAR]';
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = positionals[0];
  const found = name ? loadConfig(cwd).models?.[name] : undefined;
  const existing = found && isEndpointModel(found) ? found : undefined;
  if (!name || !existing) {
    fail(name ? `No custom model named "${name}".` : 'Missing model name.', {
      hint: name ? 'List them: coder model list' : usage,
    });
  }
  if (!options['base-url'] && !options.model && !options['env-key']) {
    fail('Nothing to update: pass --base-url, --model, or --env-key.', { hint: usage });
  }
  const entry: CustomModelConfig = {
    ...existing,
    ...(options['base-url'] ? { baseUrl: normalizeBaseUrl(options['base-url']) } : {}),
    ...(options.model ? { model: options.model } : {}),
    ...(options['env-key'] ? { envKey: options['env-key'] } : {}),
  };
  await saveModel(name, entry, options, cwd, 'updated');
}

async function commandModelRemove(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = positionals[0];
  let result: { removed: string; file: string };
  try {
    result = modelRemoveCore(cwd, name ?? '', { workspace: options.workspace });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), {
      hint: name ? 'List them: coder model list' : 'Usage: coder model remove <name>',
    });
  }
  if (options.json) {
    printJson(result);
    return;
  }
  process.stdout.write(
    `removed ${outStyle.cyan(result.removed)}  ${outStyle.dim(`(${result.file})`)}\n`,
  );
}

async function commandModelDisable(argv: string[]): Promise<void> {
  await toggleModel(argv, true);
}

async function commandModelEnable(argv: string[]): Promise<void> {
  await toggleModel(argv, false);
}

// disable/enable share everything but the direction. Any model name is a
// valid target - a built-in, a configured entry, or a raw engine slug - since
// every dispatch checks the resolved name's `disabled` flag.
async function toggleModel(argv: string[], disable: boolean): Promise<void> {
  const verb = disable ? 'disable' : 'enable';
  const usage = `Usage: coder model ${verb} <name>`;
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = positionals[0];
  if (!name) {
    fail('Missing model name.', { hint: usage });
  }
  const { file: targetFile } = modelToggleCore(cwd, name, disable, {
    workspace: options.workspace,
  });
  if (options.json) {
    printJson({ [disable ? 'disabled' : 'enabled']: name, file: targetFile });
    return;
  }
  process.stdout.write(
    `${verb}d ${outStyle.cyan(name)}  ${outStyle.dim(`(${targetFile})`)}\n`,
  );
}

async function commandModelAlias(argv: string[]): Promise<void> {
  const usage =
    'Usage: coder model alias <name> <spec>   (e.g. coder model alias fast codex:spark)';
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = validateName(positionals[0], usage, 'alias');
  const existing = loadConfig(cwd).models?.[name];
  if (existing && isEndpointModel(existing)) {
    fail(`"${name}" is a custom model name; pick another alias name.`);
  }
  const spec = positionals[1];
  if (!spec) {
    fail('Missing alias spec.', { hint: usage });
  }
  // Parse/validate + write in the core; re-wrap its throw as a hinted fail.
  let result: ReturnType<typeof modelAliasCore>;
  try {
    result = modelAliasCore(cwd, name, spec, { workspace: options.workspace });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The custom-model case has no hint; the rest steer to usage.
    fail(message, message.includes('already dispatchable by name') ? {} : { hint: usage });
  }
  if (options.json) {
    printJson(result);
    return;
  }
  const s = outStyle;
  const desc = `${result.provider} ${result.model}${result.effort ? ` (${result.effort})` : ''}`;
  process.stdout.write(
    `aliased ${s.cyan(name)} -> ${result.provider}:${result.model}${result.effort ? `:${result.effort}` : ''} ${s.dim(`= ${desc}`)}  ${s.dim(`(${result.file})`)}\n`,
  );
}

async function commandModelUnalias(argv: string[]): Promise<void> {
  const usage = 'Usage: coder model unalias <name>';
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = positionals[0];
  const entry = name ? loadConfig(cwd).models?.[name] : undefined;
  if (!name || !entry || !isAliasModel(entry)) {
    fail(name ? `No alias named "${name}".` : 'Missing alias name.', {
      hint: name ? 'List them: coder model list' : usage,
    });
  }
  const { file: targetFile } = modelUnaliasCore(cwd, name, { workspace: options.workspace });
  if (options.json) {
    printJson({ unaliased: name, file: targetFile });
    return;
  }
  process.stdout.write(
    `unaliased ${outStyle.cyan(name)}  ${outStyle.dim(`(${targetFile})`)}\n`,
  );
}

// Throwing name check for the SDK cores (the CLI uses validateName, which exits).
function checkModelName(name: string | undefined, kind: 'model' | 'alias'): asserts name is string {
  if (!name) {
    throw new Error('Missing model name.');
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid model name "${name}". Use lowercase kebab-case (e.g. qwen-local).`);
  }
  if (RESERVED.has(name) || (kind === 'model' && isBuiltinAlias(name))) {
    throw new Error(`"${name}" is reserved; pick another name.`);
  }
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
  name: string,
  opts: ModelWriteOptions,
): Promise<PersistedModel> {
  checkModelName(name, 'model');
  const config = loadConfig(cwd);
  if (config.models?.[name]) {
    throw new Error(`Custom model "${name}" already exists.`);
  }
  if (!opts.baseUrl || !opts.model) {
    throw new Error('Missing baseUrl or model.');
  }
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
  name: string,
  opts: ModelWriteOptions,
): Promise<PersistedModel> {
  const found = loadConfig(cwd).models?.[name];
  const existing = found && isEndpointModel(found) ? found : undefined;
  if (!existing) {
    throw new Error(`No custom model named "${name}".`);
  }
  if (!opts.baseUrl && !opts.model && !opts.envKey) {
    throw new Error('Nothing to update: pass baseUrl, model, or envKey.');
  }
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
  name: string,
  opts: { workspace?: boolean } = {},
): { removed: string; file: string } {
  if (!name || !loadConfig(cwd).models?.[name]) {
    throw new Error(name ? `No custom model named "${name}".` : 'Missing model name.');
  }
  const targetFile = resolveTargetFile({ workspace: opts.workspace }, cwd);
  writeModels(targetFile, models => {
    delete models[name];
  });
  return { removed: name, file: targetFile };
}

// Print-free core: alias a name to a codex/claude model spec.
export function modelAliasCore(
  cwd: string,
  name: string,
  spec: string,
  opts: { workspace?: boolean } = {},
): AliasModelConfig & { alias: string; file: string } {
  checkModelName(name, 'alias');
  const config = loadConfig(cwd);
  const existing = config.models?.[name];
  if (existing && isEndpointModel(existing)) {
    throw new Error(`"${name}" is a custom model name; pick another alias name.`);
  }
  if (!spec) {
    throw new Error('Missing alias spec.');
  }
  // Validate the spec resolves now (throws on disabled/unknown parts too).
  const parsed = parseAgentSpec(spec, config);
  if (!parsed || !parsed.model) {
    throw new Error(`Alias spec "${spec}" does not resolve to a model.`);
  }
  if (parsed.agent === 'custom') {
    throw new Error(
      `"${spec}" names a custom model, which is already dispatchable by name; aliases target codex/claude models.`,
    );
  }
  // Effort is only baked in when the spec named one; agent-default effort stays a dispatch concern.
  const effortGiven = spec
    .split(':')
    .some(part => CODEX_EFFORTS.has(part.trim()) || CLAUDE_EFFORTS.has(part.trim()));
  // Store the concrete model id so the alias never dangles if a built-in name is later shadowed.
  const builtins = parsed.agent === 'claude' ? CLAUDE_MODELS : CODEX_MODELS;
  const entry: AliasModelConfig = {
    provider: parsed.agent,
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
  name: string,
  opts: { workspace?: boolean } = {},
): { unaliased: string; file: string } {
  const entry = name ? loadConfig(cwd).models?.[name] : undefined;
  if (!name || !entry || !isAliasModel(entry)) {
    throw new Error(name ? `No alias named "${name}".` : 'Missing alias name.');
  }
  const targetFile = resolveTargetFile({ workspace: opts.workspace }, cwd);
  writeModels(targetFile, models => {
    delete models[name];
  });
  return { unaliased: name, file: targetFile };
}

// Print-free core shared by disable/enable: flip a model's `disabled` flag.
export function modelToggleCore(
  cwd: string,
  name: string,
  disable: boolean,
  opts: { workspace?: boolean } = {},
): { name: string; disabled: boolean; file: string } {
  if (!name) {
    throw new Error('Missing model name.');
  }
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

export const MODEL_SUBCOMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  list: commandModelList,
  add: commandModelAdd,
  setup: commandModelAdd, // alias
  update: commandModelUpdate,
  remove: commandModelRemove,
  disable: commandModelDisable,
  enable: commandModelEnable,
  alias: commandModelAlias,
  unalias: commandModelUnalias,
};

// `coder model <sub> ...`; bare `coder model` lists.
export async function commandModel(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub.startsWith('-')) {
    await commandModelList(argv);
    return;
  }
  const handler = MODEL_SUBCOMMANDS[sub];
  if (!handler) {
    fail(
      `Unknown model subcommand "${sub}". Use list, add, update, remove, disable, enable, alias, or unalias.`,
      { hint: 'Help: coder model --help' },
    );
  }
  await handler(rest);
}
