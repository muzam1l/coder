/** `coder setup-host [claude|agents|codex]`: probe engines, seed the chain, install host plugins. */
import process from 'node:process';

import { setupHostCore, type PluginResult, type SetupHostReport } from '../core/hosts';
import type { Engine } from '../core/types';
import { bad, good, outStyle } from '../tui/output';
import { baseOptions, flag } from '../utils/args';
import { command } from '../cli';

// Hosts are named positionally; the --claude/--codex/--agents flags stay as silent aliases.
export const commandSetupHost = command({
  name: 'setup-host',
  help: {
    usage: 'coder setup-host [claude] [codex] [agents] [--json]',
    summary:
      'Set up coder in your host: check engines and auth, seed the config, and\ninstall the host plugin/skill for the named host(s). Claude Code gets its\nmarketplace plugin; "agents" installs a skill into ~/.agents/skills for\nevery host that reads the Agent Skills standard dir (Codex, Pi, OpenCode,\n...). "codex" is an alias for agents. With no host, checks and seeds.',
    examples: [
      ['coder setup-host claude', 'install the Claude Code plugin'],
      [
        'coder setup-host agents',
        'install the skill into ~/.agents/skills (Codex, Pi, OpenCode, ...)',
      ],
    ],
  },
  options: { ...baseOptions, codex: flag, claude: flag, agents: flag },
  args: Number.POSITIVE_INFINITY,
  run: ({ options, args, cwd }) =>
    setupHostCore(cwd, { ...options, hosts: args }, () => options.json || printSetupHostHeader()),
  print: printSetupHost,
});

// Printed before probing, which spawns other CLIs and can take seconds.
function printSetupHostHeader(): void {
  process.stdout.write(`${outStyle.bold('Coder host setup')}\n\n`);
}

function printSetupHost(report: SetupHostReport): void {
  const head = outStyle.bold;
  const gray = outStyle.dim;
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
      good(`codex   ${gray(`updated ${codexUpdate.from} -> ${codex.detail} (GPT-6 support)`)}`),
    );
  } else if (codexUpdate) {
    lines.push(bad(`codex   ${codexUpdate.note}`));
  }
  lines.push('');

  const engineSummary = (engine: Engine) => {
    const entry = config.engines?.[engine] ?? {};
    return [entry.model, entry.effort, entry.permissions].filter(Boolean).join('/');
  };
  lines.push(
    head('Config'),
    `  chain: ${(config.chain ?? []).join(' -> ')}   codex: ${engineSummary('codex')}   claude: ${engineSummary('claude')}`,
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
