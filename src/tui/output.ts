/** Shared terminal presentation helpers: ANSI styling, structured failure, JSON output, durations and tables. */
import process from 'node:process';

import type { Style, TokenUsage } from '../core/types';
import { termCols } from './live';

/** Failure detail: an exit code, or a code plus dimmed next-step hint line(s). */
export type FailOptions = number | { code?: number; hint?: string | string[] };

// ANSI stylers, one per stream (TTY-gated, honoring NO_COLOR and FORCE_COLOR;
// FORCE_COLOR wins, as in Node). Computed once: isTTY is stable for the
// process lifetime.
export function makeStyle(stream: NodeJS.WriteStream): Style {
  const force = process.env.FORCE_COLOR;
  const tty =
    force != null && force !== '' && force !== '0'
      ? true
      : force === '0'
        ? false
        : stream.isTTY && !process.env.NO_COLOR;
  const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    blue: text => paint('34', text),
    bold: text => paint('1', text),
    cyan: text => paint('36', text),
    // Faint (SGR 2) rather than a fixed grey, so the shade follows the theme's
    // foreground instead of assuming a dark background.
    dim: text => paint('2', text),
    light: text => paint('38;5;246', text),
    green: text => paint('32', text),
    red: text => paint('31', text),
    yellow: text => paint('33', text),
  };
}
export const outStyle = makeStyle(process.stdout);
export const errStyle = makeStyle(process.stderr);

// Render hints like help rows under a bold title: each `coder ...` command in `paint`, its label
// dimmed beside it in one aligned column; lines without a command stay dimmed prose. Callers add the leading blank line.
export function formatHints(
  hints: string[],
  style: Style = errStyle,
  paint = style.blue,
  title = 'Related',
): string {
  const parts = hints.map(line => {
    // The command starts at `coder ...`, or at the env assignments in front of it.
    const at = line.search(/(?:\b[A-Z][A-Z0-9_]*=\S+\s+)*coder /);
    if (at === -1) return { text: line };
    const label = line.slice(0, at).trim().replace(/:$/, '');
    return { command: line.slice(at), label: label.charAt(0).toLowerCase() + label.slice(1) };
  });
  const width = Math.max(0, ...parts.map(p => p.command?.length ?? 0)) + 2;
  return [
    style.bold(`${title}:`),
    ...parts.map(p =>
      p.command === undefined
        ? `  ${style.dim(p.text)}`
        : `  ${paint(p.label ? p.command.padEnd(width) : p.command)}${style.dim(p.label)}`,
    ),
  ].join('\n');
}

// fail(message) | fail(message, exitCode) | fail(message, { code, hint })
// Each hint is a dimmed, indented next-step line (blank line before), with its
// `coder ...` command bolded.
export function fail(message: string, opts: FailOptions = {}): never {
  const code = typeof opts === 'number' ? opts : (opts.code ?? 1);
  const hint = typeof opts === 'object' ? opts.hint : null;
  const hints = hint == null ? [] : Array.isArray(hint) ? hint : [hint];
  process.stderr.write(`${errStyle.red(message)}\n`);
  if (hints.length) {
    process.stderr.write(`\n${formatHints(hints, errStyle)}\n`);
  }
  process.exit(code);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// Human-view JSON: keys light, primitive values blue, structure plain. Display
// only. Machine output always goes through printJson unstyled.
export function formatJson(value: unknown, style: Style = outStyle): string {
  const raw = JSON.stringify(value, null, 2) ?? 'null';
  return raw
    .split('\n')
    .map(line =>
      line
        .replace(/"((?:[^"\\]|\\.)*)":/g, (_m, key: string) => `${style.light(`"${key}"`)}:`)
        .replace(
          /: (-?\d[\d.eE+-]*|true|false|null)(,?)$/,
          (_m, v: string, comma: string) => `: ${style.blue(v)}${comma}`,
        ),
    )
    .join('\n');
}

// Compact human duration: 45s, 12m, 2h3m.
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// Elapsed time as a fixed-width gutter stamp: 0:04, 12:05, 1:02:33.
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// Compact token count: 950, 12.3k, 1.2M.
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// One-line token summary: "48.2k (in 45.1k · cached 38.0k · out 3.1k) on sol".
// Always names the model. Token counts are only comparable per model.
export function formatTokens(tokens: TokenUsage, model?: string | null): string {
  const parts = [
    `in ${formatTokenCount(tokens.input)}`,
    ...(tokens.cachedInput ? [`cached ${formatTokenCount(tokens.cachedInput)}`] : []),
    `out ${formatTokenCount(tokens.output)}`,
  ];
  return `${formatTokenCount(tokens.total)} (${parts.join(' · ')}) on ${model || 'default model'}`;
}

// Token usage while a turn is still running: context in flight plus what the
// model has written so far. Short enough to sit on a status line.
export function formatTokensCompact(tokens: TokenUsage): string {
  return `ctx ${formatTokenCount(tokens.input + tokens.cachedInput)} · out ${formatTokenCount(tokens.output)}`;
}

// Fixed-width table cell: pad short values, clip long ones with an ellipsis so
// an oversized value can't shift the columns after it.
export function clipPad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

export interface Column<T> {
  header: string;
  value: (row: T) => string;
  /** Styles the padded cell; the last column is never padded or clipped. */
  paint?: (cell: string, row: T) => string;
  max?: number;
}
export interface TableGroup<T> {
  /** Printed above the group's rows; groups are separated by a blank line. */
  header?: string;
  rows: T[];
}

// Aligned table: widths follow the values (capped by `max`), header bold and
// light, cells two spaces apart. Groups are opt-in via `{ header, rows }`.
export interface TableOptions {
  style?: Style;
  /** Box-drawing frame with a rule between rows; cells wrap to the terminal width. */
  border?: boolean;
  width?: number;
}

// Wrap text to `width` at spaces (after a comma when possible); a single long
// token is hard-split.
function wrapCell(text: string, width: number): string[] {
  const lines: string[] = [];
  let rest = text;
  while (rest.length > width) {
    let cut = rest.lastIndexOf(' ', width);
    if (cut <= 0) cut = width;
    lines.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  lines.push(rest);
  return lines;
}

export function renderTable<T>(
  columns: Column<T>[],
  rows: T[],
  options?: Style | TableOptions,
): string;
export function renderTable<T>(
  columns: Column<T>[],
  groups: TableGroup<T>[],
  options?: Style | TableOptions,
): string;
export function renderTable<T>(
  columns: Column<T>[],
  input: T[] | TableGroup<T>[],
  options: Style | TableOptions = {},
): string {
  const opts: TableOptions = 'bold' in options ? { style: options as Style } : options;
  const style = opts.style ?? outStyle;
  const groups: TableGroup<T>[] =
    input.length &&
    typeof input[0] === 'object' &&
    input[0] !== null &&
    'rows' in (input[0] as object)
      ? (input as TableGroup<T>[])
      : [{ rows: input as T[] }];
  const rows = groups.flatMap(g => g.rows);
  const last = columns.length - 1;
  const widths = columns.map((c, i) =>
    i === last && !opts.border
      ? 0
      : Math.min(c.max ?? 40, Math.max(c.header.length, ...rows.map(r => c.value(r).length))),
  );
  if (opts.border) {
    // The last column gets what the terminal has left, so long lists wrap instead of clip.
    const total = opts.width ?? termCols() ?? 120;
    const used = widths.slice(0, last).reduce((n, w) => n + w + 3, 0) + 4;
    const full = Math.max(
      columns[last]!.header.length,
      ...rows.map(r => columns[last]!.value(r).length),
    );
    widths[last] = Math.max(columns[last]!.header.length, Math.min(full, total - used));
  }
  const rule = (l: string, m: string, r: string) =>
    style.light(`${l}${widths.map(w => '─'.repeat(w + 2)).join(m)}${r}`);
  const line = (cells: string[]) =>
    opts.border
      ? `${style.light('│')} ${cells.join(` ${style.light('│')} `)} ${style.light('│')}`
      : cells.join('  ');
  const pad = (text: string, i: number) =>
    i === last && !opts.border ? text : clipPad(text, widths[i]!);
  const out: string[] = [];
  if (opts.border) out.push(rule('┌', '┬', '┐'));
  out.push(style.bold(style.light(line(columns.map((c, i) => pad(c.header, i))))));
  if (opts.border) out.push(rule('├', '┼', '┤'));
  groups.forEach((g, gi) => {
    if (gi && !opts.border) out.push('');
    if (g.header) out.push(opts.border ? `${style.light('│')} ${g.header}` : g.header);
    g.rows.forEach((r, ri) => {
      if (opts.border && (ri || g.header)) out.push(rule('├', '┼', '┤'));
      const cells = columns.map((c, i) =>
        opts.border ? wrapCell(c.value(r), widths[i]!) : [c.value(r)],
      );
      const height = Math.max(...cells.map(c => c.length));
      for (let k = 0; k < height; k++)
        out.push(
          line(
            columns.map((c, i) => {
              const cell = pad(cells[i]![k] ?? '', i);
              return c.paint && cells[i]![k] !== undefined ? c.paint(cell, r) : cell;
            }),
          ),
        );
    });
  });
  if (opts.border) out.push(rule('└', '┴', '┘'));
  return `${out.join('\n')}\n`;
}

// Result-list row shared by setup-host and upgrade: two-space indent, bold
// status glyph matching the flow tree's ✔/✘.
export function good(text: string): string {
  return `  ${outStyle.bold(outStyle.green('✔'))} ${text}`;
}
export function bad(text: string): string {
  return `  ${outStyle.bold(outStyle.red('✘'))} ${text}`;
}

// Color a task status: green for live, red for failed/cancelled, blue for
// completed (cyan is taken by task ids), dim for the rest (queued). Pads to
// `width` first so ANSI codes don't break alignment.
export function paintStatus(status: string, width = 0): string {
  const text = status.padEnd(width);
  if (status === 'running') {
    return outStyle.green(text);
  }
  if (status === 'waiting-approval') {
    return outStyle.yellow(text);
  }
  if (status === 'failed' || status === 'cancelled') {
    return outStyle.red(text);
  }
  if (status === 'completed') {
    return outStyle.blue(text);
  }
  return outStyle.dim(text);
}
