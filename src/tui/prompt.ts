/** Interactive pickers for a TTY: a scrolling, filterable list with single or multi select. */
import { spawn } from 'node:child_process';
import process from 'node:process';

import { outStyle } from './output';
import { termCols, visibleWidth } from './live';

// Screen rows a line occupies once the terminal wraps it.
function screenRows(line: string): number {
  const cols = termCols() ?? 80;
  return Math.max(1, Math.ceil(visibleWidth(line) / cols));
}

export interface PickOption<T extends string = string> {
  value: T;
  label?: string;
  hint?: string;
  /** Optional text edited on the row with tab, e.g. a regex the event must match. */
  input?: {
    label: string;
    /** Prefilled text, shown on the row from the start. */
    value?: string;
    /** Shown on the row while it has no value. */
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  };
}

export interface PickResult<T extends string> {
  values: T[];
  /** Text entered for options that declare `input`, by value; empty entries are omitted. */
  inputs: Partial<Record<T, string>>;
}

export interface PickOptions<T extends string> {
  title: string;
  /** One line under the title saying what the answer decides. */
  hint?: string;
  options: PickOption<T>[];
  multi?: boolean;
  selected?: T[];
  /** Rows visible at once before the list scrolls. */
  window?: number;
  /** Multi only: refuse to confirm with nothing picked. */
  required?: boolean;
}

const KEYS = {
  tab: ['\t'],
  up: ['\x1b[A', 'k'],
  down: ['\x1b[B', 'j'],
  enter: ['\r', '\n'],
  space: [' '],
  backspace: ['\x7f', '\b'],
  cancel: ['\x03', '\x1b'],
};

export class PromptCancelled extends Error {
  constructor() {
    super('Cancelled.');
  }
}

export function canPrompt(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

// Split a stdin chunk into keys: a CSI sequence (ESC [ ... final byte) is one key, so is a lone
// ESC, and every other character stands alone.
function tokenize(text: string): string[] {
  const keys: string[] = [];
  for (let i = 0; i < text.length;) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      let j = i + 2;
      while (j < text.length && !/[@-~]/.test(text[j]!)) j++;
      keys.push(text.slice(i, j + 1));
      i = j + 1;
    } else {
      keys.push(text[i]!);
      i++;
    }
  }
  return keys;
}

const pending: string[] = [];
function readKey(): Promise<string> {
  if (pending.length) return Promise.resolve(pending.shift()!);
  return new Promise(resolve => {
    const onData = (data: Buffer) => {
      process.stdin.off('data', onData);
      const keys = tokenize(data.toString('utf8'));
      pending.push(...keys.slice(1));
      resolve(keys[0]!);
    };
    process.stdin.on('data', onData);
  });
}

export async function pick<T extends string>(opts: PickOptions<T>): Promise<T[]> {
  return (await pickDetailed(opts)).values;
}

export async function pickDetailed<T extends string>(opts: PickOptions<T>): Promise<PickResult<T>> {
  const s = outStyle;
  const out = process.stdout;
  const window = Math.max(3, opts.window ?? 8);
  const chosen = new Set<T>(opts.selected ?? []);
  let cursor = Math.max(
    0,
    opts.options.findIndex(o => chosen.has(o.value)),
  );
  let top = 0;
  let filter = '';
  let lines = 0;
  let error = '';
  const inputs = new Map<T, string>(
    opts.options.flatMap(o => (o.input?.value ? [[o.value, o.input.value] as [T, string]] : [])),
  );
  let editing = false;
  const hasInput = opts.options.some(o => o.input);

  const visible = () =>
    opts.options.filter(
      o =>
        !filter ||
        o.value.toLowerCase().includes(filter.toLowerCase()) ||
        (o.label ?? '').toLowerCase().includes(filter.toLowerCase()),
    );

  const render = (final = false) => {
    if (lines) out.write(`\x1b[${lines}A\x1b[J`);
    const items = visible();
    cursor = Math.min(cursor, Math.max(0, items.length - 1));
    if (cursor < top) top = cursor;
    if (cursor >= top + window) top = cursor - window + 1;
    const edit = hasInput ? ' · tab to edit' : '';
    const keys = editing
      ? 'type to edit · enter when done · esc to discard'
      : opts.multi
        ? `↑↓ to move · space to toggle · type to filter${edit} · enter to continue · esc to cancel`
        : `↑↓ to move · type to filter${edit} · enter to choose · esc to cancel`;
    const rows = [`${s.bold(opts.title)}  ${s.dim(keys)}`];
    if (final) {
      const picked =
        [...chosen].map(v => (inputs.get(v) ? `${v} (${inputs.get(v)})` : v)).join(', ') || '-';
      out.write(`${s.green('✔')} ${s.bold(opts.title)}  ${s.cyan(picked)}\n\n`);
      lines = 0;
      return;
    }
    if (opts.hint) rows.push(`  ${s.light(opts.hint)}`);
    if (opts.multi)
      rows.push(`  ${s.light('selected:')} ${[...chosen].join(', ') || s.dim('none')}`);
    if (filter) rows.push(`  ${s.light('filter:')} ${filter}${s.dim('▏')}`);
    if (!items.length) rows.push(`  ${s.dim('no matches')}`);
    if (top > 0) rows.push(`  ${s.dim(`↑ ${top} more`)}`);
    const width = Math.max(0, ...items.map(o => (o.label ?? o.value).length));
    items.slice(top, top + window).forEach((o, i) => {
      const at = top + i === cursor;
      const mark = opts.multi ? (chosen.has(o.value) ? '◉' : '◯') : at ? '●' : '○';
      const label = (o.label ?? o.value).padEnd(width);
      const text = `${mark} ${label}${o.hint ? `  ${s.light(o.hint)}` : ''}`;
      const typed = inputs.get(o.value) ?? '';
      const field =
        o.input && (typed || (at && editing))
          ? `  ${s.light(`${o.input.label}:`)} ${typed}${at && editing ? s.dim('▏') : ''}`
          : o.input && at && o.input.placeholder
            ? `  ${s.dim(o.input.placeholder)}`
            : '';
      rows.push(`${at ? s.cyan('❯ ') : '  '}${at ? s.cyan(text) : text}${field}`);
    });
    const below = items.length - (top + window);
    if (below > 0) rows.push(`  ${s.dim(`↓ ${below} more`)}`);
    if (error) rows.push(`  ${s.red(error)}`);
    out.write(`${rows.join('\n')}\n`);
    lines = rows.reduce((n, row) => n + screenRows(row), 0);
  };

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);
  stdin.resume();
  out.write('\x1b[?25l');
  try {
    render();
    for (;;) {
      const key = await readKey();
      error = '';
      const items = visible();
      const current = items[cursor];
      if (editing && current?.input) {
        const typed = inputs.get(current.value) ?? '';
        if (KEYS.cancel.includes(key)) {
          inputs.delete(current.value);
          editing = false;
        } else if (KEYS.enter.includes(key)) {
          const problem = typed ? current.input.validate?.(typed) : undefined;
          if (problem) error = problem;
          else editing = false;
        } else if (KEYS.backspace.includes(key)) inputs.set(current.value, typed.slice(0, -1));
        else if (key.length === 1 && key >= ' ') inputs.set(current.value, typed + key);
        render();
        continue;
      }
      if (KEYS.cancel.includes(key)) throw new PromptCancelled();
      if (KEYS.tab.includes(key) && current?.input) {
        editing = true;
        if (opts.multi) chosen.add(current.value);
        render();
        continue;
      }
      if (KEYS.up.includes(key) && !(key === 'k' && filter)) cursor = Math.max(0, cursor - 1);
      else if (KEYS.down.includes(key) && !(key === 'j' && filter))
        cursor = Math.min(items.length - 1, cursor + 1);
      else if (KEYS.enter.includes(key)) {
        if (!opts.multi && items[cursor]) {
          chosen.clear();
          chosen.add(items[cursor]!.value);
        }
        if (opts.required && !chosen.size) {
          error = 'Pick at least one.';
        } else {
          render(true);
          const picked: Partial<Record<T, string>> = {};
          for (const [value, text] of inputs) if (text && chosen.has(value)) picked[value] = text;
          return { values: [...chosen], inputs: picked };
        }
      } else if (opts.multi && KEYS.space.includes(key) && items[cursor]) {
        const value = items[cursor]!.value;
        if (chosen.has(value)) chosen.delete(value);
        else chosen.add(value);
      } else if (KEYS.backspace.includes(key)) filter = filter.slice(0, -1);
      else if (key.length === 1 && key >= ' ' && key !== ' ') {
        filter += key;
        cursor = 0;
        top = 0;
      }
      render();
    }
  } finally {
    out.write('\x1b[?25h');
    stdin.setRawMode(Boolean(wasRaw));
    stdin.pause();
  }
}

/** Free-text line with a default; `validate` returns an error to show inline and ask again. */
export async function ask(
  title: string,
  fallback = '',
  validate?: (value: string) => string | undefined,
  hint?: string,
): Promise<string> {
  const s = outStyle;
  if (hint) process.stdout.write(`${s.bold(title)}\n  ${s.light(hint)}\n`);
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  let lines = hint ? screenRows(title) + screenRows(`  ${hint}`) : 0;
  try {
    for (;;) {
      const prompt = hint
        ? `  ${fallback ? s.dim(`[${fallback}] `) : ''}`
        : `${s.bold(title)} ${fallback ? s.dim(`[${fallback}] `) : ''}`;
      const entered = await rl.question(prompt);
      const answer = entered.trim() || fallback;
      lines += screenRows(
        `${hint ? '  ' : `${title} `}${fallback ? `[${fallback}] ` : ''}${answer}`,
      );
      const error = validate?.(answer);
      if (!error) {
        // Collapse the question to one line, like a finished pick.
        process.stdout.write(
          `\x1b[${lines}A\x1b[J${s.green('✔')} ${s.bold(title)}  ${s.cyan(answer || '-')}\n\n`,
        );
        return answer;
      }
      process.stdout.write(`  ${s.red(error)}\n`);
      lines += screenRows(`  ${error}`);
    }
  } finally {
    rl?.close();
  }
}

/** Opens the default browser, or the one `BROWSER` names; `BROWSER=none`, CI and tests open nothing. False when nothing was opened. */
export function openUrl(url: string): boolean {
  const browser = process.env.BROWSER;
  if (browser === 'none' || process.env.CI || process.env.NODE_ENV === 'test') return false;
  const [command, args] = browser
    ? process.platform === 'darwin'
      ? ['open', ['-a', browser, url]]
      : [browser, [url]]
    : process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref();
    return true;
  } catch {
    return false;
  }
}
