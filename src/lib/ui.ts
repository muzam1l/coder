/**
 * Shared CLI presentation helpers: ANSI styling, structured failure, JSON
 * output, and the task-reference resolver every task command leans on.
 */
import path from 'node:path';
import process from 'node:process';

import { findJob } from './state.js';
import type { Job, Style } from './types.js';

/** Parsed CLI options. Values are untyped: flags carry strings or booleans. */
export type Options = Record<string, any>;

/** Failure detail: an exit code, or a code plus dimmed next-step hint line(s). */
export type FailOptions = number | { code?: number; hint?: string | string[] };

// ANSI stylers, one per stream (TTY-gated, honoring NO_COLOR). Computed once:
// isTTY is stable for the process lifetime.
export function makeStyle(stream: NodeJS.WriteStream): Style {
  const tty = stream.isTTY && !process.env.NO_COLOR;
  const paint = (code: string, text: string) => (tty ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    bold: text => paint('1', text),
    cyan: text => paint('36', text),
    dim: text => paint('38;5;245', text),
    green: text => paint('32', text),
    red: text => paint('31', text),
  };
}
export const outStyle = makeStyle(process.stdout);
export const errStyle = makeStyle(process.stderr);

// Render a block of hint lines: each indented, its label dimmed and its
// `coder ...` command bolded, with labels padded to a common column. Does NOT
// include the leading blank line — callers add it (always precede hints with one).
export function formatHints(hints: string[], style: Style = errStyle): string {
  const parts = hints.map(line => {
    const at = line.indexOf('coder ');
    return at === -1 ? { label: line, cmd: '' } : { label: line.slice(0, at), cmd: line.slice(at) };
  });
  const width = Math.max(0, ...parts.map(p => p.label.length));
  return parts
    .map(({ label, cmd }) =>
      cmd ? `  ${style.dim(label.padEnd(width))}${style.bold(cmd)}` : `  ${style.dim(label)}`,
    )
    .join('\n');
}

// fail(message) | fail(message, exitCode) | fail(message, { code, hint })
// Each hint is a dimmed, indented next-step line (blank line before), with its
// `coder ...` command bolded.
export function fail(message: string, opts: FailOptions = {}): never {
  const code = typeof opts === 'number' ? opts : (opts.code ?? 1);
  const hint = typeof opts === 'object' ? opts.hint : null;
  const hints = hint == null ? [] : Array.isArray(hint) ? hint : [hint];
  process.stderr.write(`${message}\n`);
  if (hints.length) {
    process.stderr.write(`\n${formatHints(hints, errStyle)}\n`);
  }
  process.exit(code);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

// Color a task status: green for live/succeeded, red for failed/cancelled,
// dim for queued. Pads to `width` first so ANSI codes don't break alignment.
export function paintStatus(status: string, width = 0): string {
  const text = status.padEnd(width);
  if (status === 'running' || status === 'completed') {
    return outStyle.green(text);
  }
  if (status === 'failed' || status === 'cancelled') {
    return outStyle.red(text);
  }
  return outStyle.dim(text);
}

// Reject positional arguments a command doesn't accept. `help` is the canonical
// id used in the follow-up hint (e.g. 'task list', 'task result').
export function rejectExtraArgs(positionals: string[], max: number, help: string): void {
  if (positionals.length > max) {
    const extra = positionals.slice(max);
    fail(`Unexpected argument${extra.length > 1 ? 's' : ''}: ${extra.join(' ')}`, {
      hint: `Help: coder ${help} --help`,
    });
  }
}

// Every command accepts --cwd to target a workspace other than the current one.
export function resolveCwd(options: Options): string {
  return options.cwd ? path.resolve(String(options.cwd)) : process.cwd();
}

export function requireJob(cwd: string, reference?: string): Job {
  const job = findJob(cwd, reference);
  if (!job) {
    fail(reference ? `No task found for "${reference}".` : 'No tasks found for this workspace.', {
      hint: reference
        ? ['List tasks: coder task list', 'Start one: coder run "<text>"']
        : ['Start one: coder run "<text>"'],
    });
  }
  return job;
}
