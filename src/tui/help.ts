import { render, type App, type Command, type Namespace } from 'contextjsx';
import { walk } from 'contextjsx/emit';
import * as z from 'zod/mini';

import { formatHints, outStyle } from './output';
import type { Style } from '../core/types';

export type TopHelpSpec = {
  title: string;
  description: string;
  usageLine: string;
  start: MenuRow[];
  agents: MenuRow[];
  cloudIntro: string;
  cloud: MenuRow[];
  usage: MenuRow[];
  commands: MenuRow[];
  globals: MenuRow[];
};

/** A help row: left column in cyan, right in dim, an optional note in light. */
export type MenuRow = { usage: string; blurb: string; note?: string };

type Schema = z.core.$ZodType;
type Def = {
  type: string;
  innerType?: Schema;
  in?: Schema;
  options?: Schema[];
  values?: unknown[];
};

// The schema's kind under optional, default and pipe wrappers; a union with `true` is a flag that may carry a value.
function kind(schema: Schema): string {
  let def = schema._zod.def as Def;
  while (def.innerType ?? def.in) def = (def.innerType ?? def.in)!._zod.def as Def;
  if (def.type === 'union' && def.options?.some(o => (o._zod.def as Def).values?.includes(true)))
    return 'maybe';

  return def.type;
}

const meta = (schema: Schema) =>
  (z.globalRegistry.get(schema) ?? {}) as { description?: string; value?: string };

// `<name>`, `[name]`, `<name>...` or `[name...]`.
function positional(command: Command, name: string): string {
  const schema = command.args![name]!;
  const rest = kind(schema) === 'array' ? '...' : '';

  return schema._zod.optin ? `[${name}${rest}]` : `<${name}>${rest}`;
}

/** `--name <value>` and its description, from the schema. */
export function flagRow(name: string, schema: Schema): MenuRow {
  const type = kind(schema);
  const value =
    meta(schema).value ?? (type === 'boolean' ? '' : type === 'maybe' ? `[${name}]` : `<${name}>`);

  return { usage: `--${name}${value ? ` ${value}` : ''}`, blurb: meta(schema).description ?? '' };
}

const paragraphs = (command: Command | Namespace) =>
  [command.description, command.usage == null ? '' : render(command.usage)].filter(Boolean);

// Two-column rows aligned to the widest left cell.
export function keyRows(rows: MenuRow[], style: Style, paint = style.cyan): string[] {
  const width = Math.max(0, ...rows.map(r => r.usage.length)) + 2;
  return rows.map(
    r =>
      `  ${paint(r.usage.padEnd(width))}${style.dim(r.blurb)}${r.note ? ` ${style.light(r.note)}` : ''}`,
  );
}

// A titled block preceded by a blank line.
export function section(title: string, lines: string[], style: Style): string[] {
  return ['', style.bold(`${title}:`), ...lines];
}

// `coder <group>` overview: usage, description, subcommand and nested group rows, footer.
export function renderGroupHelp(
  group: Namespace,
  app: App,
  shortcuts: Record<string, string[]>,
): string {
  const s = outStyle;
  const parts = walk(app).namespaces.find(entry => entry.namespace === group)?.path ?? [group.name];
  const name = parts.join(' ');
  const note = (command: Command) =>
    Object.entries(shortcuts).find(
      ([, path]) => path.join(' ') === [...parts, command.name].join(' '),
    )?.[0];
  const nested = group.namespaces ?? [];
  const menu: MenuRow[] = [
    ...group.commands.map(command => ({
      usage: [
        command.name,
        ...(command.cli?.positional ?? []).map(arg => positional(command, arg)),
      ].join(' '),
      blurb: command.description,
      ...(note(command) ? { note: `(coder ${note(command)})` } : {}),
    })),
    ...nested.map(other => ({
      usage: `${other.name} <${other.commands.map(command => command.name).join('|')}>`,
      blurb: other.description,
    })),
  ];

  return `${[
    s.bold('Usage:'),
    `  coder ${name} <subcommand>`,
    '',
    paragraphs(group).join('\n\n'),
    ...section('Subcommands', keyRows(menu, s), s),
    '',
    formatHints([`Details on a subcommand: coder ${name} <subcommand> --help`], s, s.cyan),
  ].join('\n')}\n`;
}

// `coder <command> --help` / `coder task <sub> --help`.
export function renderCommandHelp(command: Command, app?: App): string {
  const s = outStyle;
  const names = command.cli?.positional ?? [];
  const entries = Object.entries(command.args ?? {}).filter(([name]) => !names.includes(name));
  const flags = entries.filter(([name]) => name !== 'json' && name !== 'cwd');
  const globals = entries.filter(([name]) => name === 'json' || name === 'cwd');
  const parts = app
    ? (walk(app).commands.find(entry => entry.command === command)?.path ?? [command.name])
    : [command.name];
  const id = parts.join(' ');
  const lines = [
    s.bold('Usage:'),
    `  ${['coder', id, ...names.map(name => positional(command, name)), ...(flags.length ? ['[flags]'] : [])].join(' ')}`,
    '',
    paragraphs(command).join('\n\n'),
  ];
  const rows = (list: [string, Schema][]) =>
    keyRows(
      list.map(([n, schema]) => flagRow(n, schema)),
      s,
    );
  const pairs = (list: Array<[string | number, string]>) =>
    keyRows(
      list.map(([usage, blurb]) => ({ usage: String(usage), blurb })),
      s,
    );
  const { exit, env, examples } = command.cli ?? {};

  if (flags.length) lines.push(...section('Flags', rows(flags), s));
  if (globals.length) lines.push(...section('Global flags', rows(globals), s));
  if (exit?.length) lines.push(...section('Exit codes', pairs(exit), s));
  if (env?.length) lines.push(...section('Environment', pairs(env), s));
  if (examples?.length)
    lines.push(
      ...section(
        'Examples',
        examples.flatMap(example => {
          const at = example.lastIndexOf('  # ');
          return at < 0
            ? [`  ${s.cyan(example)}`]
            : [`  ${s.cyan(example.slice(0, at))}`, `    ${s.dim(example.slice(at + 4))}`];
        }),
        s,
      ),
    );
  // A subcommand points back at its group's help.
  if (parts.length > 1)
    lines.push(
      ...section('Related', [`  ${s.cyan(`coder ${parts.slice(0, -1).join(' ')} --help`)}`], s),
    );

  return `${lines.join('\n')}\n`;
}

// Top-level `coder` / `coder help` / `coder --help`.
export function renderTopHelp(spec: TopHelpSpec, version: string): string {
  const s = outStyle;
  const { start, agents, cloud, usage, commands, globals } = spec;
  // One width across all blocks so the columns line up.
  const all = [...start, ...agents, ...cloud, ...usage, ...commands, ...globals];
  const rows = keyRows(all, s);
  let at = 0;
  const next = (count: number) => rows.slice(at, (at += count));
  return `${[
    `${s.bold(spec.title)} ${s.dim(`v${version}`)}`,
    spec.description,
    ...section('Get started', next(start.length), s),
    ...section('Agents', next(agents.length), s),
    ...section('Coder Cloud', [`  ${s.dim(spec.cloudIntro)}`, ...next(cloud.length)], s),
    ...section('Usage', [`  ${spec.usageLine}`, ...next(usage.length)], s),
    ...section('Commands', next(commands.length), s),
    ...section('Global', rows.slice(-globals.length), s),
  ].join('\n')}\n`;
}

// A help flag counts only before a `--` passthrough, so a literal "--help" in
// task text (coder task run -- "... --help ...") is not mistaken for a request.
export function wantsHelp(argv: string[]): boolean {
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  return head.includes('-h') || head.includes('--help');
}
