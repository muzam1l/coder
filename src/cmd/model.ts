/**
 * `coder model <sub>`: manage custom (OpenAI-compatible) models. They form the
 * `custom` agent and run on the codex engine pointed at the configured URL.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs, str } from '../lib/args.js';
import { getCodexAvailability } from '../lib/codex-core.js';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  endpointCandidates,
  loadConfig,
  normalizeBaseUrl,
  resolveUserConfigFile,
  validateConfig,
} from '../lib/config.js';
import { ensureCodexInstalled } from '../lib/plugins.js';
import { detectWireApi } from '../lib/wire.js';
import { resolveWorkspaceRoot } from '../lib/state.js';
import { fail, outStyle, printJson, resolveCwd } from '../lib/ui.js';
import type { CustomModelConfig } from '../lib/types.js';

// Names that would shadow built-in aliases or agent/engine names.
const RESERVED = new Set([
  'codex',
  'claude',
  'custom',
  ...Object.keys(CODEX_MODELS),
  ...Object.keys(CLAUDE_MODELS),
]);

interface ProbeResult {
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
            ? { reachable: true, modelListed: null, detail: 'endpoint reachable (no model list to verify against)' }
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
      lastFailure = { reachable: false, modelListed: null, detail: `${url} unreachable (${message})` };
    }
  }
  return lastFailure!;
}

function writeModels(
  targetFile: string,
  mutate: (models: Record<string, CustomModelConfig>) => void,
) {
  const current: Record<string, any> = fs.existsSync(targetFile)
    ? JSON.parse(fs.readFileSync(targetFile, 'utf8'))
    : {};
  current.models = current.models ?? {};
  mutate(current.models);
  // Don't leave an empty key behind: older coder versions reject unknown/new
  // config keys outright.
  if (Object.keys(current.models).length === 0) {
    delete current.models;
  }
  const errors = validateConfig(current);
  if (errors.length) {
    fail(`Refusing to write invalid config:\n  ${errors.join('\n  ')}`);
  }
  fs.mkdirSync(path.dirname(targetFile), { recursive: true });
  fs.writeFileSync(targetFile, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
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

async function commandModelList(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  if (positionals.length) {
    fail('model list takes no arguments.', { hint: 'Usage: coder model list [--json]' });
  }
  const cwd = resolveCwd(options);
  const s = outStyle;
  const config = loadConfig(cwd);
  const entries = Object.entries(config.models ?? {});
  if (options.json) {
    const probed = await Promise.all(
      entries.map(async ([alias, entry]) => ({ name: alias, ...entry, probe: await probeEndpoint(entry) })),
    );
    printJson({ models: probed });
    return;
  }
  if (!entries.length) {
    process.stdout.write('No custom models configured.\n');
    process.stdout.write(
      `\n${s.dim('Add one: coder model add <name> --base-url <url> --model <id> [--env-key VAR]')}\n`,
    );
    return;
  }
  const lines = [s.bold('Custom models'), ''];
  for (const [alias, entry] of entries) {
    const probe = await probeEndpoint(entry);
    const mark = probe.reachable ? s.green('✔') : s.red('✘');
    lines.push(`  ${mark} ${alias.padEnd(14)} ${entry.model} ${s.dim(`@ ${entry.baseUrl} — ${probe.detail}`)}`);
  }
  lines.push('', s.dim('Use one: coder run --model <name> "<task>"  (or coder run --agent custom)'));
  process.stdout.write(`${lines.join('\n')}\n`);
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
  // Wire protocol is detected, not asked: native Responses endpoints get
  // codex directly, chat-completions endpoints go through the bridge. The
  // config field stays editable for gateways that mislead the probe. A
  // definitive answer is written explicitly (so runtime never re-probes);
  // codex hits `<baseUrl>/responses` directly, so the stored base must be the
  // one the route was actually found at (e.g. with /v1 appended). When nothing
  // answered, the field stays unset and runtime detects on first use.
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
  const keyMissing = entry.envKey && !process.env[entry.envKey];

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
      ? good(`${probe.detail} ${s.dim(`(${nativeResponses ? 'responses api, direct' : 'chat api, auto-translated'})`)}`)
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

function validateName(name: string | undefined, usage: string): string {
  if (!name) {
    fail('Missing model name.', { hint: usage });
  }
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    fail(`Invalid model name "${name}". Use lowercase kebab-case (e.g. qwen-local).`);
  }
  if (RESERVED.has(name)) {
    fail(`"${name}" is a built-in alias; pick another name.`);
  }
  return name;
}

async function commandModelAdd(argv: string[]): Promise<void> {
  const usage = 'Usage: coder model add <name> --base-url <url> --model <id> [--env-key VAR]';
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = validateName(positionals[0], usage);
  if (loadConfig(cwd).models?.[name]) {
    fail(`Custom model "${name}" already exists.`, {
      hint: `Change it: coder model update ${name} [--base-url|--model|--env-key], or remove it first.`,
    });
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
  const usage = 'Usage: coder model update <name> [--base-url <url>] [--model <id>] [--env-key VAR]';
  const { options, positionals } = parseArgs(argv, MODEL_FLAG_SPEC);
  const cwd = resolveCwd(options);
  const name = positionals[0];
  const existing = name ? loadConfig(cwd).models?.[name] : undefined;
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
  if (!name || !loadConfig(cwd).models?.[name]) {
    fail(name ? `No custom model named "${name}".` : 'Missing model name.', {
      hint: name ? 'List them: coder model list' : 'Usage: coder model remove <name>',
    });
  }
  const targetFile = resolveTargetFile(options, cwd);
  writeModels(targetFile, models => {
    delete models[name];
  });
  if (options.json) {
    printJson({ removed: name, file: targetFile });
    return;
  }
  process.stdout.write(`removed ${outStyle.cyan(name)}  ${outStyle.dim(`(${targetFile})`)}\n`);
}

export const MODEL_SUBCOMMANDS: Record<string, (argv: string[]) => Promise<void>> = {
  list: commandModelList,
  add: commandModelAdd,
  setup: commandModelAdd, // alias
  update: commandModelUpdate,
  remove: commandModelRemove,
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
    fail(`Unknown model subcommand "${sub}". Use list, add, update, or remove.`, {
      hint: 'Help: coder model --help',
    });
  }
  await handler(rest);
}
