/** `coder config [list|get|set|unset]`: the effective config, or one dotted key in the user (or --workspace) file. */
import process from 'node:process';

import { configGet, configSet, loadConfig, resolveUserConfigFile } from '../core/config';
import { CoderError } from '../core/dispatch';
import type { CoderConfig, EngineConfig } from '../core/types';
import { renderCommandHelp } from '../tui/help';
import { outStyle, printJson } from '../tui/output';
import { baseOptions, flag } from '../utils/args';
import { command } from '../cli';

const usage = (text: string) => new CoderError('invalid-option', `Usage: ${text}`);

// Not JSON: comma lists become arrays ("codex,claude"), the rest stay strings.
function parseValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw.includes(',')
      ? raw
          .split(',')
          .map(part => part.trim())
          .filter(Boolean)
      : raw;
  }
}

type ConfigResult =
  | { action: 'list'; config: CoderConfig }
  | { action: 'get'; value: unknown }
  | { action: 'set' | 'unset'; set: ReturnType<typeof configSet> };

export const commandConfig = command({
  name: 'config',
  help: {
    usage: 'coder config <list|get|set|unset> [<key> [value]] [--workspace]',
    summary:
      'Read or write configuration. `list` prints the effective config; get/set/unset\ntarget a dotted key (e.g. engines.codex.model). Writes go to ~/.coder/config.json.',
    flags: [['--workspace', 'target <repo>/.coder/config.json instead of the user file']],
    examples: [
      ['coder config list', 'print the effective config'],
      ['coder config set chain codex,claude', 'set the engine fallback chain'],
      ['coder config get engines.codex.model', 'read one value'],
    ],
  },
  options: { ...baseOptions, workspace: flag },
  args: Number.POSITIVE_INFINITY,
  run({ options, args: [action, key, ...valueParts], cwd }): ConfigResult | undefined {
    if (!action || action === 'help') return undefined;
    if (action === 'list') return { action, config: loadConfig(cwd) };
    if (action === 'get') {
      if (!key) throw usage('coder config get <key>  (e.g. chain, engines.codex.model)');
      return { action, value: configGet(cwd, key) };
    }
    if (action !== 'set' && action !== 'unset')
      throw usage('coder config <list|get|set|unset> [<key> [value]] [--workspace]');
    if (!key || (action === 'set' && valueParts.length === 0))
      throw usage(`coder config ${action} <key>${action === 'set' ? ' <value>' : ''}`);
    return {
      action,
      set: configSet(cwd, key, parseValue(valueParts.join(' ')), {
        workspace: options.workspace,
        unset: action === 'unset',
      }),
    };
  },
  json(result) {
    const r = result!;
    return r.action === 'list' ? r.config : r.action === 'get' ? (r.value ?? null) : r.set;
  },
  print(result) {
    if (!result) return void process.stdout.write(renderCommandHelp('config', commandConfig.help)!);
    if (result.action === 'list') return printConfigList(result.config, resolveUserConfigFile());
    if (result.action === 'get') return printConfigValue(result.value);
    printConfigSet(result.set);
  },
});

function printConfigList(cfg: CoderConfig, file: string): void {
  const s = outStyle;
  const summary = (engine?: EngineConfig) =>
    [engine?.model, engine?.effort, engine?.permissions].filter(Boolean).join('/') || '-';
  process.stdout.write(
    [
      `${s.dim('chain')}      ${cfg.chain.join(' -> ')}`,
      `${s.dim('codex')}      ${summary(cfg.engines.codex)}`,
      `${s.dim('claude')}     ${summary(cfg.engines.claude)}`,
      `${s.dim('approvals')}  timeout=${cfg.approvals.escalationTimeoutMs}ms  hosts=[${cfg.approvals.allowedNetworkHosts.join(', ')}]`,
      `${s.dim('file')}       ${file}`,
    ].join('\n') + '\n',
  );
}

// Objects and null print as JSON; scalars as text.
function printConfigValue(value: unknown): void {
  if (value === null || (typeof value === 'object' && value !== undefined)) return printJson(value);
  process.stdout.write(`${value === undefined ? '(unset)' : String(value)}\n`);
}

function printConfigSet(result: {
  file: string;
  key: string;
  value?: unknown;
  unset?: boolean;
}): void {
  const s = outStyle;
  const detail = result.unset
    ? `unset ${s.cyan(result.key)}`
    : `${s.cyan(result.key)} = ${JSON.stringify(result.value)}`;
  process.stdout.write(`${detail}  ${s.dim(`(${result.file})`)}\n`);
}
