/** `coder flow watch`: follow a run live, and the step renderer every flow command paints with. */
import process from 'node:process';

import { readTaskLog } from '../../core/state';
import type { FlowWatch, RunResult } from '../../flow/runs';
import type { RunSummary } from '../../flow/executor';
import type { FlowEvent } from '../../flow/types';
import {
  clipPad,
  formatAge,
  formatHints,
  formatJson,
  formatTokenCount,
  formatTokens,
  outStyle,
  printJson,
} from '../../tui/output';
import { LiveRegion, muteKeys, termCols, termRows, type LiveStream } from '../../tui/live';
import { baseOptions, tailOption } from '../../utils/args';
import { command } from '../../cli';

// Replay the run's full event stream then track it live, with --wait's exit semantics.
export const commandWatch = command({
  name: 'flow watch',
  help: {
    usage: 'coder flow watch [run-id] [--tail <n|all>] [--json]',
    summary:
      'Watch a flow run live: replay its progress lines from the start, then keep\nfollowing while it runs (Ctrl-C detaches; it keeps running). Blocks until it\nfinishes; exits 0 on success, 1 otherwise. Defaults to the most recent run.\nFor the result alone, prefer `coder flow result`. Alias: stream.',
    flags: [['--tail <n|all>', 'replay only the last n events first (default: all)']],
    examples: [['coder flow watch', 'follow the most recent run to completion']],
  },
  options: { ...baseOptions, tail: tailOption },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { watchRun } = await import('../../flow/runs');
    return printFollow(watchRun(id, { tail: options.tail }), { json: options.json, stream: true });
  },
});

// The one place step-line formats live: dry-run hooks, the follower (flow
// stream / --wait), and `flow result` all paint step rows through these.
// Full-height braille frames: vertically centered in the cell, unlike the
// sparse top-heavy 4-dot set.
const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

// Status symbol: ✔ done, ✘ failed/cancelled, ● running, ○ queued/other.
// Bold so terminals draw the heavier stroke.
//
// Off a TTY the reader is a log scraper or an agent, so `plain` swaps every
// glyph for a bracketed word such as `[done]`, `[failed]`, or `[running]`, padded to
// one column: the same row, greppable and free of box/braille characters.
export function stepSymbol(status: string, plain = false): string {
  const s = outStyle;
  if (plain) return clipPad(`[${statusWord(status)}]`, 10);
  if (status === 'completed') return s.bold(s.green('✔'));
  if (status === 'failed' || status === 'cancelled' || status === 'stopped')
    return s.bold(s.red('✘'));
  if (status === 'running') return s.bold(s.cyan('●'));
  return s.dim('○');
}

// Plain-mode opener: a step's `[start]` line, paired with the `[done]` /
// `[failed]` line the same step writes when it ends.
function startTag(): string {
  return clipPad('[start]', 10);
}

function statusWord(status: string): string {
  if (status === 'completed') return 'done';
  if (status === 'cancelled') return 'failed';
  return status;
}

// Display name: the task's name as given, else the prompt's opening flattened
// and clipped without recasing or slugifying the text.
export function taskLabel(name: string | undefined, prompt: string): string {
  return name ?? prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
}

// `✔ Sea words      task-abc...  claude/opus/medium  15k tok`. The name leads,
// then id (dim), engine and tokens (light) in fixed columns so rows align.
export function taskLine(
  symbol: string,
  name: string | null,
  taskId: string,
  tokens?: { total: number } | null,
  engine?: string,
  highlight?: boolean,
): string {
  const s = outStyle;
  // Highlight is applied after clipPad: styling inside the pad would count
  // ANSI codes as width and break column alignment.
  const nameCell = clipPad(name ?? taskId, 32);
  return [
    `${symbol} ${highlight ? s.bold(nameCell) : nameCell}`,
    s.dim(clipPad(taskId, 24)),
    s.light(clipPad(engine ?? '', 20)),
    tokens ? s.light(`${formatTokenCount(tokens.total)} tok`) : '',
  ]
    .join(' ')
    .trimEnd();
}

// `✔ gate bun tsc` / `✘ gate bun tsc · exit 3` (plain: `[done]  gate bun tsc`).
export function gateLine(e: { cmd: string; ok: boolean; code: number }, plain = false): string {
  const s = outStyle;
  const symbol = stepSymbol(e.ok ? 'completed' : 'failed', plain);
  return `${symbol} ${s.dim('gate')} ${s.light(e.cmd)}${e.ok ? '' : s.dim(` · exit ${e.code}`)}`;
}

// A gate still running: same row shape, live symbol, and (once it has run long
// enough to be worth saying) how long it has been going. A harness gate can
// hold the flow for ten minutes and the row is the only sign of life.
export function gateRunningLine(cmd: string, symbol: string, elapsedMs?: number): string {
  const s = outStyle;
  const age =
    elapsedMs !== undefined && elapsedMs >= 1000 ? s.dim(` · ${formatAge(elapsedMs)}`) : '';
  return `${symbol} ${s.dim('gate')} ${s.light(cmd)}${age}`;
}

// Stateful step renderer shared by the dry-run hooks and the follower. Tracks
// task names across start/end events. On a TTY the running tasks form an
// "active block" of ● lines kept at the bottom: every event (and a ~120ms
// spinner tick) clears the block (cursor-up + erase-down), prints any newly
// final ✔/✘ line above it and repaints, so a task's ● line visibly becomes
// its ✔/✘ line. Lines above the block are final and never touched. Non-TTY
// output is append-only (● on start, ✔/✘ on end) with no cursor codes.
// Tree rails: ├─ teeth per step, │ pass-through for logs; a nested (sub-flow)
// level adds a │ vertical so depth reads as a real tree.
// `last` closes the leg (└─). Use it when the following line sits at a
// shallower depth, i.e. this line ends its nested group.
function stepRail(depth: number, last = false): string {
  return outStyle.dim(`${'│    '.repeat(depth)}${last ? '└─' : '├─'}`);
}

function logRail(depth: number): string {
  return outStyle.dim(`${'│    '.repeat(depth)}│ `);
}

// A finished line waiting to learn whether it closes its leg: the rail glyph
// (├─ vs └─) depends on the NEXT line's depth, so lines commit one behind.
export interface PendingLine {
  depth: number;
  body: string;
  log?: boolean;
}

// Plain rows carry no rails: depth is two spaces per level and a log line gets
// the word in the status column, so every row still starts with what it is.
export function paintPlain(p: PendingLine): string {
  return `${'  '.repeat(p.depth)}${p.log ? `${clipPad('[log]', 10)} ` : ''}${p.body}`;
}

function paintPending(p: PendingLine, last: boolean, plain = false): string {
  if (plain) return paintPlain(p);
  return `${p.log ? logRail(p.depth) : stepRail(p.depth, last)} ${p.body}`;
}

// Breathing room above a running task row in the live block: a rail-only line
// whose lone │ sits in the step's tooth column, so the leg reads connected
// across the gap. Committed scrollback rows stay dense.
function spacerRail(depth: number): string {
  return outStyle.dim(`${'│    '.repeat(Math.max(0, depth))}│`);
}

export class FlowStepRenderer {
  private names = new Map<string, { name: string; engine?: string; depth?: number }>();
  private active = new Map<string, { name: string; engine?: string; depth?: number }>();
  // Gates in flight by gate id render in the active block beside tasks.
  private activeGates = new Map<string, { cmd: string; depth: number; startedAt: number }>();
  private pending: PendingLine | undefined;
  // Latest progress-log message per running task, shown as one dim railed
  // line under its row. It is never wrapped because a second row buys little and costs
  // half the viewport when tasks run wide).
  private previews = new Map<string, string>();
  private frame = 0;
  // Whether anything has been committed yet. The first row gets no spacer.
  private hasCommitted = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly tty: boolean;
  // Owns all cursor codes: erase/repaint geometry, resize quiescing, clipping.
  private readonly region: LiveRegion;

  // `stream` is injectable for the FakeTerm emulation tests only.
  constructor(private readonly stream: LiveStream = process.stdout) {
    this.tty = Boolean(stream.isTTY);
    this.region = new LiveRegion(stream);
  }

  emit(e: FlowEvent): void {
    const s = outStyle;
    switch (e.kind) {
      case 'task-start': {
        const entry = { name: taskLabel(e.name, e.prompt), engine: e.engine, depth: e.depth ?? 0 };
        this.names.set(e.taskId, entry);
        // Off a TTY there is no live block to hold a row in, so the stream is
        // an event feed instead. Show `[start]` now and `[done]`/`[failed]` when it
        // ends, the same shape `coder task watch` uses for a task's steps. (The
        // one-row-per-step view is `flow result`, which is a state snapshot.)
        if (!this.tty) {
          this.final(entry.depth, taskLine(startTag(), entry.name, e.taskId, null, entry.engine));
          return;
        }
        this.active.set(e.taskId, entry);
        this.spin(true);
        this.repaint();
        return;
      }
      case 'task-end': {
        this.active.delete(e.taskId);
        this.previews.delete(e.taskId);
        this.idle();
        const known = this.names.get(e.taskId);
        this.final(
          known?.depth ?? 0,
          taskLine(
            stepSymbol(e.status, !this.tty),
            known?.name ?? null,
            e.taskId,
            e.tokens,
            known?.engine,
          ),
        );
        return;
      }
      case 'gate-start': {
        const entry = { cmd: e.cmd, depth: e.depth ?? 0, startedAt: Date.now() };
        if (!this.tty) {
          this.final(entry.depth, gateRunningLine(entry.cmd, startTag()));
          return;
        }
        this.activeGates.set(e.gateId, entry);
        this.spin(true);
        this.repaint();
        return;
      }
      case 'gate':
        if (e.gateId) this.activeGates.delete(e.gateId);
        this.idle();
        this.final(e.depth ?? 0, gateLine(e, !this.tty));
        return;
      case 'log':
        // One railed row per line: a multi-line message would otherwise paint
        // rail-less inner lines and break the repaint row accounting. Light,
        // so commentary reads secondary to the step rows.
        for (const l of e.message.split('\n')) this.final(e.depth ?? 0, s.light(l), true);
        return;
      case 'flow-start':
        this.final(e.depth - 1, s.bold(`flow ${e.name}`));
        return;
      case 'replay':
        this.final(0, s.dim(`replayed ${e.count} steps from journal`), true);
    }
  }

  /** Stream over: flush the held line (closing its leg if nested), stop the spinner. */
  done(): void {
    this.spin(false);
    this.flush(0);
    if (this.tty) this.repaint();
    this.region.done();
  }

  // Commit the held line now that the next line's depth is known.
  private flush(nextDepth: number): void {
    if (!this.pending) return;
    this.region.commit(
      `${paintPending(this.pending, nextDepth < this.pending.depth, !this.tty)}\n`,
    );
    this.hasCommitted = true;
    this.pending = undefined;
  }

  // Hold a finished line (rail undecided until the next one), committing the
  // previous hold above the active block.
  private final(depth: number, body: string, log = false): void {
    // Plain rows have no rail to decide, so nothing is held back: a follower
    // tailing the feed must see `[start]` when it happens, not whenever the
    // next event lands (a ten-minute gate would sit unflushed for ten minutes).
    if (!this.tty) {
      this.region.commit(`${paintPlain({ depth, body, log })}\n`);
      this.hasCommitted = true;
      return;
    }
    this.flush(depth);
    this.pending = { depth, body, log };
    if (this.tty) this.repaint();
  }

  private repaint(): void {
    // Two candidate blocks, degrading as the viewport shrinks: task rows with
    // previews, then task rows alone, then the newest task rows behind a dim
    // "+N more running" header. Task rows always outrank previews. A preview
    // without its task row is noise.
    const withPreviews: string[] = [];
    const bare: string[] = [];
    // The held line joins the active block (provisional ├─) so the display
    // never lags an event behind.
    if (this.pending) {
      const held = paintPending(this.pending, false);
      withPreviews.push(held);
      bare.push(held);
    }
    // Animate ● as a braille spinner while the timer runs; static ● otherwise.
    const symbol = this.timer
      ? outStyle.bold(outStyle.cyan(SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!))
      : stepSymbol('running');
    for (const [taskId, entry] of this.active) {
      const row = `${stepRail(entry.depth ?? 0)} ${taskLine(symbol, entry.name, taskId, null, entry.engine, true)}`;
      if (withPreviews.length || this.hasCommitted) withPreviews.push(spacerRail(entry.depth ?? 0));
      withPreviews.push(row);
      bare.push(row);
      const preview = this.previews.get(taskId);
      if (preview) withPreviews.push(`${logRail(entry.depth ?? 0)} ${outStyle.dim(preview)}`);
    }
    // Gates last: a gate is usually a barrier, so it reads as the thing the
    // flow is currently blocked on, under whatever tasks are still running.
    for (const gate of this.activeGates.values()) {
      const row = `${stepRail(gate.depth)} ${gateRunningLine(gate.cmd, symbol, Date.now() - gate.startedAt)}`;
      if (withPreviews.length || this.hasCommitted) withPreviews.push(spacerRail(gate.depth));
      withPreviews.push(row);
      bare.push(row);
    }
    const budget = (termRows(this.stream) ?? Infinity) - 1;
    let lines = withPreviews.length <= budget ? withPreviews : bare;
    if (lines.length > budget) {
      const keep = Math.max(0, budget - 1);
      lines = [outStyle.dim(`… +${lines.length - keep} more running`), ...lines.slice(-keep)];
    }
    this.region.set(lines);
  }

  // Latest progress-log line per running task: one railed row, clipped to the
  // terminal so the preview itself can never wrap.
  private refreshPreviews(): void {
    for (const taskId of this.active.keys()) {
      try {
        const last = readTaskLog(process.cwd(), taskId, 1)[0];
        const msg = last?.message?.replace(/\s+/g, ' ').trim();
        if (!msg) continue;
        const width = (termCols(this.stream) ?? 120) - 8;
        this.previews.set(taskId, msg.length > width ? `${msg.slice(0, width - 1)}…` : msg);
      } catch {
        // Best-effort preview.
      }
    }
  }

  // Stop the spinner once no task or gate is in flight.
  private idle(): void {
    if (!this.active.size && !this.activeGates.size) this.spin(false);
  }

  private spin(on: boolean): void {
    if (on && !this.timer) {
      // unref: the spinner must never keep the process alive on its own.
      this.timer = setInterval(() => {
        this.frame++;
        // Preview refresh hits the task log on disk. Throttle it to about every 480ms.
        if (this.frame % 4 === 0) this.refreshPreviews();
        this.repaint();
      }, 120).unref();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export function printRunSummary(summary: RunSummary, json?: boolean): void {
  if (json) {
    printJson(summary);
    return;
  }
  const plain = !process.stdout.isTTY;
  const rail = plain ? '' : `${outStyle.dim('└─')} `;
  process.stdout.write(
    `${rail}${stepSymbol('completed', plain)} run ${outStyle.cyan(summary.runId)} completed ${outStyle.dim(`(${summary.taskCount} tasks)`)}\n`,
  );
  process.stdout.write(`\n${formatJson(summary.result)}\n`);
  printLedger(summary.tokens);
}

/** `flow run|resume --wait` and `flow watch`: render a followed run, then its summary, and exit with its outcome. Ctrl-C detaches only. `stream` (watch) with --json emits each event as a JSON line and ends with the `flow result --json` snapshot. */
export async function printFollow(
  watch: FlowWatch,
  options: { json?: boolean; stream?: boolean },
): Promise<never> {
  const { runId } = watch.record;
  const streamJson = Boolean(options.stream && options.json);
  // No waiting banner for a run that already ended: just replay + summary.
  if (!options.json && watch.record.status === 'running') {
    process.stderr.write(
      `${outStyle.dim('[flow]')} Run ${outStyle.cyan(runId)} started and is waiting to finish. Press Ctrl-C to detach. It keeps running.\n\n`,
    );
  }
  // Swallow keystroke echo while the live block is up; a stray Enter would strand a copy of the block.
  const restoreKeys = options.json ? () => {} : muteKeys();
  const onSigint = () => {
    restoreKeys();
    if (!streamJson) {
      process.stderr.write(`\n${outStyle.dim('[flow] Detached. The run is still going.')}\n`);
      process.stderr.write(
        `\n${formatHints([`Result: coder flow result ${runId}`, `Stop it: coder flow stop ${runId}`], outStyle)}\n`,
      );
    }
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  const renderer = new FlowStepRenderer();
  for await (const event of watch.events) {
    if (streamJson) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (!options.json) {
      renderer.emit(event);
    }
  }
  renderer.done();
  restoreKeys();
  process.off('SIGINT', onSigint);

  const record = watch.final();
  if (streamJson) {
    // The last line: the `flow result --json` object, kept to one JSON line.
    process.stdout.write(`${JSON.stringify(resultJson(record))}\n`);
    process.exit(record.status === 'completed' ? 0 : 1);
  }
  if (record.status === 'completed') {
    printRunSummary(
      {
        runId,
        name: record.name,
        status: 'completed',
        result: record.result,
        tokens: record.ledger,
        taskCount: record.taskCount,
      },
      options.json,
    );
    process.exit(0);
  }
  if (record.status === 'stopped') {
    if (options.json) {
      printJson({ runId, name: record.name, status: 'stopped', taskCount: record.taskCount });
    } else {
      process.stdout.write(
        `\n${outStyle.dim(`[flow] Run ${runId} stopped.`)}\n\n${formatHints([`Resume: coder flow resume ${runId}`], outStyle)}\n`,
      );
    }
    process.exit(1);
  }
  // Match `flow result`'s failure block: blank line, red `error:` prefix, plain message.
  process.stdout.write(`\n${outStyle.red('error:')} ${record.error ?? 'unknown error'}\n`);
  process.stdout.write(`\n${formatHints([`Resume: coder flow resume ${runId}`], outStyle)}\n`);
  process.exit(1);
}

export function printLedger(
  ledger: Record<string, { input: number; cachedInput: number; output: number; total: number }>,
): void {
  const models = Object.keys(ledger);
  if (!models.length) return;
  process.stdout.write(`\n${outStyle.bold('Tokens:')}\n`);
  for (const model of models) {
    process.stdout.write(`  ${outStyle.dim(formatTokens(ledger[model]!, model))}\n`);
  }
}

/** The `flow result --json` object: the record plus its trimmed journal. */
export function resultJson(result: RunResult) {
  const { steps, events, ...snapshot } = result;
  return snapshot;
}
