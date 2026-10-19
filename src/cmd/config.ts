/** `coder config [list|get|set|unset]`: the effective config, or one dotted key in the user (or --workspace) file. */
import process from 'node:process';

import { config, configSet, resolveUserConfigFile } from '../core/config';
import { CoderError } from '../core/dispatch';
import type { CoderConfig, EngineConfig } from '../core/types';
import { renderCommandHelp } from '../tui/help';
import { outStyle, printJson } from '../tui/output';
import { flag, str, strList } from '../utils/args';
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
  description: 'read or write config',
  usage:
    'Read or write configuration. `list` prints the effective config; get/set/unset\ntarget a dotted key (e.g. engines.codex.model). Writes go to ~/.coder/config.json.',
  access: 'write',
  args: {
    action: str('list, get, set or unset'),
    key: str('a dotted key, such as engines.codex.model'),
    value: strList('with set: the value; JSON, or a comma list'),
    workspace: flag('target <repo>/.coder/config.json instead of the user file'),
  },
  cli: {
    positional: ['action', 'key', 'value'],
    examples: [
      'coder config list  # print the effective config',
      'coder config set chain codex,claude  # set the engine fallback chain',
      'coder config get engines.codex.model  # read one value',
    ],
  },
  run({ options, args: [action, key, ...valueParts], cwd }): ConfigResult | undefined {
    if (!action || action === 'help') return undefined;
    if (action === 'list') return { action, config: config.get(undefined, { cwd }) as CoderConfig };
    if (action === 'get') {
      if (!key) throw usage('coder config get <key>  (e.g. chain, engines.codex.model)');
      return { action, value: config.get(key, { cwd }) };
    }
    if (action !== 'set' && action !== 'unset')
      throw usage('coder config <list|get|set|unset> [<key> [value]] [--workspace]');
    if (!key || (action === 'set' && valueParts.length === 0))
      throw usage(`coder config ${action} <key>${action === 'set' ? ' <value>' : ''}`);
    return {
      action,
      set: config.set(key, parseValue(valueParts.join(' ')), {
        cwd,
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
    if (!result) return void process.stdout.write(renderCommandHelp(commandConfig));
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
