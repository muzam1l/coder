import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { getCodexAvailability } from '../lib/codex-core.js';
import {
  CLAUDE_MODELS,
  CODEX_MODELS,
  loadConfig,
  normalizeBaseUrl,
  resolveUserConfigFile,
  validateConfig,
} from '../lib/config.js';
import { ensureCodexInstalled } from '../lib/plugins.js';
import { resolveWorkspaceRoot } from '../lib/state.js';
import { fail, outStyle, printJson, resolveCwd } from '../lib/ui.js';
import type { CustomModelConfig } from '../lib/types.js';

// Names that would shadow built-in aliases or engine names.
const RESERVED = new Set(['codex', 'claude', ...Object.keys(CODEX_MODELS), ...Object.keys(CLAUDE_MODELS)]);

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
  const url = `${entry.baseUrl.replace(/\/+$/, '')}/models`;
  const key = entry.envKey ? process.env[entry.envKey] : undefined;
  try {
    const response = await fetch(url, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      // No /models route is fine (not every gateway implements it); any other
      // failure (401/403/5xx) means the endpoint itself needs attention.
      return response.status === 404
        ? { reachable: true, modelListed: null, detail: 'endpoint reachable (no model list to verify against)' }
        : { reachable: false, modelListed: null, detail: `${url} -> HTTP ${response.status}` };
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
    return { reachable: false, modelListed: null, detail: `${url} unreachable (${message})` };
  }
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

/**
 * Does the endpoint natively speak the Responses API? POST /responses and see
 * whether the route exists (auth/validation errors still prove the route). If
 * it does, codex talks to it directly; otherwise the chat bridge translates.
 */
async function detectResponsesApi(entry: CustomModelConfig): Promise<boolean> {
  const key = entry.envKey ? process.env[entry.envKey] : undefined;
  try {
    const response = await fetch(`${entry.baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(key ? { Authorization: `Bearer ${key}` } : {}),
      },
      body: JSON.stringify({ model: entry.model, input: [], stream: false }),
      signal: AbortSignal.timeout(5_000),
    });
    return response.status !== 404 && response.status !== 405 && response.status !== 501;
  } catch {
    return false;
  }
}

// coder setup-model                                    -> list custom models (with probe)
// coder setup-model <name> --base-url <url> --model <id> [--env-key VAR]
// coder setup-model --remove <name>
export async function commandSetupModel(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['base-url', 'model', 'env-key', 'remove', 'cwd'],
    booleanOptions: ['workspace', 'json'],
  });
  const cwd = resolveCwd(options);
  const targetFile = options.workspace
    ? path.join(resolveWorkspaceRoot(cwd), 'coder.config.json')
    : resolveUserConfigFile();
  const s = outStyle;

  if (options.remove) {
    const name = options.remove;
    const config = loadConfig(cwd);
    if (!config.models?.[name]) {
      fail(`No custom model named "${name}".`, { hint: 'List them: coder setup-model' });
    }
    writeModels(targetFile, models => {
      delete models[name];
    });
    if (options.json) {
      printJson({ removed: name, file: targetFile });
      return;
    }
    process.stdout.write(`removed ${s.cyan(name)}  ${s.dim(`(${targetFile})`)}\n`);
    return;
  }

  const name = positionals[0];

  // List mode: no name, no flags.
  if (!name) {
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
        `\n${s.dim('Add one: coder setup-model <name> --base-url <url> --model <id> [--env-key VAR]')}\n`,
      );
      return;
    }
    const lines = [s.bold('Custom models'), ''];
    for (const [alias, entry] of entries) {
      const probe = await probeEndpoint(entry);
      const mark = probe.reachable ? s.green('✔') : s.red('✘');
      lines.push(`  ${mark} ${alias.padEnd(14)} ${entry.model} ${s.dim(`@ ${entry.baseUrl} — ${probe.detail}`)}`);
    }
    lines.push('', s.dim('Use one: coder run --model <name> "<task>"'));
    process.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  // Add/update mode.
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    fail(`Invalid model name "${name}". Use lowercase kebab-case (e.g. qwen-local).`);
  }
  if (RESERVED.has(name)) {
    fail(`"${name}" is a built-in alias; pick another name.`);
  }
  if (!options['base-url'] || !options.model) {
    fail('Missing --base-url or --model.', {
      hint: 'Usage: coder setup-model <name> --base-url <url> --model <id> [--env-key VAR]',
    });
  }
  const entry: CustomModelConfig = {
    baseUrl: normalizeBaseUrl(options['base-url']),
    model: options.model,
    ...(options['env-key'] ? { envKey: options['env-key'] } : {}),
  };
  // Wire protocol is detected, not asked: native Responses endpoints get
  // codex directly, chat-completions endpoints go through the bridge. The
  // config field stays editable for gateways that mislead the probe.
  const nativeResponses = await detectResponsesApi(entry);
  if (nativeResponses) {
    entry.wireApi = 'responses';
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
    `saved ${s.cyan(name)} -> ${entry.model} @ ${entry.baseUrl}  ${s.dim(`(${targetFile})`)}`,
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
        `Make default: coder config set agents.codex.model ${name}`,
      ].join('\n'),
    ),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
