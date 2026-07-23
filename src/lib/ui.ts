/**
 * Shared CLI presentation helpers: ANSI styling, structured failure, JSON
 * output, and the task-reference resolver every task command leans on.
 */
import path from 'node:path';
import process from 'node:process';

import { findJob } from './state.js';
import type { Job, Style, TokenUsage } from './types.js';

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
    blue: text => paint('34', text),
    bold: text => paint('1', text),
    cyan: text => paint('36', text),
    dim: text => paint('38;5;246', text),
    light: text => paint('38;5;249', text),
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
// only — machine output always goes through printJson unstyled.
export function formatJson(value: unknown, style: Style = outStyle): string {
  const raw = JSON.stringify(value, null, 2) ?? 'null';
  return raw
    .split('\n')
    .map(line =>
      line
        .replace(/"((?:[^"\\]|\\.)*)":/g, (_m, key: string) => `${style.light(`"${key}"`)}:`)
        .replace(/: (-?\d[\d.eE+-]*|true|false|null)(,?)$/, (_m, v: string, comma: string) => `: ${style.blue(v)}${comma}`),
    )
    .join('\n');
}

// Milliseconds since an ISO timestamp (0 if unparseable).
export function ageMs(iso?: string): number {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0;
}

// Compact human duration: 45s, 12m, 2h3m.
export function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

// Compact token count: 950, 12.3k, 1.2M.
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

// One-line token summary: "48.2k (in 45.1k · cached 38.0k · out 3.1k) on spark".
// Always names the model — token counts are only comparable per model.
export function formatTokens(tokens: TokenUsage, model?: string | null): string {
  const parts = [
    `in ${formatTokenCount(tokens.input)}`,
    ...(tokens.cachedInput ? [`cached ${formatTokenCount(tokens.cachedInput)}`] : []),
    `out ${formatTokenCount(tokens.output)}`,
  ];
  return `${formatTokenCount(tokens.total)} (${parts.join(' · ')}) on ${model || 'default model'}`;
}

// How much of the task prompt the text views show (full prompt is in --json).
/**
 * The final-answer line for a finished task: the final message when there is
 * one, else the recorded error (result's, falling back to the job's), else the
 * caller's placeholder.
 */
export function finalMessageLine(
  result: { finalMessage?: string; error?: { message?: string } } | null | undefined,
  jobError: string | undefined,
  fallback: string,
  style: Style = outStyle,
): string {
  const errorMessage = result?.error?.message ?? jobError;
  return (
    result?.finalMessage || (errorMessage ? `${style.red('error:')} ${errorMessage}` : fallback)
  );
}

// A long prompt keeps its opening and its closing (where the actual ask
// usually lives) and drops the middle.
const PROMPT_HEAD_CHARS = 500;
const PROMPT_TAIL_CHARS = 500;
export const PROMPT_PREVIEW_CHARS = PROMPT_HEAD_CHARS + PROMPT_TAIL_CHARS;

// Dim, indented prompt block for result/stream: 'prompt:' plus the prompt's
// lines, capped so a huge prompt doesn't drown the output. Over the cap, the
// middle is elided so both the opening and the final instructions stay visible.
export function promptBlock(prompt: string, style: Style = outStyle): string[] {
  const indent = (text: string) => text.split('\n').map(line => `  ${style.dim(line)}`);
  if (prompt.length <= PROMPT_PREVIEW_CHARS) {
    return [style.dim('prompt:'), ...indent(prompt)];
  }
  // The elision marker is a shade brighter than the prompt text, so it can't
  // be mistaken for prompt content.
  return [
    style.dim('prompt:'),
    ...indent(prompt.slice(0, PROMPT_HEAD_CHARS).trimEnd()),
    style.light(`  … <${prompt.length - PROMPT_PREVIEW_CHARS} chars trimmed> …`),
    ...indent(prompt.slice(-PROMPT_TAIL_CHARS).trimStart()),
  ];
}

// "agent/model/effort" for the header agent line, dropping unset parts
// (e.g. "claude/opus/medium", "codex", "claude/opus").
export function formatAgentSpec(job: {
  agent?: string | null;
  model?: string | null;
  effort?: string | null;
}): string {
  return [job.agent ?? '-', job.model, job.model ? job.effort : null].filter(Boolean).join('/');
}

// Header lines for the task's dispatch options (permissions, cwd) — shown by
// result/stream alongside agent/model so a glance answers "how was this
// dispatched". Only options actually set are listed.
export function jobOptionLines(
  job: { permissions?: string | null; cwd?: string },
  style: Style = outStyle,
): string[] {
  const opts: Array<[string, string]> = [];
  if (job.permissions) opts.push(['perms', job.permissions]);
  if (job.cwd) opts.push(['cwd', job.cwd]);
  return opts.map(([k, v]) => `${style.dim(k.padEnd(8))} ${v}`);
}

// How much of a single progress-log step the text views show (full entries are
// in --json / the job log).
export const STEP_PREVIEW_CHARS = 300;

// Cap a step message for display, noting how much was cut. Pass `plain: true`
// for machine-readable contexts (JSON lines) where the marker must stay unstyled.
export function trimStep(
  message: string,
  limit = STEP_PREVIEW_CHARS,
  { plain = false, style = outStyle }: { plain?: boolean; style?: Style } = {},
): string {
  if (message.length <= limit) return message;
  const marker = `<${message.length - limit} more chars>`;
  return `${message.slice(0, limit)} ${plain ? marker : style.dim(marker)}`;
}

// A running/queued task idle this long with no pending approval is flagged as
// possibly stalled (advisory — a silent hang; streamed output counts as
// activity via the heartbeat).
export const STALL_MS = 10 * 60_000;

// Below this, a running task's idle age isn't worth showing at all.
export const IDLE_SHOW_MS = 2 * 60_000;

// Fixed-width table cell: pad short values, clip long ones with an ellipsis so
// an oversized value can't shift the columns after it.
export function clipPad(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, width - 1)}…` : text.padEnd(width);
}

// Color a task status: green for live, red for failed/cancelled, blue for
// completed (cyan is taken by task ids), dim for the rest (queued). Pads to
// `width` first so ANSI codes don't break alignment.
export function paintStatus(status: string, width = 0): string {
  const text = status.padEnd(width);
  if (status === 'running') {
    return outStyle.green(text);
  }
  if (status === 'failed' || status === 'cancelled') {
    return outStyle.red(text);
  }
  if (status === 'completed') {
    return outStyle.blue(text);
  }
  return outStyle.dim(text);
}

// Exit code for "a --wait stopped because the task is waiting on an approval."
// Coder-specific (4), deliberately not 2 — 2 is the conventional CLI usage-error
// code. See the exit-code contract in cmd/task.ts.
export const EXIT_APPROVAL_NEEDED = 4;

// Surface a pending approval hit during a --wait, then exit — so a background/
// host caller is re-invoked to answer it (`coder approve`) and re-wait, instead
// of blocking silently until the worker's 120s auto-decline.
export function surfaceApproval(
  taskId: string,
  approval: { id: string; summary: string },
  json = false,
): never {
  if (json) {
    printJson({ taskId, status: 'awaiting-approval', approval });
  } else {
    process.stdout.write(`Approval needed for task ${taskId}: ${approval.summary}\n`);
    process.stderr.write(
      `\n${formatHints(
        [
          `Approve: coder approve ${taskId} ${approval.id}`,
          `Deny: coder approve ${taskId} ${approval.id} --deny`,
          `Then: coder task result ${taskId} --wait`,
        ],
        errStyle,
      )}\n`,
    );
  }
  process.exit(EXIT_APPROVAL_NEEDED);
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
