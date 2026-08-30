/**
 * Shared CLI presentation helpers: ANSI styling, structured failure, JSON
 * output, and the task-reference resolver every task command leans on.
 */
import path from 'node:path';
import process from 'node:process';

import { findJob } from './state.js';
import type { JobLogEntry } from './state.js';
import { ACTIVE_STATUSES } from './types.js';
import type { Job, Style, TokenUsage } from './types.js';

/** Parsed CLI options. Values are untyped: flags carry strings or booleans. */
export type Options = Record<string, any>;

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
    light: text => paint('38;5;249', text),
    green: text => paint('32', text),
    red: text => paint('31', text),
    yellow: text => paint('33', text),
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

// One-line token summary: "48.2k (in 45.1k · cached 38.0k · out 3.1k) on terra".
// Always names the model — token counts are only comparable per model.
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

// Dim, indented prompt block: 'prompt:' plus the prompt's lines. Result views
// use the compact preview by default, while watch views can opt into the full
// prompt they are following.
export function promptBlock(
  prompt: string,
  style: Style = outStyle,
  { truncate = true }: { truncate?: boolean } = {},
): string[] {
  const indent = (text: string) => text.split('\n').map(line => `  ${style.dim(line)}`);
  if (!truncate || prompt.length <= PROMPT_PREVIEW_CHARS) {
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

/**
 * When a task started and — once it's over — when it ended and how long it
 * ran. The wall-clock answer to "is this worth waiting for", shown next to the
 * status by every view that has a job in hand.
 */
export function taskTimeNote(
  job: { createdAt?: string; completedAt?: string },
  running: boolean,
): string {
  if (running) {
    return job.createdAt ? `started ${formatAge(ageMs(job.createdAt))} ago` : '';
  }
  const took =
    job.createdAt && job.completedAt
      ? Date.parse(job.completedAt) - Date.parse(job.createdAt)
      : null;
  return [
    job.completedAt ? `finished ${formatAge(ageMs(job.completedAt))} ago` : '',
    took !== null && took >= 0 ? `took ${formatAge(took)}` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/**
 * The identity block every task view opens with: what ran, how it was
 * dispatched, how long it has been going, and what it has spent. One
 * definition so `result` and `watch` can never drift apart.
 */
export function taskHeaderLines(
  job: Job,
  {
    status,
    tokens,
    tokenModel,
    files,
    live = false,
    style = outStyle,
  }: {
    status: string;
    tokens?: TokenUsage | null;
    tokenModel?: string | null;
    /** Files the task touched, listed once it has them. */
    files?: string[] | null;
    /** Tokens are a running total from a turn still in flight, not a receipt. */
    live?: boolean;
    style?: Style;
  },
): string[] {
  const running = ACTIVE_STATUSES.includes(job.status) || status === 'waiting-approval';
  const note = taskTimeNote(job, running);
  const label = (text: string) => style.dim(text.padEnd(8));
  return [
    `${label('task')} ${style.cyan(job.id)}`,
    ...(job.name ? [`${label('name')} ${job.name}`] : []),
    `${label('status')} ${paintStatus(status)}${note ? ` ${style.dim(`(${note})`)}` : ''}`,
    `${label('agent')} ${formatAgentSpec(job)}`,
    ...jobOptionLines(job, style),
    ...(tokens
      ? [
          `${label('tokens')} ${
            live ? formatTokensCompact(tokens) : formatTokens(tokens, tokenModel ?? job.model)
          }${live ? style.dim(' (so far)') : ''}`,
        ]
      : []),
    ...(files?.length ? [`${label('files')} ${files.join(', ')}`] : []),
  ];
}

/**
 * The closing counterpart to taskHeaderLines: what the header couldn't know
 * yet — how it ended, what it cost, what it touched. Deliberately not a second
 * copy of the header: identity is stated once, at the top.
 */
export function taskSummaryLines(
  job: Job,
  {
    tokens,
    tokenModel,
    files,
    /** The status changed while we watched, so it is news worth restating. */
    statusChanged = true,
    style = outStyle,
  }: {
    tokens?: TokenUsage | null;
    tokenModel?: string | null;
    files?: string[] | null;
    statusChanged?: boolean;
    style?: Style;
  },
): string[] {
  const label = (text: string) => style.dim(text.padEnd(8));
  const took =
    job.createdAt && job.completedAt
      ? Date.parse(job.completedAt) - Date.parse(job.createdAt)
      : null;
  return [
    ...(statusChanged
      ? [
          `${label('status')} ${paintStatus(job.status)}${
            took !== null && took >= 0 ? ` ${style.dim(`(took ${formatAge(took)})`)}` : ''
          }`,
        ]
      : []),
    ...(tokens ? [`${label('tokens')} ${formatTokens(tokens, tokenModel ?? job.model)}`] : []),
    ...(files?.length ? [`${label('files')} ${files.join(', ')}`] : []),
  ];
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

// Display caps for a tool's output. Assistant prose, steers and errors are
// never capped — they're the point of the transcript — so only command output
// and thinking answer to these.
export const OUTPUT_PREVIEW_CHARS = 500;
const OUTPUT_PREVIEW_LINES = 6;

// Display budgets, in terminal rows, for the entries that are wrapped rather
// than capped — a one-row clip on a line this long hides the half that says
// what it did. --trim lifts them.
const TOOL_ROWS = 2;
const REASONING_ROWS = 3;
const STATUS_ROWS = 3;

// Left gutter: elapsed-since-dispatch stamp, then a one-column kind glyph.
const GUTTER_WIDTH = 5;
const BODY_INDENT = ' '.repeat(GUTTER_WIDTH + 3);
// Floor for the wrapped body on a terminal too narrow to hold gutter and text
// both; below this it stops being a transcript either way.
const MIN_BODY_WIDTH = 24;

const KIND_GLYPHS: Record<string, string> = {
  assistant: '●',
  reasoning: '✻',
  tool: '→',
  'tool-result': ' ',
  usage: '·',
  status: '·',
  info: '·',
  error: '✘',
  steer: '⚑',
};

function isApproval(kind: string): boolean {
  return kind.includes('approval') || kind === 'sidecar-decision' || kind === 'auto-review';
}

// The workspace is named once in the header; repeating it on every tool line
// buys nothing and costs most of the terminal width.
function stripCwd(text: string, cwd?: string): string {
  if (!cwd) return text;
  // A path under the workspace loses the prefix; the workspace itself becomes
  // the dot it already is from the task's point of view.
  return text.split(`${cwd}/`).join('').split(cwd).join('.');
}

// Approval, sidecar and auto-review entries carry structured fields rather than
// a message. Split them the way a tool call is split from its output: the
// verdict is what a transcript is scanned for, the reason is prose about it.
// `subject` is the tool line the approval is about, when it is already on
// screen — no point repeating a command that sits one row above.
function describeApproval(
  entry: JobLogEntry,
  subject: string,
  cwd?: string,
): { head: string; reason: string } {
  const kind = String(entry.kind ?? '');
  const label = kind === 'sidecar-decision' ? 'sidecar' : kind === 'auto-review' ? 'auto-review' : 'approval';
  const decision = String(entry.decision ?? '');
  const risk = entry.riskLevel ? `(${String(entry.riskLevel)} risk)` : '';
  const summaryText = stripCwd(entry.summary ? String(entry.summary) : '', cwd);
  // Summaries read "run command: <cmd>" / "Edit: <path>"; the part after the
  // colon is what the tool line already showed.
  const target = summaryText.slice(summaryText.indexOf(': ') + 2);
  const shown = summaryText && target && subject.includes(target) ? '' : summaryText;
  const method = shown ? '' : String(entry.method ?? '');
  return {
    head: `${[label, decision, risk, method].filter(Boolean).join(' ')}${shown ? ` · ${shown}` : ''}`,
    reason: stripCwd(entry.reason ? String(entry.reason) : '', cwd),
  };
}

// Shade one row. Output carries the program's own colour often enough (rg,
// cargo and friends colour whenever they think they are on a tty), and the
// reset that ends it would end the shading with it, leaving the rest of the row
// at the terminal default — brighter than either grey. Re-arm after each reset,
// so the program keeps its colour and everything around it stays shaded.
function shade(line: string, paint: (text: string) => string): string {
  const open = /^\x1b\[[0-9;]*m/.exec(paint(''))?.[0];
  return paint(open && line.includes(RESET) ? line.split(RESET).join(`${RESET}${open}`) : line);
}
const RESET = '\x1b[0m';

// Cap text by characters and (unless the caller asked for a specific budget)
// by lines, noting in both cases how much was withheld. Markers are a shade
// brighter than the output they stand in for, so they can't be misread as it.
// Shading is applied per row, and to text and marker separately: a style
// spanning a newline would colour the body indent too, and one spanning a
// marker would end at the marker's reset.
function capBody(
  text: string,
  chars: number,
  lines: number,
  style: Style,
  paint: (line: string) => string = style.dim,
): string {
  if (!text) return '';
  const rows = (text.length > chars ? text.slice(0, chars) : text)
    .split('\n')
    .map(line => shade(line, paint));
  if (text.length > chars) {
    rows[rows.length - 1] += ` ${style.light(`<${text.length - chars} more chars>`)}`;
  }
  if (rows.length > lines) {
    return [...rows.slice(0, lines), style.light(`… +${rows.length - lines} more lines`)].join('\n');
  }
  return rows.join('\n');
}

export interface LogRenderOptions {
  /** Workspace root, stripped from paths in rendered text. */
  cwd?: string;
  /** Task dispatch time, for the elapsed gutter. Omit to render a blank gutter. */
  startedAt?: number;
  /** Char budget for tool output and reasoning; Infinity renders everything. */
  trim?: number;
  /** The user named a budget via --trim: honour it and drop the line cap. */
  explicitTrim?: boolean;
  /** Terminal columns, for clipping the one-line kinds. */
  width?: number;
  style?: Style;
}

/**
 * Renders progress-log entries as a readable transcript: an elapsed gutter, a
 * glyph per kind, assistant prose at full brightness with everything else
 * dimmed behind it, tool output tucked under the call that produced it, and a
 * blank line wherever the agent changes register (thinking -> acting ->
 * answering). Stateful — it needs the previous entry to know where the breaks
 * go — so callers keep one instance per stream.
 */
export class LogRenderer {
  private prevKind: string | null = null;
  private lastAssistant = '';
  private lastTool: string | null = null;
  private lastToolText = '';
  private lastUsageTotal = 0;
  private entryAt: number | null = null;
  private readonly style: Style;

  constructor(private readonly opts: LogRenderOptions = {}) {
    this.style = opts.style ?? outStyle;
  }

  /** The most recent assistant message rendered — the final answer, usually. */
  get lastAssistantMessage(): string {
    return this.lastAssistant;
  }

  render(entry: JobLogEntry): string[] {
    const s = this.style;
    const kind = String(entry.kind ?? 'status');
    const at = Date.parse(String(entry.at ?? ''));
    this.entryAt = Number.isFinite(at) ? at : null;
    const trim = this.opts.trim ?? OUTPUT_PREVIEW_CHARS;
    const lineCap = this.opts.explicitTrim || trim === Infinity ? Infinity : OUTPUT_PREVIEW_LINES;

    // Token snapshots arrive far too often to print one each; the opening
    // count seeds the meter silently and only real growth earns a line.
    if (kind === 'usage') {
      const tokens = entry.tokens as TokenUsage | undefined;
      if (!tokens) return [];
      const seeded = this.lastUsageTotal > 0;
      const grown = tokens.total - this.lastUsageTotal;
      if (!seeded || grown < Math.max(20_000, this.lastUsageTotal * 0.2)) {
        this.lastUsageTotal = Math.max(this.lastUsageTotal, tokens.total);
        return [];
      }
      this.lastUsageTotal = tokens.total;
      return this.compose(kind, s.dim(formatTokensCompact(tokens)), false);
    }

    // An approval that carries a message too (auto-review keeps one for --echo)
    // still renders from its fields; the message-only kinds — escalated,
    // timed out — have no verdict to compose from and fall through.
    if (isApproval(kind) && (entry.decision || !entry.message)) {
      const { head, reason } = describeApproval(entry, this.lastToolText, this.opts.cwd);
      return this.compose(kind, this.approval(head, reason), false);
    }

    const raw = entry.message ? String(entry.message) : String(entry.kind ?? '');
    if (!raw && !(kind === 'tool-result' && (entry.exitCode != null || entry.isError))) return [];
    const text = stripCwd(raw, this.opts.cwd);

    if (kind === 'assistant') {
      this.lastAssistant = text;
      return this.compose(kind, text, true);
    }
    if (kind === 'steer') {
      return this.compose(kind, s.yellow(text), true);
    }
    if (kind === 'error') {
      return this.compose(kind, s.red(text), true);
    }
    if (kind === 'reasoning') {
      // A short preview by default: enough to see where the agent's head is
      // without burying the work. --trim opens it up.
      const seconds = typeof entry.durationMs === 'number' ? Math.round(entry.durationMs / 1000) : 0;
      const stamp = seconds >= 1 ? `thought ${formatAge(seconds * 1000)} · ` : '';
      const body =
        lineCap === Infinity
          ? `${s.dim(stamp)}${capBody(text, trim, Infinity, s)}`
          : this.clip(`${stamp}${text.split('\n')[0] ?? ''}`, REASONING_ROWS, s.dim);
      return this.compose(kind, body, false);
    }
    if (kind === 'tool') {
      this.lastTool = entry.tool ? String(entry.tool) : null;
      this.lastToolText = text;
      return this.compose(kind, this.clip(text.replace(/\s*\n\s*/g, ' '), TOOL_ROWS, s.light), false);
    }
    if (kind === 'tool-result') {
      const exit = typeof entry.exitCode === 'number' ? entry.exitCode : null;
      const failed = (exit !== null && exit !== 0) || entry.isError === true;
      const ms = typeof entry.durationMs === 'number' ? entry.durationMs : 0;
      // Calls can overlap, so output does not always land under the call that
      // asked for it; name the tool whenever it isn't the one just above.
      const tool = entry.tool ? String(entry.tool) : null;
      const notes = [
        tool && tool !== this.lastTool ? s.dim(`from ${tool}`) : '',
        failed ? s.red(exit !== null ? `exit ${exit}` : 'failed') : '',
        // Sub-second calls are the norm; only a wait worth noticing is news.
        ms >= 3000 ? s.dim(formatAge(ms)) : '',
      ].filter(Boolean);
      const body = capBody(text, trim, lineCap, s);
      const lines = [...(notes.length ? [notes.join(s.dim(' · '))] : []), ...(body ? [body] : [])];
      return this.compose(kind, lines.join('\n'), false);
    }
    return this.compose(kind, this.clip(text, STATUS_ROWS, s.dim), false);
  }

  // A blank line wherever the agent changes register; tool output stays welded
  // to the call above it.
  private spaced(kind: string): boolean {
    if (this.prevKind === null) return false;
    if (kind === 'assistant' || kind === 'error' || kind === 'steer') return true;
    if (kind === 'reasoning') return this.prevKind !== 'reasoning';
    if (kind === 'tool') return this.prevKind === 'assistant' || this.prevKind === 'reasoning';
    return false;
  }

  // Verdict first, reason under it — but only once the pair outgrows a single
  // row. Most approvals are a few words either side and a forced second row
  // would double the height of a quiet transcript; the ones that don't fit are
  // exactly the ones worth reading, and there the verdict owns its row, so the
  // command in it can run as far as that row allows.
  private approval(head: string, reason: string): string {
    const s = this.style;
    const body = this.opts.width ? this.opts.width - BODY_INDENT.length : Infinity;
    const inline = `${head}${reason ? ` — ${reason}` : ''}`;
    if (!reason || visibleWidth(inline) <= body) {
      return `${s.light(head)}${reason ? s.dim(` — ${reason}`) : ''}`;
    }
    return [this.clip(head, 1, s.light), this.clip(reason, STATUS_ROWS - 1, s.dim)].join('\n');
  }

  // Wrap a one-line entry to its row budget, shading each row on its own. The
  // width is the body's, not the terminal's — the gutter sits to the left of
  // it, and clipping against the full width is what makes these lines spill
  // onto a row the indent never reaches. --trim is the escape hatch: an
  // explicit budget caps characters instead of rows, `none` caps neither.
  private clip(line: string, rows: number, paint: (text: string) => string): string {
    const trim = this.opts.trim ?? OUTPUT_PREVIEW_CHARS;
    if (this.opts.explicitTrim || trim === Infinity) {
      return capBody(line, trim, Infinity, this.style, paint);
    }
    const width = this.opts.width;
    if (!width) return paint(line);
    return wrapAnsi(line, Math.max(width - BODY_INDENT.length, MIN_BODY_WIDTH), rows)
      .map(row => shade(row, paint))
      .join('\n');
  }

  private compose(kind: string, body: string, wrap: boolean): string[] {
    const gap = this.spaced(kind) ? [''] : [];
    this.prevKind = kind;
    const glyph = KIND_GLYPHS[kind] ?? (isApproval(kind) ? '⚑' : '·');
    const [first = '', ...rest] = body.split('\n');
    return [
      ...gap,
      `${this.gutter(kind)}${this.style.dim(glyph)} ${first}`,
      // Prose is left to the terminal to wrap; everything else is already
      // clipped, so indenting its continuation lines keeps the column true.
      ...rest.map(line => (wrap ? line : `${BODY_INDENT}${line}`)),
    ];
  }

  private gutter(kind: string): string {
    const blank = ' '.repeat(GUTTER_WIDTH + 1);
    // Output belongs to the call above it — a second stamp would only compete.
    if (kind === 'tool-result') return blank;
    if (!this.opts.startedAt || this.entryAt === null) return blank;
    return `${this.style.dim(formatElapsed(this.entryAt - this.opts.startedAt).padStart(GUTTER_WIDTH))} `;
  }
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

// Result-list row shared by setup-host and upgrade: two-space indent, bold
// status glyph matching the flow tree's ✔/✘.
export function good(text: string): string {
  return `  ${outStyle.bold(outStyle.green('✔'))} ${text}`;
}
export function bad(text: string): string {
  return `  ${outStyle.bold(outStyle.red('✘'))} ${text}`;
}

// The slice of a write stream LiveRegion needs — structural, so tests can
// drive a fake terminal and callers can pass process.stdout/stderr as-is.
export interface LiveStream {
  isTTY?: boolean;
  columns?: number;
  rows?: number;
  getWindowSize?: () => number[];
  write(data: string): boolean;
  on(event: 'resize', listener: () => void): unknown;
  off(event: 'resize', listener: () => void): unknown;
}

// Fresh terminal size via syscall. stream.columns/rows are only updated when
// SIGWINCH is delivered — a repaint frame between a physical resize and the
// signal would erase with a stale width and strand copies of the live block.
export function termCols(stream: LiveStream = process.stdout): number | undefined {
  try {
    return stream.getWindowSize?.()[0] ?? stream.columns;
  } catch {
    return stream.columns;
  }
}
export function termRows(stream: LiveStream = process.stdout): number | undefined {
  try {
    return stream.getWindowSize?.()[1] ?? stream.rows;
  } catch {
    return stream.rows;
  }
}

// Approximate wcwidth for one code point. Live-block lines carry arbitrary
// task-log text; a CJK char or emoji measured as 1 column would let a
// "clipped" line touch the last column, set the terminal's soft-wrap flag,
// and break the row accounting LiveRegion's erase relies on.
function charWidth(cp: number): number {
  if (
    (cp >= 0x0300 && cp <= 0x036f) || // combining marks
    (cp >= 0x200b && cp <= 0x200f) || // zero-width space/joiners/marks
    (cp >= 0xfe00 && cp <= 0xfe0f) // variation selectors
  ) {
    return 0;
  }
  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0xa4cf) || // CJK radicals … Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compatibility ideographs
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK compatibility forms
    (cp >= 0xff00 && cp <= 0xff60) || // fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) || // emoji
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK extensions
  ) {
    return 2;
  }
  return 1;
}

/** Visible terminal columns of a styled line (SGR sequences count 0). */
export function visibleWidth(line: string): number {
  let width = 0;
  for (const ch of line.replace(/\x1b\[[0-9;]*m/g, '')) width += charWidth(ch.codePointAt(0)!);
  return width;
}

// Index at which `line` reaches `width` visible columns; SGR sequences pass
// through without counting.
function widthCut(line: string, width: number): number {
  let visible = 0;
  for (let i = 0; i < line.length; ) {
    const m = line[i] === '\x1b' ? /^\x1b\[[0-9;]*m/.exec(line.slice(i)) : null;
    if (m) {
      i += m[0].length;
      continue;
    }
    const ch = String.fromCodePoint(line.codePointAt(i)!);
    const w = charWidth(ch.codePointAt(0)!);
    if (visible + w > width) return i;
    visible += w;
    i += ch.length;
  }
  return line.length;
}

// Break a line into at most `rows` rows of `width` visible columns, ellipsising
// whatever is left over. Breaks at a space when one sits in the last third of
// the row, so words survive wherever that is affordable.
export function wrapAnsi(line: string, width: number, rows: number): string[] {
  if (width < 4 || rows < 1) return [line];
  const out: string[] = [];
  let rest = line;
  while (visibleWidth(rest) > width) {
    if (out.length === rows - 1) {
      return [...out, `${rest.slice(0, widthCut(rest, width - 1))}…`];
    }
    const edge = widthCut(rest, width);
    const space = rest.lastIndexOf(' ', edge);
    const cut = space > width * 0.66 ? space : edge;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\s+/, '');
  }
  return [...out, rest];
}

// Clip a styled line to at most `max` visible columns, preserving ANSI
// sequences. Live-block lines must never hard-wrap at paint time: a resize
// reflows wrapped rows in ways the cursor-up erase cannot reliably count.
export function clipAnsi(line: string, max: number): string {
  let visible = 0;
  let out = '';
  for (let i = 0; i < line.length; ) {
    const m = line[i] === '\x1b' ? /^\x1b\[[0-9;]*m/.exec(line.slice(i)) : null;
    if (m) {
      out += m[0];
      i += m[0].length;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    const w = charWidth(cp);
    if (visible + w > max - 1) return `${out}\x1b[0m${outStyle.dim('…')}`;
    out += ch;
    visible += w;
    i += ch.length;
  }
  return out;
}

// While a live block is on screen, echoed keystrokes corrupt it: an Enter
// echoes a newline, silently moving the cursor down a row, and every erase
// after that is off by one — one stranded copy of the block per press. Raw
// mode turns echo off for the duration. Raw mode also stops the terminal
// generating SIGINT/SIGTSTP, so Ctrl-C and Ctrl-Z are forwarded by hand.
// Returns a restore function; no-op when stdin or stdout isn't a TTY.
export function muteKeys(): () => void {
  const stdin = process.stdin;
  if (!stdin.isTTY || !process.stdout.isTTY) return () => {};
  stdin.setRawMode(true);
  stdin.resume();
  const onData = (chunk: Buffer): void => {
    if (chunk.includes(0x03)) process.kill(process.pid, 'SIGINT'); // Ctrl-C
    if (chunk.includes(0x1a)) process.kill(process.pid, 'SIGTSTP'); // Ctrl-Z
  };
  stdin.on('data', onData);
  // The muted stdin must never keep the process alive on its own.
  stdin.unref();
  return () => {
    stdin.off('data', onData);
    if (stdin.isTTY) stdin.setRawMode(false);
    stdin.pause();
  };
}

// Size must be stable this long before the live block repaints after a resize.
const RESIZE_QUIET_MS = 250;

/**
 * A repaintable block of lines pinned at the bottom of the terminal, with
 * finalized lines committed into scrollback above it — the shared live-render
 * primitive (the flow follower today; anything with a spinner tomorrow).
 * Callers compose styled lines; LiveRegion owns every cursor code. On a
 * non-TTY stream set() is a no-op and commit() is a plain write, so callers
 * need no TTY branching around it.
 *
 * Geometry contract: each painted line is clipped to cols-1 so no row ever
 * touches the last column (a reflowing terminal joins soft-wrapped rows on
 * resize, breaking row accounting), the block is capped to the viewport
 * height (cursor-up must never clamp against the top of the screen), and
 * clear() re-measures the painted widths against the CURRENT width so a
 * resize between paints still erases the reflowed block.
 *
 * The erase/reflow race during a live drag is not closable from the app side:
 * there is no atomicity between reading the PTY size and the emulator
 * rewrapping already-painted rows, and a mis-erased frame strands copies in
 * scrollback where no escape sequence can reach them. So on the first
 * `resize` event the block is erased once — geometry at most one reflow
 * stale, the best odds of a clean erase — and painting is suspended until the
 * size has been stable for `quietMs`. A blank block has nothing to garble.
 */
export class LiveRegion {
  private lines: string[] = [];
  private painted: string[] = [];
  private paintedWidths: number[] = [];
  private paintedCols: number | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private readonly tty: boolean;

  constructor(
    private readonly stream: LiveStream = process.stdout,
    private readonly quietMs = RESIZE_QUIET_MS,
  ) {
    this.tty = Boolean(stream.isTTY);
    if (this.tty) stream.on('resize', this.onResize);
  }

  /** Replace the live block. Remembered but not painted during a resize storm. */
  set(lines: string[]): void {
    this.lines = lines;
    if (!this.tty || this.resizeTimer) return;
    this.paint();
  }

  /** Erase the block and write permanent text above it (caller repaints via set). */
  commit(text: string): void {
    this.clear();
    this.stream.write(text);
  }

  /** Erase the live block (idempotent; no-op when nothing is painted). */
  clear(): void {
    if (!this.painted.length) return;
    const cols = termCols(this.stream);
    let rows = this.painted.length;
    if (cols && this.paintedCols && cols !== this.paintedCols) {
      // Resized since the paint: reflowing terminals (Ghostty, iTerm, kitty,
      // VS Code) rewrap each painted line to the new width — recompute the
      // physical row count from the recorded visible widths.
      rows = this.paintedWidths.reduce((sum, w) => sum + Math.max(1, Math.ceil(w / cols)), 0);
    }
    this.stream.write(`\x1b[${rows}A\x1b[0J`);
    this.painted = [];
    this.paintedWidths = [];
  }

  /** Detach the resize listener, flushing any repaint the storm suppressed. */
  done(): void {
    if (this.resizeTimer) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
      this.paint();
    }
    if (this.tty) this.stream.off('resize', this.onResize);
  }

  private paint(): void {
    this.clear();
    const cols = termCols(this.stream);
    let lines = cols ? this.lines.map(l => clipAnsi(l, cols - 1)) : this.lines;
    // Cap to the viewport, keeping the tail (the newest activity): rows pushed
    // past the top of the screen could never be erased again.
    const rows = termRows(this.stream);
    if (rows && lines.length > rows - 1) lines = rows > 1 ? lines.slice(-(rows - 1)) : [];
    for (const line of lines) this.stream.write(`${line}\n`);
    this.painted = lines;
    this.paintedWidths = lines.map(visibleWidth);
    this.paintedCols = cols;
  }

  // First event: erase immediately (see class doc), then hold the block blank
  // until the size has been stable for quietMs and repaint once.
  private readonly onResize = (): void => {
    this.clear();
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      this.paint();
    }, this.quietMs);
    this.resizeTimer.unref?.();
  };
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
