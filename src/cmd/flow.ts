/** `coder flow <sub>` CLI. See docs/flows.md. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import process from 'node:process';

import * as z from 'zod/mini';

import { flag, limitOption, parseArgs, str, tailOption } from '../lib/args.js';
import { CoderError } from '../lib/dispatch.js';
import { CLI_PATH } from '../lib/runtime.js';
import {
  LiveRegion,
  ageMs,
  clipPad,
  fail,
  formatAge,
  formatHints,
  formatJson,
  formatTokenCount,
  formatTokens,
  muteKeys,
  outStyle,
  paintStatus,
  printJson,
  rejectExtraArgs,
  resolveCwd,
  termCols,
  termRows,
  type LiveStream,
} from '../lib/ui.js';
import { renderCommandHelp, renderFlowGroupHelp, wantsHelp } from '../lib/help.js';
import { discoverFlows, resolveFlow } from '../flow/discover.js';
import {
  STOP_KEEP_TASKS_MARKER,
  archiveRun,
  collectFlowRuns,
  deleteRun,
  flowSteps,
  latestRun,
  listArchivedRuns,
  listRuns,
  markRunFailed,
  prepareRun,
  readFlowRecord,
  resumeFlow,
  runDirFor,
  runFlow,
  stopFlowTasks,
  stopRun,
  streamFlowCore,
} from '../flow/runtime.js';
import { readJournal } from '../flow/journal.js';
import { readJobLog } from '../lib/state.js';
import { TERMINAL_STATUSES } from '../lib/types.js';
import type { CommandHandler } from '../lib/types.js';
import type { FlowHooks, RunOptions, RunSummary } from '../flow/runtime.js';
import type { FlowEvent, FlowRecord } from '../flow/types.js';

// Marks the detached orchestrator child: the value is the run id to attach to.
// Deliberately not WORKER_ENV — the orchestrator must still be allowed to
// dispatch tasks.
const FLOW_ATTACH_ENV = 'CODER_FLOW_ATTACH';

// Bare key=value pairs -> object; each value JSON-parsed when it looks like JSON.
function parseKeyValues(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      fail(`Invalid argument "${pair}": expected key=value.`, {
        hint: 'Help: coder flow run --help',
      });
    }
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

function resolveRunArgs(argsFlag: string | undefined, positionals: string[]): unknown {
  if (argsFlag !== undefined) {
    try {
      return JSON.parse(argsFlag);
    } catch (e) {
      fail(`Invalid --args JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return positionals.length ? parseKeyValues(positionals) : {};
}

function bunAvailable(): boolean {
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// A .ts flow needs a TS-capable runtime: bun, or node with native type
// stripping (23.6+, exposed as process.features.typescript). Otherwise re-exec
// the same command under bun; fail clearly when neither is available. Runs
// before any detach, so a spawned orchestrator inherits the right execPath.
function ensureTsRuntime(scriptPath: string): void {
  if (!scriptPath.endsWith('.ts') || process.versions.bun) {
    return;
  }
  if (process.features.typescript) {
    return;
  }
  if (!bunAvailable()) {
    fail(`This flow is a TypeScript file (${scriptPath}) and this Node cannot run TypeScript.`, {
      hint: [
        'Upgrade to Node 23.6+ or install bun: https://bun.sh',
        'Or write the flow as .mjs / .js',
      ],
    });
  }
  const result = spawnSync('bun', [CLI_PATH, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

// SIGINT in the detached orchestrator child (sent by `flow stop`): stop
// dispatching, stop the run's still-running tasks (unless `flow stop
// --keep-tasks` left its marker in the run dir), stamp the run stopped, exit
// 130. Only installed in the attached child — foreground Ctrl-C never stops a
// run — so stderr here is the run's flow.log.
function installStop(h: {
  runId: string;
  requestStop: () => void;
  runningIds: () => string[];
}): void {
  process.once('SIGINT', () => {
    void (async () => {
      const { runId } = h;
      const keep = fs.existsSync(path.join(runDirFor(runId), STOP_KEEP_TASKS_MARKER));
      process.stderr.write(`\n[flow] stopping run ${runId} — no new tasks will dispatch.\n`);
      if (keep) {
        const ids = h.runningIds();
        if (ids.length) {
          process.stderr.write(`[flow] left running: ${ids.join(', ')}\n`);
        }
      } else {
        const stopped = await stopFlowTasks(runId, h.runningIds());
        if (stopped.length) {
          process.stderr.write(`[flow] stopped tasks: ${stopped.join(', ')}\n`);
        }
      }
      process.stderr.write(`[flow] resume with: coder flow resume ${runId}\n`);
      h.requestStop();
      process.exit(130);
    })();
  });
}

// The one place step-line formats live: dry-run hooks, the follower (flow
// stream / --wait), and `flow result` all paint step rows through these.
// Full-height braille frames: vertically centered in the cell, unlike the
// sparse top-heavy 4-dot set.
const SPINNER_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'];

// Status symbol: ✔ done, ✘ failed/cancelled, ● running, ○ queued/other.
// Bold so terminals draw the heavier stroke.
//
// Off a TTY the reader is a log scraper or an agent, so `plain` swaps every
// glyph for a bracketed word — `[done]`, `[failed]`, `[running]` — padded to
// one column: the same row, greppable and free of box/braille characters.
function stepSymbol(status: string, plain = false): string {
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
// and clipped (never re-cased or slugified — the text as written).
function taskLabel(name: string | undefined, prompt: string): string {
  return name ?? prompt.replace(/\s+/g, ' ').trim().slice(0, 60);
}

// `✔ Sea words      task-abc...  claude/opus/medium  15k tok` — name leads,
// then id (dim), agent and tokens (light) in fixed columns so rows align.
function taskLine(
  symbol: string,
  name: string | null,
  taskId: string,
  tokens?: { total: number } | null,
  agent?: string,
  highlight?: boolean,
): string {
  const s = outStyle;
  // Highlight is applied after clipPad: styling inside the pad would count
  // ANSI codes as width and break column alignment.
  const nameCell = clipPad(name ?? taskId, 32);
  return [
    `${symbol} ${highlight ? s.bold(nameCell) : nameCell}`,
    s.dim(clipPad(taskId, 24)),
    s.light(clipPad(agent ?? '', 20)),
    tokens ? s.light(`${formatTokenCount(tokens.total)} tok`) : '',
  ]
    .join(' ')
    .trimEnd();
}

// The run's recorded event stream (what the follower tailed), for static replay.
function readEvents(runId: string): FlowEvent[] {
  const file = path.join(runDirFor(runId), 'events.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap(line => {
      try {
        return [JSON.parse(line) as FlowEvent];
      } catch {
        return [];
      }
    });
}

// `✔ gate bun tsc` / `✘ gate bun tsc · exit 3` (plain: `[done]  gate bun tsc`).
function gateLine(e: { cmd: string; ok: boolean; code: number }, plain = false): string {
  const s = outStyle;
  const symbol = stepSymbol(e.ok ? 'completed' : 'failed', plain);
  return `${symbol} ${s.dim('gate')} ${s.light(e.cmd)}${e.ok ? '' : s.dim(` · exit ${e.code}`)}`;
}

// A gate still running: same row shape, live symbol, and (once it has run long
// enough to be worth saying) how long it has been going — a harness gate can
// hold the flow for ten minutes and the row is the only sign of life.
function gateRunningLine(cmd: string, symbol: string, elapsedMs?: number): string {
  const s = outStyle;
  const age = elapsedMs !== undefined && elapsedMs >= 1000 ? s.dim(` · ${formatAge(elapsedMs)}`) : '';
  return `${symbol} ${s.dim('gate')} ${s.light(cmd)}${age}`;
}

// Stateful step renderer shared by the dry-run hooks and the follower. Tracks
// task names across start/end events. On a TTY the running tasks form an
// "active block" of ● lines kept at the bottom: every event (and a ~120ms
// spinner tick) clears the block (cursor-up + erase-down), prints any newly
// final ✔/✘ line above it, and repaints — so a task's ● line visibly becomes
// its ✔/✘ line. Lines above the block are final and never touched. Non-TTY
// output is append-only (● on start, ✔/✘ on end) with no cursor codes.
// Tree rails: ├─ teeth per step, │ pass-through for logs; a nested (sub-flow)
// level adds a │ vertical so depth reads as a real tree.
// `last` closes the leg (└─) — used when the following line sits at a
// shallower depth, i.e. this line ends its nested group.
function stepRail(depth: number, last = false): string {
  return outStyle.dim(`${'│    '.repeat(depth)}${last ? '└─' : '├─'}`);
}
function logRail(depth: number): string {
  return outStyle.dim(`${'│    '.repeat(depth)}│ `);
}

// A finished line waiting to learn whether it closes its leg: the rail glyph
// (├─ vs └─) depends on the NEXT line's depth, so lines commit one behind.
interface PendingLine {
  depth: number;
  body: string;
  log?: boolean;
}

// Plain rows carry no rails: depth is two spaces per level and a log line gets
// the word in the status column, so every row still starts with what it is.
function paintPlain(p: PendingLine): string {
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

// Static replay with the whole row list in hand: rails are exact — a level's
// vertical stops once it has no further rows (no trailing leg below a
// last-child sub-flow), and each group's last row closes with └─.
function paintRows(rows: PendingLine[], plain = false): string[] {
  const s = outStyle;
  if (plain) return rows.map(paintPlain);
  // continues(i, level): another row lands at exactly `level` after i, before
  // the tree pops above it — deeper rows (descendants) don't extend the leg.
  const continues = (i: number, level: number): boolean => {
    for (let j = i + 1; j < rows.length; j += 1) {
      const d = rows[j]!.depth;
      if (d < level) return false;
      if (d === level) return true;
    }
    return false;
  };
  return rows.map((row, i) => {
    let rail = '';
    for (let level = 0; level < row.depth; level += 1) {
      rail += continues(i, level) ? '│    ' : '     ';
    }
    rail += row.log ? '│ ' : continues(i, row.depth) ? '├─' : '└─';
    return `${s.dim(rail)} ${row.body}`;
  });
}

export class FlowStepRenderer {
  private names = new Map<string, { name: string; agent?: string; depth?: number }>();
  private active = new Map<string, { name: string; agent?: string; depth?: number }>();
  // Gates in flight, by gate id — rendered in the active block beside tasks.
  private activeGates = new Map<string, { cmd: string; depth: number; startedAt: number }>();
  private pending: PendingLine | undefined;
  // Latest progress-log message per running task, shown as one dim railed
  // line under its row (never wrapped — a second row buys little and costs
  // half the viewport when tasks run wide).
  private previews = new Map<string, string>();
  private frame = 0;
  // Whether anything has been committed yet — the first row gets no spacer.
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
        const entry = { name: taskLabel(e.name, e.prompt), agent: e.agent, depth: e.depth ?? 0 };
        this.names.set(e.taskId, entry);
        // Off a TTY there is no live block to hold a row in, so the stream is
        // an event feed instead — `[start]` now, `[done]`/`[failed]` when it
        // ends, the same shape `coder stream` uses for a task's steps. (The
        // one-row-per-step view is `flow result`, which is a state snapshot.)
        if (!this.tty) {
          this.final(entry.depth, taskLine(startTag(), entry.name, e.taskId, null, entry.agent));
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
            known?.agent,
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
    // "+N more running" header. Task rows always outrank previews — a preview
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
      const row = `${stepRail(entry.depth ?? 0)} ${taskLine(symbol, entry.name, taskId, null, entry.agent, true)}`;
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
        const last = readJobLog(process.cwd(), taskId, 1)[0];
        const msg = last?.message?.replace(/\s+/g, ' ').trim();
        if (!msg) continue;
        const width = (termCols(this.stream) ?? 120) - 8;
        this.previews.set(taskId, msg.length > width ? `${msg.slice(0, width - 1)}…` : msg);
      } catch {
        // Best-effort preview.
      }
    }
  }

  // Stop the spinner once nothing is in flight — tasks AND gates.
  private idle(): void {
    if (!this.active.size && !this.activeGates.size) this.spin(false);
  }

  private spin(on: boolean): void {
    if (on && !this.timer) {
      // unref: the spinner must never keep the process alive on its own.
      this.timer = setInterval(() => {
        this.frame++;
        // Preview refresh hits the job log on disk — throttle to ~every 480ms.
        if (this.frame % 4 === 0) this.refreshPreviews();
        this.repaint();
      }, 120).unref();
    } else if (!on && this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

// Live progress lines for an in-process run — --dry-run only, now that real
// runs always detach. No stop handler: Ctrl-C just kills the dry run.
function foregroundHooks(options: { json?: boolean }): FlowHooks {
  if (options.json) return {};
  const renderer = new FlowStepRenderer();
  const line = (e: FlowEvent) => renderer.emit(e);
  return {
    onTaskStart: info => line({ kind: 'task-start', ...info }),
    onTaskEnd: info => line({ kind: 'task-end', ...info }),
    onGateStart: info => line({ kind: 'gate-start', ...info }),
    onGate: info => line({ kind: 'gate', ...info }),
    onLog: (message, depth) => line({ kind: 'log', message, depth }),
    onFlowStart: info => line({ kind: 'flow-start', ...info }),
    onReplay: count => line({ kind: 'replay', count }),
  };
}

// Hooks for the attached child: append every event to the run dir's
// events.jsonl (the structured stream the follower tails; flow.log stays the
// raw stdio capture) and install the stop handler `flow stop` signals.
function fileHooks(runId: string): FlowHooks {
  const file = path.join(runDirFor(runId), 'events.jsonl');
  const append = (e: FlowEvent) => {
    try {
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`, 'utf8');
    } catch {
      // Best-effort stream.
    }
  };
  return {
    onStart: h => installStop(h),
    onTaskStart: info => append({ kind: 'task-start', ...info }),
    onTaskEnd: info => append({ kind: 'task-end', ...info }),
    onGateStart: info => append({ kind: 'gate-start', ...info }),
    onGate: info => append({ kind: 'gate', ...info }),
    onLog: (message, depth) => append({ kind: 'log', message, depth }),
    onFlowStart: info => append({ kind: 'flow-start', ...info }),
    onReplay: count => append({ kind: 'replay', count }),
  };
}

// Detached-child entry (FLOW_ATTACH_ENV): the parent already wrote flow.json;
// drive the run here, stdio going to the run's flow.log. The stop handler makes
// `flow stop` (SIGINT at the recorded pid) the way to end the run.
async function attachRun(runId: string, opts: RunOptions): Promise<never> {
  try {
    await resumeFlow(runId, opts, fileHooks(runId));
    process.exit(0);
  } catch (error) {
    // drive() records flow failures itself; cover a crash before it got there,
    // so `flow result` always shows the failure.
    markRunFailed(runId, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Spawn the orchestrator as a detached child re-running this same flow command
// with the attach marker, then report the run id (unless --wait follows and
// prints its own banner). Mirrors the worker spawn in lib/dispatch.ts, minus
// WORKER_ENV. Returns the child pid for the follower's liveness bootstrap.
function detachRun(
  record: FlowRecord,
  options: { json?: boolean; wait?: boolean },
): number | undefined {
  const runDir = runDirFor(record.runId);
  // Fresh structured stream for this attempt (a resume would otherwise replay
  // the prior attempt's events into the follower).
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '', 'utf8');
  const logFd = fs.openSync(path.join(runDir, 'flow.log'), 'a');
  const child = spawn(process.execPath, [CLI_PATH, ...process.argv.slice(2)], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, [FLOW_ATTACH_ENV]: record.runId },
  });
  child.unref();
  fs.closeSync(logFd);
  if (options.wait) return child.pid;
  if (options.json) {
    printJson({ runId: record.runId, status: 'running' });
    return child.pid;
  }
  process.stdout.write(
    `${outStyle.dim('[flow]')} run ${outStyle.cyan(record.runId)} started in the background (running).\n`,
  );
  process.stdout.write(
    `\n${formatHints(
      [`Result: coder flow result ${record.runId}`, 'Runs: coder flow list'],
      outStyle,
    )}\n`,
  );
  return child.pid;
}

// Follow a detached run in the foreground, consuming streamFlowCore: replay
// events.jsonl from the start (a --wait attach truncates the file first, so
// from-0 is from-attach; `flow stream` gets the full history), render each
// event like the dry-run hooks, and finish with the record's summary and exit
// semantics. Ctrl-C detaches the follower only; the orchestrator keeps
// running. `stream` is `flow stream` mode: with --json, emit each event as a
// JSON line and end with the `flow result --json` snapshot as the last line.
async function followRun(
  runId: string,
  options: { json?: boolean; stream?: boolean; tail?: number | 'all' },
  bootPid?: number,
): Promise<never> {
  const streamJson = Boolean(options.stream && options.json);
  // No waiting banner for a run that already ended: just replay + summary.
  if (!options.json && (readFlowRecord(runId)?.status ?? 'running') === 'running') {
    process.stderr.write(
      `${outStyle.dim('[flow]')} run ${outStyle.cyan(runId)} started (running); waiting for it to finish — Ctrl-C to detach (it keeps running).\n\n`,
    );
  }
  // Swallow keystroke echo while the live block is up — a stray Enter would
  // shift the cursor and strand a copy of the block on every repaint.
  const restoreKeys = options.json ? () => {} : muteKeys();
  const onSigint = () => {
    restoreKeys();
    if (!streamJson) {
      process.stderr.write(`\n${outStyle.dim('[flow] detached — run still going.')}\n`);
      process.stderr.write(
        `\n${formatHints(
          [`Result: coder flow result ${runId}`, `Stop it: coder flow stop ${runId}`],
          outStyle,
        )}\n`,
      );
    }
    process.exit(130);
  };
  process.on('SIGINT', onSigint);

  const renderer = new FlowStepRenderer();
  for await (const event of streamFlowCore(runId, bootPid, { tail: options.tail })) {
    if (streamJson) {
      process.stdout.write(`${JSON.stringify(event)}\n`);
    } else if (!options.json) {
      renderer.emit(event);
    }
  }
  renderer.done();
  restoreKeys();
  process.off('SIGINT', onSigint);

  const record = readFlowRecord(runId);
  if (!record) {
    fail(`[flow] run ${runId} vanished while following.`, {
      hint: 'Recent runs: coder flow list',
    });
  }
  if (streamJson) {
    // The last line: the `flow result --json` object, kept to one JSON line.
    process.stdout.write(`${JSON.stringify(resultSnapshot(record))}\n`);
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
        `\n${outStyle.dim(`[flow] run ${runId} stopped — resume: coder flow resume ${runId}`)}\n`,
      );
    }
    process.exit(1);
  }
  // Match `flow result`'s failure block: blank line, red `error:` prefix,
  // plain message — not one all-red wall glued to the tree.
  process.stdout.write(`\n${outStyle.red('error:')} ${record.error ?? 'unknown error'}\n`);
  process.stdout.write(`\n${formatHints([`Resume: coder flow resume ${runId}`], outStyle)}\n`);
  process.exit(1);
}

// Flags shared by flow run and flow resume (resume accepts the same flags).
const RUN_FLAGS = {
  cwd: str,
  json: flag,
  args: str,
  wait: flag,
  concurrency: str,
  'max-tasks': str,
  'dry-run': flag,
};

const num = (value?: string): number | undefined => (value ? Number(value) : undefined);

// The shared run/resume dispatch shape. True when handled without driving here:
// as the detached child this attaches and never returns; otherwise it always
// spawns the child, with --wait following it in the foreground. Only --dry-run
// (whose point is its printed output, and which dispatches nothing) drives
// in-process.
async function attachOrDetach(
  options: { json?: boolean; wait?: boolean; 'dry-run'?: boolean },
  opts: RunOptions,
  prepare: () => FlowRecord,
): Promise<boolean> {
  const attachId = process.env[FLOW_ATTACH_ENV];
  if (attachId) {
    delete process.env[FLOW_ATTACH_ENV];
    await attachRun(attachId, opts);
  }
  if (options['dry-run']) return false;
  const record = prepare();
  const pid = detachRun(record, options);
  if (options.wait) await followRun(record.runId, options, pid);
  return true;
}

function printRunSummary(summary: RunSummary, json?: boolean): void {
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

function failFlowError(error: unknown, verb: 'run' | 'resume', dryRun?: boolean): never {
  if (error instanceof CoderError && error.code === 'flow-failed') {
    const note = dryRun
      ? '\n[flow] dry-run ended early: a downstream step depends on real task output (stub it or run for real).'
      : '';
    fail(`[flow] ${verb} ${error.runId} failed: ${error.message}${note}`, {
      hint: `Resume${verb === 'resume' ? ' again' : ''}: coder flow resume ${error.runId}`,
    });
  }
  throw error;
}

async function flowRun(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, z.object(RUN_FLAGS));
  const [ref, ...rest] = positionals;
  if (!ref) {
    fail('Missing flow name or path.', {
      hint: ['Usage: coder flow run <name|path>', 'List: coder flow discover'],
    });
  }
  const cwd = resolveCwd(options);
  ensureTsRuntime(resolveFlow(ref, cwd).path);
  const opts = {
    args: resolveRunArgs(options.args, rest),
    cwd,
    dryRun: options['dry-run'],
    concurrency: num(options.concurrency),
    maxTasks: num(options['max-tasks']),
  };
  if (await attachOrDetach(options, opts, () => prepareRun(ref, opts))) return;

  try {
    printRunSummary(await runFlow(ref, opts, foregroundHooks(options)), options.json);
  } catch (error) {
    failFlowError(error, 'run', opts.dryRun);
  }
}

function printLedger(
  ledger: Record<string, { input: number; cachedInput: number; output: number; total: number }>,
): void {
  const models = Object.keys(ledger);
  if (!models.length) return;
  process.stdout.write(`\n${outStyle.bold('Tokens:')}\n`);
  for (const model of models) {
    process.stdout.write(`  ${outStyle.dim(formatTokens(ledger[model]!, model))}\n`);
  }
}

async function flowList(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ cwd: str, json: flag, archived: flag, limit: limitOption }),
  );
  rejectExtraArgs(positionals, 0, 'flow list');
  const limit = options.limit === 'all' ? undefined : options.limit;
  const { runs, clipped } = collectFlowRuns({ archived: options.archived, limit });
  if (options.json) {
    printJson(runs);
    return;
  }
  if (!runs.length) {
    process.stdout.write(options.archived ? 'No archived flow runs.\n' : 'No recent flow runs.\n');
    process.stdout.write(
      `\n${formatHints(
        ['Run one: coder flow run <name>', 'Runnable flows: coder flow discover'],
        outStyle,
      )}\n`,
    );
    return;
  }
  const s = outStyle;
  process.stdout.write(
    s.bold(
      s.light(
        `${'run-id'.padEnd(24)} ${'name'.padEnd(20)} ${'status'.padEnd(10)} ${'tasks'.padEnd(9)} ${'tokens'.padEnd(10)} age\n`,
      ),
    ),
  );
  for (const r of runs) {
    const tokens = Object.values(r.ledger).reduce((sum, t) => sum + t.total, 0);
    process.stdout.write(
      `${s.cyan(clipPad(r.runId, 24))} ${clipPad(r.name, 20)} ${paintStatus(r.status, 10)} ${s.light(clipPad(`${r.taskCount} tasks`, 9))} ${s.light(clipPad(tokens ? `${formatTokenCount(tokens)} tok` : '-', 10))} ${s.light(formatAge(ageMs(r.startedAt)))}\n`,
    );
  }
  if (clipped) {
    process.stdout.write(s.dim(`\n... ${clipped} more not shown (--limit ${limit})\n`));
  }
  process.stdout.write(
    `\n${formatHints(
      [
        'Result: coder flow result <run-id>',
        'Tasks: coder list',
        'Runnable flows: coder flow discover',
      ],
      s,
    )}\n`,
  );
}

async function flowDiscover(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, z.object({ cwd: str, json: flag }));
  rejectExtraArgs(positionals, 0, 'flow discover');
  const cwd = resolveCwd(options);
  const flows = discoverFlows(cwd);
  if (options.json) {
    printJson(flows);
    return;
  }
  if (!flows.length) {
    process.stdout.write(
      'No flows found in .coder/flows/ (workspace) or ~/.coder/flows/ (global).\n',
    );
    process.stdout.write(`\n${formatHints(['Authoring guide: coder docs flows'], outStyle)}\n`);
    return;
  }
  const s = outStyle;
  process.stdout.write(s.bold(s.light(`${'name'.padEnd(24)} ${'scope'.padEnd(10)} path\n`)));
  for (const f of flows) {
    // Workspace flows read better relative to where you stand; global ones
    // live under ~, so shorten that too.
    const shown =
      f.scope === 'workspace'
        ? path.relative(cwd, f.path) || f.path
        : f.path.replace(os.homedir(), '~');
    process.stdout.write(
      `${s.cyan(f.name.padEnd(24))} ${s.light(f.scope.padEnd(10))} ${s.light(shown)}\n`,
    );
  }
  process.stdout.write(
    `\n${formatHints(['Run one: coder flow run <name>', 'Recent runs: coder flow list'], s)}\n`,
  );
}

// The `flow result --json` object: the record plus a trimmed journal.
function resultSnapshot(record: FlowRecord) {
  const journal = readJournal(`${runDirFor(record.runId)}/journal.jsonl`);
  return {
    ...record,
    journal: journal.map(e => ({ kind: e.kind, taskId: e.taskId, tokens: e.tokens })),
  };
}

// `tail` caps the step rows via flowSteps — the same core `flow.result` uses,
// so CLI --tail and SDK tail are one path. CLI rendering only; --json keeps
// the full snapshot.
function renderResult(record: FlowRecord, json: boolean, tail: number | 'all' = 'all'): void {
  if (json) {
    printJson(resultSnapshot(record));
    return;
  }
  const s = outStyle;
  // Same plain-vs-glyph split the follower makes: a piped `flow result` is
  // being read by a log scraper or an agent.
  const plain = !process.stdout.isTTY;
  process.stdout.write(
    `${s.bold('Flow')} ${s.cyan(record.name)} ${s.dim(`(${record.runId})`)} — ${s.bold(paintStatus(record.status))}\n`,
  );
  // taskCount in flow.json only lands on terminal writes; while running, count
  // live from the step rows ("done/dispatched") so the header never says 0.
  const allSteps = flowSteps(record.runId);
  const done = allSteps.filter(st =>
    (TERMINAL_STATUSES as readonly string[]).includes(st.status),
  ).length;
  const tasksNote =
    record.status === 'running' ? `${done}/${allSteps.length} tasks` : `${record.taskCount} tasks`;
  process.stdout.write(
    `${s.dim(`started ${record.startedAt}${record.endedAt ? ` · ended ${record.endedAt}` : ''} · ${tasksNote}`)}\n`,
  );
  // The step section IS the stream's story, replayed statically from
  // events.jsonl: identical task/gate/log lines, still-running tasks as ⏺.
  if (tail !== 0) {
    const events = readEvents(record.runId);
    const names = new Map<string, { name: string; agent?: string; depth?: number }>();
    const started = new Map<string, { name: string; agent?: string; depth?: number }>();
    const startedGates = new Map<string, { cmd: string; depth: number }>();
    const rows: PendingLine[] = [];
    for (const e of events) {
      if (e.kind === 'task-start') {
        const entry = { name: taskLabel(e.name, e.prompt), agent: e.agent, depth: e.depth ?? 0 };
        names.set(e.taskId, entry);
        started.set(e.taskId, entry);
      } else if (e.kind === 'task-end') {
        started.delete(e.taskId);
        const known = names.get(e.taskId);
        rows.push({
          depth: known?.depth ?? 0,
          body: taskLine(
            stepSymbol(e.status, plain),
            known?.name ?? null,
            e.taskId,
            e.tokens,
            known?.agent,
          ),
        });
      } else if (e.kind === 'gate-start') {
        startedGates.set(e.gateId, { cmd: e.cmd, depth: e.depth ?? 0 });
      } else if (e.kind === 'gate') {
        if (e.gateId) startedGates.delete(e.gateId);
        rows.push({ depth: e.depth ?? 0, body: gateLine(e, plain) });
      } else if (e.kind === 'log') {
        for (const l of e.message.split('\n'))
          rows.push({ depth: e.depth ?? 0, body: s.light(l), log: true });
      } else if (e.kind === 'flow-start') {
        rows.push({ depth: e.depth - 1, body: s.bold(`flow ${e.name}`) });
      }
    }
    for (const [taskId, entry] of started) {
      rows.push({
        depth: entry.depth ?? 0,
        // Static view has no spinner — say it in words (plain rows already
        // carry `running` in the status column).
        body: taskLine(stepSymbol('running', plain), entry.name, taskId, null, entry.agent) +
          (plain ? '' : ` ${s.light('running')}`),
      });
    }
    for (const gate of startedGates.values()) {
      rows.push({
        depth: gate.depth,
        body:
          gateRunningLine(gate.cmd, stepSymbol('running', plain)) +
          (plain ? '' : ` ${s.light('running')}`),
      });
    }
    if (!rows.length) {
      // Pre-events runs (or a wiped stream): fall back to the step rollup.
      for (const step of tail === 'all' ? allSteps : flowSteps(record.runId, tail)) {
        rows.push({
          depth: 0,
          body: taskLine(stepSymbol(step.status, plain), step.name, step.taskId ?? '-', step.tokens),
        });
      }
    }
    const lines = paintRows(rows, plain);
    const shown = tail === 'all' ? lines : lines.slice(-tail);
    if (shown.length) {
      process.stdout.write(`\n${shown.join('\n')}\n`);
    }
  }
  if (record.endedAt && record.result !== undefined) {
    process.stdout.write(`\n${s.bold('Result:')}\n${formatJson(record.result)}\n`);
  }
  if (record.error) {
    process.stdout.write(`\n${s.red('error:')} ${record.error}\n`);
  }
  printLedger(record.ledger);
  // Next actions: follow/stop while it runs, resume after an interruption.
  const hints =
    record.status === 'running'
      ? [
          `Follow live: coder flow stream ${record.runId}`,
          `Stop it: coder flow stop ${record.runId}`,
        ]
      : record.status === 'stopped' || record.status === 'failed'
        ? [`Resume: coder flow resume ${record.runId}`]
        : [];
  if (hints.length) {
    process.stdout.write(`\n${formatHints(hints, s)}\n`);
  }
}

async function flowResult(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(
    argv,
    z.object({
      cwd: str,
      json: flag,
      tail: tailOption,
    }),
  );
  const record = positionals[0] ? readFlowRecord(positionals[0]) : latestRun();
  if (!record) {
    if (options.json) {
      printJson(null);
      return;
    }
    fail(positionals[0] ? `No flow run "${positionals[0]}".` : 'No flow runs yet.', {
      hint: 'Run one: coder flow run <name>',
    });
  }
  renderResult(record, Boolean(options.json), options.tail);
}

// Replay the run's full event stream then track it live (or, on a terminal
// run, just replay + summary) with --wait's exit semantics.
async function flowStream(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ cwd: str, json: flag, tail: tailOption }),
  );
  const record = positionals[0] ? readFlowRecord(positionals[0]) : latestRun();
  if (!record) {
    fail(positionals[0] ? `No flow run "${positionals[0]}".` : 'No flow runs yet.', {
      hint: 'Run one: coder flow run <name>',
    });
  }
  await followRun(record.runId, { json: options.json, stream: true, tail: options.tail });
}

async function flowStop(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ cwd: str, json: flag, 'keep-tasks': flag }),
  );
  rejectExtraArgs(positionals, 1, 'flow stop');
  try {
    const summary = await stopRun(positionals[0], { keepTasks: options['keep-tasks'] });
    if (options.json) {
      printJson(summary);
      return;
    }
    const s = outStyle;
    if (summary.status === 'failed') {
      // Stale record reconciled: the orchestrator was already dead.
      process.stdout.write(
        `${s.dim('[flow]')} run ${s.cyan(summary.runId)} orchestrator died — marked ${paintStatus('failed')}.\n`,
      );
    } else {
      process.stdout.write(
        `${s.dim('[flow]')} run ${s.cyan(summary.runId)} ${paintStatus(summary.status)}.\n`,
      );
    }
    if (summary.stoppedTasks.length) {
      process.stdout.write(
        `${s.dim('[flow]')} stopped tasks: ${summary.stoppedTasks.join(', ')}\n`,
      );
    }
    if (summary.keptTasks.length) {
      process.stdout.write(`${s.dim('[flow]')} left running: ${summary.keptTasks.join(', ')}\n`);
    }
    process.stdout.write(`\n${formatHints([`Resume: coder flow resume ${summary.runId}`], s)}\n`);
  } catch (error) {
    if (error instanceof CoderError && error.code === 'flow-failed') {
      fail(error.message, error.hint ? { hint: error.hint } : {});
    }
    throw error;
  }
}

async function flowResume(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, z.object(RUN_FLAGS));
  const record = positionals[0] ? readFlowRecord(positionals[0]) : latestRun();
  if (!record) {
    fail(positionals[0] ? `No flow run "${positionals[0]}".` : 'No flow runs to resume.', {
      hint: 'Run one: coder flow run <name>',
    });
  }
  ensureTsRuntime(record.script);
  const opts = {
    cwd: resolveCwd(options),
    dryRun: options['dry-run'],
    concurrency: num(options.concurrency),
    maxTasks: num(options['max-tasks']),
    ...(options.args !== undefined ? { args: resolveRunArgs(options.args, []) } : {}),
  };
  if (await attachOrDetach(options, opts, () => prepareRun('', opts, record.runId))) return;

  try {
    printRunSummary(await resumeFlow(record.runId, opts, foregroundHooks(options)), options.json);
  } catch (error) {
    failFlowError(error, 'resume', opts.dryRun);
  }
}

// A run flow archive/delete can act on: exact id, terminal (running refuses).
function requireStoppedRun(reference: string): FlowRecord {
  const record = readFlowRecord(reference);
  if (!record) {
    fail(`No flow run "${reference}".`, { hint: 'Recent runs: coder flow list' });
  }
  if (record.status === 'running' || record.status === 'queued') {
    fail(`Run ${record.runId} is still running.`, {
      hint: `Stop it first: coder flow stop ${record.runId}`,
    });
  }
  return record;
}

// coder flow archive <run-id>      -> hide one run from the default list
// coder flow archive --all-stopped -> archive every stopped (finished) run at once
async function flowArchive(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ cwd: str, json: flag, 'all-stopped': flag }),
  );
  rejectExtraArgs(positionals, 1, 'flow archive');

  if (options['all-stopped']) {
    const targets = listRuns().filter(r => r.status !== 'running' && r.status !== 'queued');
    for (const record of targets) {
      archiveRun(record);
    }
    const ids = targets.map(record => record.runId);
    if (options.json) {
      printJson({ archived: ids, count: ids.length });
      return;
    }
    process.stdout.write(
      ids.length
        ? `Archived ${ids.length} stopped run${ids.length === 1 ? '' : 's'}.\n`
        : `${outStyle.dim('No stopped runs to archive.')}\n`,
    );
    return;
  }

  const reference = positionals[0];
  if (!reference) {
    fail('Missing run id.', {
      hint: [
        'Archive one: coder flow archive <run-id>',
        'Archive all stopped: coder flow archive --all-stopped',
      ],
    });
  }
  const record = requireStoppedRun(reference);
  archiveRun(record);
  if (options.json) {
    printJson({ runId: record.runId, archived: true });
    return;
  }
  process.stdout.write(`Archived run ${outStyle.cyan(record.runId)}.\n`);
}

// coder flow delete <run-id>       -> remove one run's record from disk
// coder flow delete --all-archived -> remove every archived run at once
async function flowDelete(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ cwd: str, json: flag, 'all-archived': flag }),
  );
  rejectExtraArgs(positionals, 1, 'flow delete');

  if (options['all-archived']) {
    const ids = listArchivedRuns()
      .filter(record => deleteRun(record.runId))
      .map(record => record.runId);
    if (options.json) {
      printJson({ deleted: ids, count: ids.length });
      return;
    }
    process.stdout.write(
      ids.length
        ? `Deleted ${ids.length} archived run${ids.length === 1 ? '' : 's'}.\n`
        : `${outStyle.dim('No archived runs to delete.')}\n`,
    );
    return;
  }

  const reference = positionals[0];
  if (!reference) {
    fail('Missing run id.', {
      hint: [
        'Delete one: coder flow delete <run-id>',
        'Delete all archived: coder flow delete --all-archived',
      ],
    });
  }
  const record = requireStoppedRun(reference);
  deleteRun(record.runId);
  if (options.json) {
    printJson({ runId: record.runId, deleted: true });
    return;
  }
  process.stdout.write(`Deleted run ${outStyle.cyan(record.runId)}.\n`);
}

const FLOW_SUBCOMMANDS: Record<string, CommandHandler> = {
  run: flowRun,
  list: flowList,
  discover: flowDiscover,
  result: flowResult,
  stream: flowStream,
  stop: flowStop,
  resume: flowResume,
  archive: flowArchive,
  delete: flowDelete,
};

export async function commandFlow(argv: string[]): Promise<void> {
  const [sub, ...rest] = argv;
  if (sub === undefined || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(renderFlowGroupHelp());
    return;
  }
  const handler = FLOW_SUBCOMMANDS[sub];
  if (!handler) {
    process.stdout.write(renderFlowGroupHelp());
    process.stdout.write('\n');
    fail(`Unknown flow subcommand "${sub}".`, { hint: 'Run a flow: coder flow run <name>' });
  }
  if (wantsHelp(rest)) {
    process.stdout.write(renderCommandHelp(`flow ${sub}`) ?? renderFlowGroupHelp());
    return;
  }
  await handler(rest);
}

export { listRuns };
