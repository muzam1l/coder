/** `coder config [list|get|set|unset|migrate]`: the effective config, one dotted key, or the config version of the user (or --workspace) file. */
import process from 'node:process';

import type { configSet, migrateConfigFile } from '../core/config';
import { CoderError } from '../core/errors';
import type { CoderConfig } from '../core/types';
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
  | { action: 'list'; config: CoderConfig; file: string }
  | { action: 'get'; value: unknown }
  | { action: 'set' | 'unset'; set: ReturnType<typeof configSet> }
  | ({ action: 'migrate' } & ReturnType<typeof migrateConfigFile>);

export const commandConfig = command({
  name: 'config',
  description: 'read or write config',
  usage:
    'Read or write configuration. `list` prints the effective config; get/set/unset\ntarget a dotted key (e.g. chain); migrate rewrites the file at this Coder\'s config\nversion. Writes go to ~/.coder/config.json.',
  access: 'write',
  approvalPolicy: 'deny',
  args: {
    action: str('list, get, set, unset or migrate'),
    key: str('a dotted key, such as chain or reviewModel'),
    value: strList('with set: the value; JSON, or a comma list'),
    workspace: flag('target <repo>/.coder/config.json instead of the user file'),
  },
  cli: {
    positional: ['action', 'key', 'value'],
    examples: [
      'coder config list  # print the effective config',
      'coder config set chain codex/sol,claude/opus  # the default model, then its fallbacks',
      'coder config get reviewModel  # read one value',
      'coder config migrate --workspace  # rewrite the repo file at config version 1',
    ],
  },
  async run({
    options,
    args: [action, key, ...valueParts],
    cwd,
  }): Promise<ConfigResult | undefined> {
    if (!action || action === 'help') return undefined;
    const { config, migrateConfigFile, resolveUserConfigFile } = await import('../core/config');
    if (action === 'migrate')
      return { action, ...migrateConfigFile(cwd, options.workspace) };
    if (action === 'list')
      return {
        action,
        config: config.get(undefined, { cwd }) as CoderConfig,
        file: resolveUserConfigFile(),
      };
    if (action === 'get') {
      if (!key) throw usage('coder config get <key>  (e.g. chain, reviewModel)');
      return { action, value: config.get(key, { cwd }) };
    }
    if (action !== 'set' && action !== 'unset')
      throw usage('coder config <list|get|set|unset|migrate> [<key> [value]] [--workspace]');
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
    return r.action === 'list'
      ? r.config
      : r.action === 'get'
        ? (r.value ?? null)
        : r.action === 'migrate'
          ? { file: r.file, version: r.version, notes: r.notes }
          : r.set;
  },
  print(result) {
    if (!result) return void process.stdout.write(renderCommandHelp(commandConfig));
    if (result.action === 'list') return printConfigList(result.config, result.file);
    if (result.action === 'get') return printConfigValue(result.value);
    if (result.action === 'migrate')
      return void process.stdout.write(
        [
          ...result.notes,
          result.version === 1
            ? `${result.file} is already config version 1.`
            : `Rewrote ${result.file} from config version ${result.version} to 1.`,
        ].join('\n') + '\n',
      );
    printConfigSet(result.set);
  },
});

function printConfigList(cfg: CoderConfig, file: string): void {
  const s = outStyle;
  process.stdout.write(
    [
      `${s.dim('chain')}      ${cfg.chain.join(' -> ')}`,
      `${s.dim('review')}     ${cfg.reviewModel}`,
      `${s.dim('network')}    hosts=[${cfg.network.allowedHosts.join(', ')}]`,
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
