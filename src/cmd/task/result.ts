/** `coder task result` (also `coder result`): a task's status and final answer. */
import process from 'node:process';

import type { TaskInspection } from '../../core/task';
import { ageMs, formatEngineSpec, type TaskLogEntry } from '../../core/state';
import { ACTIVE_STATUSES, type Style, type Task, type TokenUsage } from '../../core/types';
import type { TaskStatus } from '../../server/store/types';
import {
  formatAge,
  formatElapsed,
  formatHints,
  formatTokens,
  formatTokensCompact,
  outStyle,
  paintStatus,
} from '../../tui/output';
import type { LogView } from '../../core/task/log-view';
import { termCols, visibleWidth, wrapAnsi } from '../../tui/live';
import { shortPath } from '../../utils/fsx';
import { baseOptions, flag, optStr, str, tailOption } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

/**
 * The final-answer line for a finished task: the final message when there is
 * one, else the recorded error (result's, falling back to the task's), else the
 * caller's placeholder.
 */
export function finalMessageLine(
  result: { finalMessage?: string; error?: { message?: string } } | null | undefined,
  taskError: string | undefined,
  fallback: string,
  style: Style = outStyle,
): string {
  const errorMessage = result?.error?.message ?? taskError;
  return (
    result?.finalMessage || (errorMessage ? `${style.red('error:')} ${errorMessage}` : fallback)
  );
}

// A long prompt keeps its opening and its closing (where the actual ask
// usually lives) and drops the middle.
const PROMPT_HEAD_CHARS = 500;
const PROMPT_TAIL_CHARS = 500;
const PROMPT_PREVIEW_CHARS = PROMPT_HEAD_CHARS + PROMPT_TAIL_CHARS;

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

// Header lines for the task's dispatch options, permissions and cwd, shown by
// result/stream alongside engine/model so a glance answers "how was this
// dispatched". Only options actually set are listed.
function taskOptionLines(
  task: { permissions?: string | null; cwd?: string; addDirs?: string[] },
  style: Style = outStyle,
): string[] {
  const opts: Array<[string, string]> = [];
  if (task.permissions) opts.push(['perms', task.permissions]);
  if (task.cwd) opts.push(['cwd', task.cwd]);
  for (const dir of task.addDirs ?? []) opts.push(['add-dir', dir]);
  return opts.map(([k, v]) => `${style.dim(k.padEnd(8))} ${v}`);
}

/**
 * When a task started and, once it is over, when it ended and how long it
 * ran. The wall-clock answer to "is this worth waiting for", shown next to the
 * status by every view that has a task in hand.
 */
function taskTimeNote(
  task: { createdAt?: string; completedAt?: string },
  running: boolean,
): string {
  if (running) {
    return task.createdAt ? `started ${formatAge(ageMs(task.createdAt))} ago` : '';
  }
  const took =
    task.createdAt && task.completedAt
      ? Date.parse(task.completedAt) - Date.parse(task.createdAt)
      : null;
  return [
    task.completedAt ? `finished ${formatAge(ageMs(task.completedAt))} ago` : '',
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
  task: Task,
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
  const running = ACTIVE_STATUSES.includes(task.status) || status === 'waiting-approval';
  const note = taskTimeNote(task, running);
  const label = (text: string) => style.dim(text.padEnd(8));
  return [
    `${label('task')} ${style.cyan(task.id)}`,
    ...(task.name ? [`${label('name')} ${task.name}`] : []),
    `${label('status')} ${paintStatus(status)}${note ? ` ${style.dim(`(${note})`)}` : ''}`,
    `${label('engine')} ${formatEngineSpec(task)}`,
    ...taskOptionLines(task, style),
    ...(tokens
      ? [
          `${label('tokens')} ${
            live ? formatTokensCompact(tokens) : formatTokens(tokens, tokenModel ?? task.model)
          }${live ? style.dim(' (so far)') : ''}`,
        ]
      : []),
    ...filesLine(files, label, style),
  ];
}

// touchedFiles only covers engine edit tools, never shell commands.
const filesLine = (
  files: string[] | null | undefined,
  label: (text: string) => string,
  style: Style,
) =>
  files?.length
    ? [`${label('files')} ${files.join(', ')} ${style.dim('(shell edits not included)')}`]
    : [];

/**
 * The closing counterpart to taskHeaderLines: what the header couldn't know
 * yet: how it ended, what it cost, and what it touched. Deliberately not a second
 * copy of the header: identity is stated once, at the top.
 */
export function taskSummaryLines(
  task: Task,
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
    task.createdAt && task.completedAt
      ? Date.parse(task.completedAt) - Date.parse(task.createdAt)
      : null;
  return [
    ...(statusChanged
      ? [
          `${label('status')} ${paintStatus(task.status)}${
            took !== null && took >= 0 ? ` ${style.dim(`(took ${formatAge(took)})`)}` : ''
          }`,
        ]
      : []),
    ...(tokens ? [`${label('tokens')} ${formatTokens(tokens, tokenModel ?? task.model)}`] : []),
    ...filesLine(files, label, style),
  ];
}

// How much of a single progress-log step the text views show (full entries are
// in --json / the task log).
const STEP_PREVIEW_CHARS = 300;

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
// never capped. They are the point of the transcript, so only command output
// and thinking answer to these.
export const OUTPUT_PREVIEW_CHARS = 500;
const OUTPUT_PREVIEW_LINES = 6;

// Display budgets, in terminal rows, for the entries that are wrapped rather
// than capped. A one-row clip on a line this long hides the half that says
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

// Shade one row. Output carries the program's own colour often enough (rg,
// cargo and friends colour whenever they think they are on a tty), and the
// reset that ends it would end the shading with it, leaving the rest of the row
// at the terminal default, brighter than either grey. Rearm after each reset.
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
    return [...rows.slice(0, lines), style.light(`… +${rows.length - lines} more lines`)].join(
      '\n',
    );
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
 * answering). It is stateful and needs the previous entry to know where breaks
 * go, so callers keep one instance per stream.
 */
export class LogRenderer {
  private separated = false;
  private entryAt: number | null = null;
  private readonly style: Style;

  static async create(opts: LogRenderOptions = {}): Promise<LogRenderer> {
    const presentation = await import('../../core/task/log-view');
    return new LogRenderer(opts, new presentation.LogView(opts.cwd), presentation.isApproval);
  }

  private constructor(
    private readonly opts: LogRenderOptions,
    private readonly view: LogView,
    private readonly isApproval: (kind: string) => boolean,
  ) {
    this.style = opts.style ?? outStyle;
  }

  /** The most recent assistant message rendered, usually the final answer. */
  get lastAssistantMessage(): string {
    return this.view.lastAssistantMessage;
  }

  render(entry: TaskLogEntry): string[] {
    const at = Date.parse(String(entry.at ?? ''));
    this.entryAt = Number.isFinite(at) ? at : null;
    const [row] = this.view.reduce({ seq: 0, at, level: 'out', line: '', entry });
    if (!row) return [];
    this.separated = row.separated;
    const s = this.style;
    const kind = row.sourceKind;
    const text = row.title;
    const trim = this.opts.trim ?? OUTPUT_PREVIEW_CHARS;
    const lineCap = this.opts.explicitTrim || trim === Infinity ? Infinity : OUTPUT_PREVIEW_LINES;

    if (row.kind === 'usage') return this.compose(kind, s.dim(text), false);
    if (row.kind === 'approval')
      return this.compose(kind, this.approval(text, row.detail ?? ''), false);
    if (row.kind === 'assistant') return this.compose(kind, text, true);
    if (row.kind === 'steer') return this.compose(kind, s.yellow(text), true);
    if (row.kind === 'error') return this.compose(kind, s.red(text), true);
    if (row.kind === 'reasoning') {
      const seconds = Math.round((row.durationMs ?? 0) / 1000);
      const stamp = seconds >= 1 ? `thought ${formatAge(seconds * 1000)} · ` : '';
      const body =
        lineCap === Infinity
          ? `${s.dim(stamp)}${capBody(text, trim, Infinity, s)}`
          : this.clip(`${stamp}${text.split('\n')[0] ?? ''}`, REASONING_ROWS, s.dim);
      return this.compose(kind, body, false);
    }
    if (row.kind === 'tool')
      return this.compose(
        kind,
        this.clip(text.replace(/\s*\n\s*/g, ' '), TOOL_ROWS, s.light),
        false,
      );
    if (row.kind === 'tool-result') {
      const notes = [
        row.tool ? s.dim(`from ${row.tool}`) : '',
        row.tone === 'error'
          ? s.red(row.exitCode !== undefined ? `exit ${row.exitCode}` : 'failed')
          : '',
        (row.durationMs ?? 0) >= 3000 ? s.dim(formatAge(row.durationMs!)) : '',
      ].filter(Boolean);
      const body = capBody(text, trim, lineCap, s);
      const lines = [...(notes.length ? [notes.join(s.dim(' · '))] : []), ...(body ? [body] : [])];
      return this.compose(kind, lines.join('\n'), false);
    }
    return this.compose(kind, this.clip(text, STATUS_ROWS, s.dim), false);
  }

  // Put the verdict first and reason under it once the pair outgrows one
  // row. Most approvals are a few words either side and a forced second row
  // would double the height of a quiet transcript; the ones that don't fit are
  // exactly the ones worth reading, and there the verdict owns its row, so the
  // command in it can run as far as that row allows.
  private approval(head: string, reason: string): string {
    const s = this.style;
    const body = this.opts.width ? this.opts.width - BODY_INDENT.length : Infinity;
    const inline = `${head}${reason ? `. ${reason}` : ''}`;
    if (!reason || visibleWidth(inline) <= body) {
      return `${s.light(head)}${reason ? s.dim(`. ${reason}`) : ''}`;
    }
    return [this.clip(head, 1, s.light), this.clip(reason, STATUS_ROWS - 1, s.dim)].join('\n');
  }

  // Wrap a one-line entry to its row budget, shading each row on its own. The
  // width is the body's, not the terminal's. The gutter sits to the left of
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
    const gap = this.separated ? [''] : [];
    const glyph = KIND_GLYPHS[kind] ?? (this.isApproval(kind) ? '⚑' : '·');
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
    // Output belongs to the call above it. A second stamp would only compete.
    if (kind === 'tool-result') return blank;
    if (!this.opts.startedAt || this.entryAt === null) return blank;
    return `${this.style.dim(formatElapsed(this.entryAt - this.opts.startedAt).padStart(GUTTER_WIDTH))} `;
  }
}

export const statusStyle = (status: TaskStatus['status'], s: Style): string =>
  status === 'completed'
    ? s.green(status)
    : status === 'failed'
      ? s.red(status)
      : status === 'running'
        ? s.yellow(status)
        : s.dim(status);

function took(status: TaskStatus): string {
  if (status.startedAt === undefined) return '';
  return formatAge((status.finishedAt ?? Date.now()) - status.startedAt);
}

/** The agent's reply from a finished default-flow task, if its output ended in the JSON result line. */
export function replyOf(status: TaskStatus): string | undefined {
  const lines = (status.result?.output ?? '').trim().split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith('{')) continue;
    try {
      const reply = (JSON.parse(line) as { reply?: unknown }).reply;
      return typeof reply === 'string' ? reply : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function printOutcome(status: TaskStatus, s: Style): void {
  process.stdout.write(
    `${s.bold(status.task.id)}  ${statusStyle(status.status, s)}${status.error ? `  ${s.red(status.error)}` : ''}${took(status) ? `  ${s.dim(`took ${took(status)}`)}` : ''}\n`,
  );
  if (status.credential) process.stdout.write(`${s.dim('credential')}  ${status.credential}\n`);
  const reply = replyOf(status);
  if (reply) process.stdout.write(`\n${s.bold('Reply')}\n${reply.trim()}\n`);
}

/** `task result --json`: the inspection without what only the text view uses. */
function resultJson(inspection: TaskInspection, turns = false) {
  const { task, steps, result } = inspection;
  return {
    taskId: task.id,
    name: task.name ?? null,
    prompt: task.prompt ?? null,
    system: task.system ?? null,
    status: inspection.status,
    engine: task.engine,
    model: task.model ?? null,
    effort: task.effort ?? null,
    permissions: task.permissions ?? null,
    cwd: task.cwd ?? null,
    addDirs: task.addDirs ?? [],
    createdAt: task.createdAt ?? null,
    completedAt: task.completedAt ?? null,
    ...(inspection.idleMs !== undefined
      ? {
          idleMs: inspection.idleMs,
          lastActivityAt: inspection.lastActivityAt ?? null,
          stalled: inspection.stalled,
        }
      : {}),
    pendingApprovals: inspection.pendingApprovals,
    ...(steps.length ? { steps } : {}),
    turnCount: inspection.turns.length,
    ...(turns ? { turns: inspection.turns } : {}),
    result,
  };
}

/** The header, the prompt, pending approvals, recent steps, then the answer or why there is none yet. */
async function printResult(
  inspection: TaskInspection,
  cwd: string,
  opts: { turns?: boolean; wait?: boolean } = {},
): Promise<void> {
  const { task, steps, result, turns, pendingApprovals: pending } = inspection;
  const s = outStyle;
  const running = ACTIVE_STATUSES.includes(task.status);
  const lines = taskHeaderLines(task, {
    status: inspection.status as Task['status'],
    tokens: result?.tokens ?? inspection.liveTokens ?? null,
    tokenModel: result?.model,
    files: result?.touchedFiles?.map((file: string) => shortPath(task.cwd ?? cwd, file)),
    live: !result?.tokens && Boolean(inspection.liveTokens),
    style: s,
  });
  // The prompt gets its own block (not a header field) so longer task text
  // stays readable but closes the header instead of standing apart from it.
  if (task.prompt) {
    lines.push(...promptBlock(task.prompt, s));
  }
  if (pending.length) {
    lines.push('', s.dim('pending approvals:'));
    for (const a of pending) {
      lines.push(`  ${s.cyan(a.id)}  ${a.summary}`);
      if (a.cwd) lines.push(`  ${s.dim(`runs in ${a.cwd}`)}`);
      lines.push(
        `  ${s.bold(`coder task approve ${task.id} ${a.id}`)}  ${s.dim('(--deny to reject)')}`,
      );
    }
  }
  if (steps.length) {
    lines.push('', s.dim('steps:'));
    // Same transcript renderer `watch` streams through, so a recap and a live
    // follow read identically.
    const renderer = await LogRenderer.create({
      cwd: task.cwd ?? cwd,
      startedAt: Date.parse(task.createdAt ?? '') || undefined,
      width: termCols(),
      style: s,
    });
    // The answer is printed below in full; leaving its copy at the end of the
    // transcript would just say everything twice.
    const shown =
      result?.finalMessage &&
      String(steps.at(-1)?.message ?? '').trim() === String(result.finalMessage).trim()
        ? steps.slice(0, -1)
        : steps;
    for (const entry of shown) lines.push(...renderer.render(entry));
  }
  lines.push('');
  if (opts.turns && turns.length) {
    turns.forEach((turn, i) => {
      if (i) lines.push('');
      lines.push(s.dim(`Turn ${i + 1} of ${turns.length}. ${trimStep(String(turn.prompt ?? ''))}`));
      lines.push(String(turn.finalMessage || s.dim('(no final message)')));
    });
  } else if (result) {
    lines.push(
      finalMessageLine(
        { ...result, error: result.error ?? undefined },
        task.error,
        '(no final message)',
        s,
      ),
    );
    if (turns.length > 1) {
      lines.push(
        s.dim(
          `Turn ${turns.length} of ${turns.length}. All answers are in coder task result ${task.id} --turns.`,
        ),
      );
    }
  } else if (running) {
    const { lastLog } = inspection;
    lines.push(
      s.dim(
        inspection.stalled
          ? `Result pending. No progress for ${formatAge(inspection.idleMs ?? 0)}. The task may be stalled.${
              lastLog ? ` Last: ${trimStep(lastLog.message ?? lastLog.kind ?? '')}` : ''
            }`
          : 'Result pending. The task is still running.',
      ),
    );
  } else {
    lines.push(s.dim('(no result)'));
  }
  // While it's still running, point at --wait to block for the answer (and to
  // the transcript if it looks stalled).
  if (running && !opts.wait) {
    const hints = [
      `Wait in a background shell; do not poll: coder task result ${task.id} --wait`,
      `Follow live: coder task watch ${task.id}`,
    ];
    if (inspection.stalled)
      hints.push(`Check the transcript: coder task result ${task.id} --tail all`);
    lines.push('', formatHints(hints, s));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

// The one inspect command: status + final answer. While a task runs it shows the
// status (result pending); once finished it shows the answer. --wait blocks until
// then. Defaults to the most recent task.
export const commandResult = command({
  name: 'task result',
  help: {
    usage: 'coder task result [task-id] [--server [url]]',
    summary:
      "Show a task's status and its final answer (result pending while it runs), plus\nany pending approvals. --wait blocks until it finishes, then prints. --tail <n>\nincludes the last n progress-log steps (--tail all for the whole transcript).\nDefaults to the most recent task. Shortcut: `coder result`.",
    flags: [
      ['--wait', 'block until the task finishes, then print'],
      ['--turns', "every turn's answer (a steered task accretes turns)"],
      ['--tail <n|all>', 'include the last n progress-log steps (default: 0, final result only)'],
      SERVER_FLAG,
    ],
    exitCodes: [
      ['0', 'The task completed successfully.'],
      ['1', 'The task failed or was cancelled.'],
      ['4', 'An approval is pending; answer it, then run --wait again.'],
    ],
    examples: [
      ['coder result <task-id> --wait', 'block until the task finishes, print the answer'],
      ['coder result <task-id> --turns', "every turn's answer for a steered task"],
    ],
  },
  options: { ...baseOptions, tail: tailOption, wait: flag, turns: flag, ...serverOptions },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.result(id, {
      ...options,
      organization: options.workspace,
      // Tell the user we're blocking (not hung) before we start polling.
      onWaiting: taskId =>
        process.stderr.write(
          `${outStyle.dim(`[coder] waiting for task ${taskId} to finish...`)}\n`,
        ),
    });
  },
  json: (result, { options }) =>
    'attempts' in result ? result : resultJson(result, options.turns),
  print: (result, { options, cwd }) =>
    'attempts' in result
      ? printOutcome(result as TaskStatus, outStyle)
      : printResult(result as TaskInspection, cwd, options),
  exit: (result, { options }) =>
    options.wait && !('attempts' in result)
      ? result.task.status === 'completed'
        ? 0
        : 1
      : undefined,
});
