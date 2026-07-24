import fs from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs } from '../lib/args.js';
import { getCodexAuthStatus, getCodexAvailability } from '../lib/codex-core.js';
import { getClaudeAuthStatus, getClaudeAvailability } from '../lib/claude-core.js';
import {
  DEFAULT_CONFIG,
  loadConfig,
  resolveUserConfigFile,
  writeUserConfig,
} from '../lib/config.js';
import { resolveMarketplaceDir } from '../lib/runtime.js';
import {
  ensureCodexUpToDate,
  installAgentsSkill,
  installClaudePlugin,
  type PluginResult,
} from '../lib/plugins.js';
import { bad, fail, good, outStyle, printJson, resolveCwd } from '../lib/ui.js';
import type { Agent, CoderConfig } from '../lib/types.js';

export interface SetupHostReport {
  codex: { available: boolean; detail: string; auth: string; loggedIn: boolean };
  codexUpdate?: ReturnType<typeof ensureCodexUpToDate>;
  claude: { available: boolean; detail: string; auth: string; loggedIn: boolean };
  configFile: string;
  runtime: string;
  claudePlugin?: PluginResult;
  agentsSkill?: PluginResult;
  config: CoderConfig;
  ready: boolean;
}

// Print-free core: probe engines, seed the chain, install requested host plugins.
// It performs the real side effects (installs, chain seeding) - just no output.
export async function setupHostCore(
  cwd: string,
  opts: { claude?: boolean; codex?: boolean; agents?: boolean } = {},
): Promise<SetupHostReport> {
  let availability = getCodexAvailability(cwd);
  const codexUpdate = ensureCodexUpToDate(availability);
  if (codexUpdate?.updated) {
    // Re-read so the rest of setup reflects the freshly-installed codex.
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
    // Seed the chain from what's installed; codex-first when neither is present.
    const chain: Agent[] = availability.available
      ? ['codex', 'claude']
      : claude.available
        ? ['claude', 'codex']
        : ['codex', 'claude'];
    writeUserConfig({ ...DEFAULT_CONFIG, chain });
  }

  const marketplaceDir = resolveMarketplaceDir();
  const claudePlugin = opts.claude ? installClaudePlugin(marketplaceDir) : null;
  // Codex, Pi, OpenCode and other Agent Skills hosts read ~/.agents/skills.
  const agentsPlugin = opts.agents || opts.codex ? installAgentsSkill(marketplaceDir) : null;

  const config = loadConfig(cwd);
  // Ready as long as one engine is usable: installed AND logged in.
  const ready =
    (availability.available && auth.loggedIn) || (claude.available && claudeAuth.loggedIn);

  return {
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
    ...(claudePlugin ? { claudePlugin } : {}),
    ...(agentsPlugin ? { agentsSkill: agentsPlugin } : {}),
    config,
    ready,
  };
}

export async function commandSetupHost(argv: string[]) {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ ...baseOptions, codex: flag, claude: flag, agents: flag }),
  );
  const cwd = resolveCwd(options);
  // Hosts are named positionally (`coder setup-host claude`); the old
  // --claude/--codex flags keep working as silent aliases.
  // Hosts are claude and agents (the ~/.agents/skills install covering every
  // host that reads the Agent Skills standard dir - codex included). "codex"
  // stays accepted as an alias for agents.
  const knownHosts = ['claude', 'codex', 'agents'] as const;
  for (const host of positionals) {
    if (!knownHosts.includes(host as (typeof knownHosts)[number])) {
      fail(`Unknown host "${host}". Use claude, codex, or agents.`, {
        hint: 'Codex, Pi, OpenCode, and other Agent Skills hosts: coder setup-host agents',
      });
    }
    options[host as (typeof knownHosts)[number]] = true;
  }

  const head = outStyle.bold;
  const gray = outStyle.dim;

  // Print the header before any probing: everything below spawns other CLIs
  // (codex/claude versions, auth via the codex app-server) and can take
  // seconds - early output shows the command is alive.
  if (!options.json) {
    process.stdout.write(`${head('Coder host setup')}\n\n`);
  }

  const report = await setupHostCore(cwd, {
    claude: options.claude,
    codex: options.codex,
    agents: options.agents,
  });

  if (options.json) {
    printJson(report);
    return;
  }

  const { codex, claude, codexUpdate, config, configFile, claudePlugin, agentsSkill, ready } =
    report;
  const lines: string[] = [];

  const codexLine = codex.available
    ? codex.loggedIn
      ? good(`codex   ${gray(`${codex.detail}; ${codex.auth}`)}`)
      : bad(`codex   not logged in ${gray(`(${codex.auth})`)} - run: codex login`)
    : bad(`codex   CLI not installed - run: npm install -g @openai/codex`);
  const claudeLine = claude.available
    ? claude.loggedIn
      ? good(`claude  ${gray(`${claude.detail}; ${claude.auth}`)}`)
      : bad(`claude  not logged in - run: claude auth login`)
    : bad(`claude  CLI not installed - run: npm install -g @anthropic-ai/claude-code`);
  lines.push(
    head('Available Engines'),
    codexLine,
    claudeLine,
    `  ${gray('custom models (local/provider endpoints): coder model --help')}`,
  );
  if (codexUpdate?.updated) {
    lines.push(
      good(`codex   ${gray(`updated ${codexUpdate.from} -> ${codex.detail} (GPT-5.6 support)`)}`),
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
    ['claude plugin', claudePlugin ?? null],
    ['agents skill ', agentsSkill ?? null],
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
