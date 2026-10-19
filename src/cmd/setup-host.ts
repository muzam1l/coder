/** `coder setup-host [claude|agents|codex|cursor]`: probe engines, seed the chain, install host plugins. */
import process from 'node:process';

import type { PluginResult, SetupHostReport } from '../core/hosts';
import type { Engine } from '../core/types';
import { bad, good, outStyle } from '../tui/output';
import { strList } from '../utils/args';
import { command, nextSteps, type CommandNext } from '../cli';

export const commandSetupHost = command({
  name: 'setup-host',
  description: 'check engines and install the host plugin or skill',
  usage:
    'Set up coder in your host: check engines and auth, seed the config, and\ninstall the host plugin/skill for the named host(s). Claude Code gets its\nmarketplace plugin; "agents" installs a skill into ~/.agents/skills for\nevery host that reads the Agent Skills standard dir (Codex, Pi, OpenCode,\n...). Codex and Cursor also get the MCP server; the Claude plugin includes it.\nWith no host, checks, seeds and registers available Codex and Cursor hosts.\n\nTo add the MCP server by hand: claude mcp add coder -- coder mcp, codex mcp\nadd coder -- coder mcp, or for Cursor "coder": { "command": "coder", "args":\n["mcp"] } under mcpServers in ~/.cursor/mcp.json. Restart running sessions after.',
  access: 'write',
  args: { hosts: strList('claude, agents, codex, cursor (one or more)') },
  cli: {
    positional: ['hosts'],
    examples: [
      'coder setup-host claude  # install the Claude Code plugin',
      'coder setup-host agents  # install the shared skill and register MCP with available Codex',
      'coder setup-host codex cursor  # install the skill and register MCP with both hosts',
    ],
  },
  run: async ({ options, args, cwd, tool }) => {
    const { setupHostCore } = await import('../core/hosts');
    return setupHostCore(
      cwd,
      { ...options, hosts: args },
      () => options.json || tool || printSetupHostHeader(),
    );
  },
  next({ result }) {
    return [
      ...(['codex', 'claude'] as const).flatMap(engine => setupEngineNext(result, engine)),
      ...nextSteps(['custom models (local/provider endpoints): coder model --help'], {
        layout: 'plain',
        dim: true,
        prefix: '  ',
        slot: 'models',
      }),
      ...nextSteps(['(coder config set <key> <value> to change)'], {
        layout: 'plain',
        dim: true,
        prefix: `  ${outStyle.dim(result.configFile)} `,
        slot: 'config',
      }).map(step => ({ ...step, usage: 'coder config set <key> <value>' })),
      ...nextSteps(
        [
          result.ready
            ? `ready - try: coder run --wait "explain this repo's layout"`
            : 'not ready - install an engine CLI to run tasks: codex (npm install -g @openai/codex, then codex login) or claude (npm install -g @anthropic-ai/claude-code, then claude auth login)',
        ],
        { layout: result.ready ? 'good' : 'bad', prefix: '' },
      ),
    ];
  },
  print: (report, { next }) => printSetupHost(report, next),
});

// Printed before probing, which spawns other CLIs and can take seconds.
function printSetupHostHeader(): void {
  process.stdout.write(`${outStyle.bold('Coder host setup')}\n\n`);
}

function printSetupHost(
  report: SetupHostReport,
  next: (result: unknown, display?: { slot?: string }) => void,
): void {
  const head = outStyle.bold;
  const gray = outStyle.dim;
  const { codex, claude, codexUpdate, config, configFile, claudePlugin, agentsSkill, ready } =
    report;
  const lines: string[] = [];

  process.stdout.write(`${head('Available Engines')}\n`);
  for (const engine of ['codex', 'claude'] as const) {
    const entry = report[engine];
    if (!entry.available || !entry.loggedIn) next(report, { slot: engine });
    else
      process.stdout.write(
        `${good(`${engine.padEnd(8)}${gray(`${entry.detail}; ${entry.auth}`)}`)}\n`,
      );
  }
  next(report, { slot: 'models' });
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
  );

  process.stdout.write(`${lines.join('\n')}\n`);
  lines.length = 0;
  next(report, { slot: 'config' });
  lines.push('');

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

  lines.push(...report.mcp.map(entry => (entry.installed ? good(entry.note) : bad(entry.note))));
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
}

function setupEngineNext(report: SetupHostReport, engine: 'codex' | 'claude'): CommandNext[] {
  const entry = report[engine];
  if (entry.available && entry.loggedIn) return [];
  const usage = entry.available
    ? engine === 'codex'
      ? 'codex login'
      : 'claude auth login'
    : `npm install -g ${engine === 'codex' ? '@openai/codex' : '@anthropic-ai/claude-code'}`;
  const text = entry.available
    ? `${engine.padEnd(8)}not logged in${engine === 'codex' ? ` ${outStyle.dim(`(${entry.auth})`)}` : ''} - run: ${usage}`
    : `${engine.padEnd(8)}CLI not installed - run: ${usage}`;
  return [
    {
      usage,
      blurb: `${engine} ${entry.available ? 'not logged in' : 'CLI not installed'}`,
      cli: { text, layout: 'bad', prefix: '', slot: engine },
    },
  ];
}
