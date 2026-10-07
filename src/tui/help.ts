import { formatHints, outStyle } from './output';
import type { CommandHelpSpec, HelpRow, Style } from '../core/types';

export type GroupHelpSpec = {
  menu: MenuRow[];
  usage?: string;
  description?: string[];
  examples?: HelpRow[];
  exampleCommand?: string;
  seeAlso?: string;
  details?: boolean;
};

export type TopHelpSpec = {
  title: string;
  description: string;
  usageLine: string;
  start: MenuRow[];
  agents: MenuRow[];
  usage: MenuRow[];
  commands: MenuRow[];
  globals: MenuRow[];
};

/** A help row: left column in cyan, right in dim, an optional note in light. */
export type MenuRow = { usage: string; blurb: string; note?: string };

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

// `coder <group>` overview: usage, description, subcommand rows, optional examples and related, footer.
export function renderGroupHelp(
  command: string,
  menu: MenuRow[],
  extra: {
    usage?: string;
    description?: string[];
    examples?: HelpRow[];
    seeAlso?: string;
  } = {},
): string {
  const s = outStyle;
  return `${[
    s.bold('Usage:'),
    `  ${extra.usage ?? `coder ${command} <subcommand>`}`,
    ...(extra.description?.length ? ['', ...extra.description] : []),
    ...section('Subcommands', keyRows(menu, s), s),
    ...(extra.examples?.length
      ? section(
          'Examples',
          extra.examples.flatMap(([cmd, desc]) => [`  ${s.cyan(cmd)}`, `    ${s.dim(desc)}`]),
          s,
        )
      : []),
    ...(extra.seeAlso
      ? section(
          'Related',
          extra.seeAlso.split(' · ').map(cmd => `  ${s.cyan(`coder ${cmd}`)}`),
          s,
        )
      : []),
    '',
    formatHints([`Details on a subcommand: coder ${command} <subcommand> --help`], s, s.cyan),
  ].join('\n')}\n`;
}

// `coder <command> --help` / `coder task <sub> --help`. Null for unknown ids.
export function renderCommandHelp(id: string, spec?: CommandHelpSpec): string | null {
  if (!spec) {
    return null;
  }
  const s = outStyle;
  const asRow = ([usage, blurb]: HelpRow): MenuRow => ({ usage, blurb });
  const lines = [s.bold('Usage:'), `  ${spec.usage}`];
  if (spec.summary) lines.push('', spec.summary);
  if (spec.flags?.length) lines.push(...section('Flags', keyRows(spec.flags.map(asRow), s), s));
  if (spec.globalFlags?.length)
    lines.push(...section('Global flags', keyRows(spec.globalFlags.map(asRow), s), s));
  if (spec.exitCodes?.length)
    lines.push(...section('Exit codes', keyRows(spec.exitCodes.map(asRow), s), s));
  if (spec.env?.length) lines.push(...section('Environment', keyRows(spec.env.map(asRow), s), s));
  if (spec.examples?.length)
    lines.push(
      ...section(
        'Examples',
        spec.examples.flatMap(([cmd, desc]) => [`  ${s.cyan(cmd)}`, `    ${s.dim(desc)}`]),
        s,
      ),
    );
  // A subcommand points back at its group's help; a top-level command lists its own.
  const related = id.includes(' ')
    ? [`${id.slice(0, id.lastIndexOf(' '))} --help`]
    : (spec.seeAlso?.split(' · ') ?? []);
  if (related.length)
    lines.push(
      ...section(
        'Related',
        related.map(cmd => `  ${s.cyan(`coder ${cmd}`)}`),
        s,
      ),
    );
  return `${lines.join('\n')}\n`;
}

// Top-level `coder` / `coder help` / `coder --help`.
export function renderTopHelp(spec: TopHelpSpec, version: string): string {
  const s = outStyle;
  const { start, agents, usage, commands, globals } = spec;
  // One width across all blocks so the columns line up.
  const all = [...start, ...agents, ...usage, ...commands, ...globals];
  const rows = keyRows(all, s);
  const cut = (from: number, count: number) => rows.slice(from, from + count);
  return `${[
    `${s.bold(spec.title)} ${s.dim(`v${version}`)}`,
    spec.description,
    ...section('Get started', cut(0, start.length), s),
    ...section('Agents', cut(start.length, agents.length), s),
    ...section(
      'Usage',
      [`  ${spec.usageLine}`, ...cut(start.length + agents.length, usage.length)],
      s,
    ),
    ...section('Commands', cut(start.length + agents.length + usage.length, commands.length), s),
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
