import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { parseArgs } from '../lib/args.js';
import { getCodexAuthStatus, getCodexAvailability } from '../lib/codex-core.js';
import { getClaudeAuthStatus, getClaudeAvailability } from '../lib/claude-core.js';
import { DEFAULT_CONFIG, loadConfig, resolveUserConfigFile, writeUserConfig } from '../lib/config.js';
import { resolveMarketplaceDir } from '../lib/runtime.js';
import {
  ensureCodexUpToDate,
  installClaudePlugin,
  installCodexPlugin,
  installCursorPlugin,
  type PluginResult,
} from '../lib/plugins.js';
import { printJson, resolveCwd } from '../lib/ui.js';
import type { Agent } from '../lib/types.js';

export async function commandSetup(argv: string[]) {
  const { options } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['codex', 'claude', 'cursor', 'json'],
  });
  const cwd = resolveCwd(options);

  let availability = getCodexAvailability(cwd);
  const codexUpdate = ensureCodexUpToDate(availability);
  if (codexUpdate?.updated) {
    // Re-read so the rest of setup (auth, chain seeding, output) reflects the
    // freshly-installed codex rather than the stale version we just replaced.
    availability = getCodexAvailability(cwd);
  }
  const auth = availability.available
    ? await getCodexAuthStatus(cwd)
    : { loggedIn: false, detail: availability.detail };
  const claude = getClaudeAvailability();
  const claudeAuth = claude.available
    ? getClaudeAuthStatus()
    : { loggedIn: false, detail: claude.detail };

  const configFile = resolveUserConfigFile();
  if (!fs.existsSync(configFile)) {
    // Seed the chain from what's installed. Codex is the recommended primary,
    // but when it's absent Claude leads so tasks work without installing Codex.
    // Neither installed => codex-first, so setup nudges the recommended install
    // (the Claude opus-subagent fallback still runs meanwhile under a claude host).
    const chain: Agent[] = availability.available
      ? ['codex', 'claude']
      : claude.available
        ? ['claude', 'codex']
        : ['codex', 'claude'];
    writeUserConfig({ ...DEFAULT_CONFIG, chain });
  }

  const marketplaceDir = resolveMarketplaceDir();
  const codexPlugin = options.codex ? installCodexPlugin(marketplaceDir) : null;
  const claudePlugin = options.claude ? installClaudePlugin(marketplaceDir) : null;
  const cursorPlugin = options.cursor ? installCursorPlugin(marketplaceDir) : null;

  const config = loadConfig(cwd);
  // Ready as long as one engine is usable: installed AND logged in (codex or claude).
  const ready =
    (availability.available && auth.loggedIn) || (claude.available && claudeAuth.loggedIn);

  if (options.json) {
    printJson({
      codex: {
        available: availability.available,
        detail: availability.detail,
        auth: auth.detail,
        loggedIn: auth.loggedIn,
      },
      ...(codexUpdate ? { codexUpdate } : {}),
      claude: {
        available: claude.available,
        detail: claude.detail,
        auth: claudeAuth.detail,
        loggedIn: claudeAuth.loggedIn,
      },
      configFile,
      runtime: fileURLToPath(new URL('../bin/coder.mjs', import.meta.url)),
      ...(codexPlugin ? { codexPlugin } : {}),
      ...(claudePlugin ? { claudePlugin } : {}),
      ...(cursorPlugin ? { cursorPlugin } : {}),
      config,
      ready,
    });
    return;
  }

  const tty = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  const good = (text: string) => `  ${paint('32', '✔')} ${text}`;
  const bad = (text: string) => `  ${paint('31', '✘')} ${text}`;
  const head = (text: string) => paint('1', text);
  const gray = (text: string) => paint('38;5;245', text);

  const lines = [head('Coder host setup'), ''];

  const codexLine = availability.available
    ? auth.loggedIn
      ? good(`codex   ${gray(`${availability.detail}; ${auth.detail}`)}`)
      : bad(`codex   not logged in ${gray(`(${auth.detail})`)} - run: codex login`)
    : bad(`codex   CLI not installed - run: npm install -g @openai/codex`);
  const claudeLine = claude.available
    ? claudeAuth.loggedIn
      ? good(`claude  ${gray(`${claude.detail}; ${claudeAuth.detail}`)}`)
      : bad(`claude  not logged in - run: claude auth login`)
    : bad(`claude  CLI not installed - run: npm install -g @anthropic-ai/claude-code`);
  lines.push(head('Available Engines'), codexLine, claudeLine);
  if (codexUpdate?.updated) {
    lines.push(
      good(`codex   ${gray(`updated ${codexUpdate.from} -> ${availability.detail} (GPT-5.6 support)`)}`),
    );
  } else if (codexUpdate) {
    lines.push(bad(`codex   ${codexUpdate.note}`));
  }
  lines.push('');

  const agentSummary = (agent: Agent) => {
    const entry = config.agents?.[agent] ?? {};
    return [entry.model, entry.effort, entry.permissions].filter(Boolean).join('/');
  };
  lines.push(
    head('Config'),
    `  chain: ${(config.chain ?? []).join(' -> ')}   codex: ${agentSummary('codex')}   claude: ${agentSummary('claude')}`,
    `  ${gray(configFile)} ${gray('(coder config set <key> <value> to change)')}`,
    '',
  );

  const pluginSummaries: [string, PluginResult | null][] = [
    ['codex plugin ', codexPlugin],
    ['claude plugin', claudePlugin],
    ['cursor plugin', cursorPlugin],
  ];
  for (const [label, plugin] of pluginSummaries) {
    if (plugin) {
      lines.push(
        plugin.installed ? good(`${label} ${gray(plugin.note)}`) : bad(`${label} ${plugin.note}`),
        '',
      );
    }
  }

  lines.push(
    ready
      ? good(`ready - try: coder run --wait "explain this repo's layout"`)
      : bad(
          `not ready - install an engine CLI to run tasks: codex (npm install -g @openai/codex, then codex login) or claude (npm install -g @anthropic-ai/claude-code, then claude auth login)`,
        ),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
