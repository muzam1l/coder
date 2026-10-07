/** Running a flow in this process: prepare its record, drive it to a result, stop it, resume it, follow its events. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { CoderError } from '../core/dispatch';
import { listTasks, processStartMs, loadTask } from '../core/state';
import { createJsonlTail } from '../utils/fsx';
import { stopTask } from '../core/task/actions';
import { TERMINAL_STATUSES, type TokenUsage } from '../core/types';
import { Journal, readJournal } from './journal';
import { resolveFlow } from './discover';
import type { FlowEvent, FlowRecord } from './types';
import {
  generateRunId,
  latestRun,
  readFlowRecord,
  readRawRecord,
  runDirFor,
  unarchiveRun,
  writeFlowRecord,
} from './runs';
import {
  type FlowHooks,
  type RunContext,
  ctxALS,
  scopeALS,
  Semaphore,
  loadAndRun,
} from './runtime';

// ---------------------------------------------------------------------------
// executeRun is the journaled orchestrator for the CLI and SDK.
// ---------------------------------------------------------------------------

export interface RunOptions {
  runId?: string;
  args?: unknown;
  concurrency?: number;
  maxTasks?: number;
  dryRun?: boolean;
  cwd?: string;
  /** Platform credential for built-in integrations; never persisted with the run. */
  integrationToken?: string;
  /** The agent whose permissions cap every task this run starts. */
  ceiling?: { agent: string; permissions: string };
}

export interface RunSummary {
  runId: string;
  name: string;
  status: 'completed';
  result: unknown;
  tokens: Record<string, TokenUsage>;
  taskCount: number;
}

interface StartedRun {
  runId: string;
  runDir: string;
  ctx: RunContext;
  markStopped: () => void;
}

/**
 * Resolve the flow and write flow.json with running status. The run record is a
 * detached orchestrator (or beginRun below) attaches to.
 */
export function prepareRun(ref: string, opts: RunOptions = {}, resumeRunId?: string): FlowRecord {
  let name: string;
  let script: string;
  let args: unknown;

  if (resumeRunId) {
    const prior = readFlowRecord(resumeRunId);
    if (!prior) throw new Error(`No flow run "${resumeRunId}".`);
    // An archived run becomes running again: move it back to the live bin.
    if (prior.archived) unarchiveRun(prior);
    name = prior.name;
    script = prior.script;
    args = opts.args ?? prior.args;
  } else {
    const resolved = resolveFlow(ref, opts.cwd ? path.resolve(opts.cwd) : process.cwd());
    name = resolved.name;
    script = resolved.path;
    args = opts.args ?? {};
  }

  const runId = resumeRunId ?? opts.runId ?? generateRunId();
  const runDir = runDirFor(runId);
  fs.mkdirSync(runDir, { recursive: true });

  const record: FlowRecord = {
    runId,
    name,
    script,
    args,
    status: 'running',
    startedAt: new Date().toISOString(),
    concurrency: Math.max(1, opts.concurrency ?? os.cpus().length),
    maxTasks: Math.max(1, opts.maxTasks ?? os.cpus().length * 10),
    taskCount: 0,
    ledger: {},
  };
  writeFlowRecord(runDir, record);
  return record;
}

// Terminal write: stamp endedAt and clear the orchestrator pid.
function endRecord(runDir: string, record: FlowRecord, patch: Partial<FlowRecord>): void {
  writeFlowRecord(runDir, {
    ...record,
    endedAt: new Date().toISOString(),
    pid: undefined,
    pidStartedAt: undefined,
    ...patch,
  });
}

/** Mark a running record failed when a detached orchestrator crashes before drive(). */
export function markRunFailed(runId: string, error: string): void {
  const record = readRawRecord(runId);
  if (!record || record.status !== 'running') return;
  endRecord(runDirFor(runId), record, { status: 'failed', error });
}

// ---------------------------------------------------------------------------
// stopRun signals a running orchestrator and reconciles the CLI and SDK.
// ---------------------------------------------------------------------------

/** Written by `flow stop --keep-tasks` before signalling; the SIGINT handler skips task stops when present. */
export const STOP_KEEP_TASKS_MARKER = 'stop-keep-tasks';

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Liveness with a recycled-pid guard: a live pid whose process started well
// after the record stamped it is NOT our orchestrator (the real one died and
// the OS reused the number). This mirrors pidIsOurWorker for task workers.
export function orchestratorAlive(record: FlowRecord): boolean {
  if (!record.pid || !pidAlive(record.pid)) return false;
  const started = processStartMs(record.pid);
  const recorded = Date.parse(record.pidStartedAt ?? '');
  if (started === null || !Number.isFinite(recorded)) {
    return true; // Cannot verify the start time, so trust liveness.
  }
  return started <= recorded + 60_000;
}

// A run's non-terminal task ids: journal entries plus tasks tagged with the run id.
function runningTaskIdsFor(runId: string): string[] {
  const tasks = listTasks(process.cwd());
  const byId = new Map(tasks.map(j => [j.id, j]));
  const ids = new Set<string>(tasks.filter(j => j.flowRunId === runId).map(j => j.id));
  for (const e of readJournal(path.join(runDirFor(runId), 'journal.jsonl'))) {
    if (e.kind === 'task' && e.taskId) ids.add(e.taskId);
  }
  return [...ids].filter(id => {
    const task = byId.get(id);
    return !!task && !TERMINAL_STATUSES.includes(task.status);
  });
}

/** Stop every non-terminal task of a run via the task-stop core. Print-free. */
export async function stopFlowTasks(runId: string, extraIds: string[] = []): Promise<string[]> {
  const cwd = process.cwd();
  const stopped: string[] = [];
  for (const id of new Set([...runningTaskIdsFor(runId), ...extraIds])) {
    const task = loadTask(cwd, id);
    if (!task || TERMINAL_STATUSES.includes(task.status)) continue;
    try {
      await stopTask(cwd, task);
      stopped.push(id);
    } catch {
      // Task already gone.
    }
  }
  return stopped;
}

export interface StopSummary {
  runId: string;
  status: FlowRecord['status'];
  stoppedTasks: string[];
  keptTasks: string[];
}

/**
 * Stop a running flow: verify the orchestrator pid is alive, SIGINT it, and
 * wait for the record to leave 'running'. A dead pid on a running record is
 * reconciled to failed (nothing chose to stop it) without signalling anything.
 */
export async function stopRun(
  runId?: string,
  opts: { keepTasks?: boolean } = {},
): Promise<StopSummary> {
  const record = runId ? readFlowRecord(runId) : latestRun();
  if (!record) {
    throw new CoderError('flow-failed', runId ? `No flow run "${runId}".` : 'No flow runs.', {
      hint: 'Run one: coder flow run <name>',
    });
  }
  if (record.status !== 'running') {
    throw new CoderError('flow-failed', `Run ${record.runId} is not running.`, {
      runId: record.runId,
      hint: `Result: coder flow result ${record.runId}`,
    });
  }
  const runDir = runDirFor(record.runId);
  if (!orchestratorAlive(record)) {
    endRecord(runDir, record, { status: 'failed', error: 'orchestrator died' });
    return {
      runId: record.runId,
      status: 'failed',
      stoppedTasks: [],
      keptTasks: runningTaskIdsFor(record.runId),
    };
  }

  const candidates = runningTaskIdsFor(record.runId);
  const marker = path.join(runDir, STOP_KEEP_TASKS_MARKER);
  if (opts.keepTasks) fs.writeFileSync(marker, '', 'utf8');
  try {
    process.kill(record.pid!, 'SIGINT');
    // The handler stops tasks first, then stamps a terminal status; poll for it.
    let current = readFlowRecord(record.runId);
    for (let i = 0; i < 25 && current?.status === 'running'; i += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      current = readFlowRecord(record.runId);
    }
    if (!current || current.status === 'running') {
      throw new CoderError('flow-failed', `Run ${record.runId} did not stop within 5s.`, {
        runId: record.runId,
        hint: `Check it: coder flow result ${record.runId}`,
      });
    }
    // Classify by what actually happened: cancelled means the handler stopped
    // it; still-running means kept; finished on its own is neither.
    const cwd = process.cwd();
    const stoppedTasks: string[] = [];
    const keptTasks: string[] = [];
    for (const id of candidates) {
      const task = loadTask(cwd, id);
      if (!task) continue;
      if (task.status === 'cancelled') stoppedTasks.push(id);
      else if (!TERMINAL_STATUSES.includes(task.status)) keptTasks.push(id);
    }
    return { runId: record.runId, status: current.status, stoppedTasks, keptTasks };
  } finally {
    if (opts.keepTasks) {
      try {
        fs.unlinkSync(marker);
      } catch {
        // Already consumed.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// streamFlowCore follows a run's event stream for the CLI and SDK.
// ---------------------------------------------------------------------------

/**
 * Print-free follower (SDK `flow.stream`): replay the run's events.jsonl from
 * the start, tail it at 400ms, and end once the run leaves 'running'. A dead
 * orchestrator pid on a still-running record is reconciled to failed; the
 * caller reads the record afterwards for the summary. `bootPid` is the spawned
 * child's pid, checked until the orchestrator records its own. `tail` replays
 * only the last n events already logged (default 'all').
 */
export async function* streamFlowCore(
  runId: string,
  bootPid?: number,
  opts: { tail?: number | 'all' } = {},
): AsyncGenerator<FlowEvent> {
  const eventsFile = path.join(runDirFor(runId), 'events.jsonl');
  // Skip everything older than the last `tail` events.
  const tail = opts.tail ?? 'all';
  let emitted = 0;
  if (tail !== 'all') {
    try {
      emitted = Math.max(0, fs.readFileSync(eventsFile, 'utf8').split('\n').length - 1 - tail);
    } catch {
      // No stream yet.
    }
  }
  // Incremental tail: each tick reads only the appended bytes (a follower on
  // a chatty run would otherwise re-parse the whole stream every 400ms).
  const tailLines = createJsonlTail(eventsFile);
  const drain = (): FlowEvent[] => {
    const fresh: FlowEvent[] = [];
    for (const line of tailLines()) {
      // `emitted` skips the pre-counted head when a numeric tail was asked for.
      if (emitted > 0) {
        emitted -= 1;
        continue;
      }
      try {
        fresh.push(JSON.parse(line) as FlowEvent);
      } catch {
        // Skip a malformed line.
      }
    }
    return fresh;
  };

  let record = readFlowRecord(runId);
  while (!record || record.status === 'running') {
    yield* drain();
    // The run dying without a terminal write: pid dead (boot pid until the
    // orchestrator records its own) on a still-running record.
    // Prefer the record's own pid (with the recycled-pid guard); the boot pid
    // only bridges the gap before the orchestrator records itself.
    const dead = record?.pid
      ? !orchestratorAlive(record)
      : bootPid !== undefined && !pidAlive(bootPid);
    if (record && (record.pid || bootPid !== undefined) && dead) {
      markRunFailed(runId, 'orchestrator died');
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 400));
    record = readFlowRecord(runId) ?? record;
  }
  yield* drain();
}

// Build the context and flow.json for a fresh or resumed run.
function beginRun(
  ref: string,
  opts: RunOptions,
  hooks: FlowHooks,
  resumeRunId?: string,
): {
  started: StartedRun;
  args: unknown;
  name: string;
  replayable: number;
} {
  // This process is the one driving the run: record its pid for `flow stop`.
  const record: FlowRecord = {
    ...prepareRun(ref, opts, resumeRunId),
    pid: process.pid,
    pidStartedAt: new Date().toISOString(),
  };
  const { runId } = record;
  const runDir = runDirFor(runId);
  writeFlowRecord(runDir, record);

  const journalFile = path.join(runDir, 'journal.jsonl');
  const recorded = resumeRunId ? readJournal(journalFile) : [];
  const journal = new Journal(recorded, journalFile);

  const ctx: RunContext = {
    runId,
    runDir,
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    journal,
    semaphore: new Semaphore(record.concurrency),
    flowConcurrency: opts.concurrency === undefined,
    maxTasks: record.maxTasks,
    dryRun: opts.dryRun ?? false,
    ledger: {},
    running: new Set(),
    taskCount: 0,
    stopping: false,
    hooks,
    ...(opts.integrationToken ? { integrationToken: opts.integrationToken } : {}),
    ...(opts.ceiling ? { ceiling: opts.ceiling } : {}),
  };

  const markStopped = () => {
    ctx.stopping = true;
    endRecord(runDir, record, {
      status: 'stopped',
      concurrency: ctx.semaphore.limit,
      taskCount: ctx.taskCount,
      ledger: ctx.ledger,
    });
  };

  return {
    started: { runId, runDir, ctx, markStopped },
    args: record.args,
    name: record.name,
    replayable: recorded.length,
  };
}

async function drive(
  started: StartedRun,
  script: string,
  name: string,
  args: unknown,
): Promise<RunSummary> {
  const { ctx, runDir, runId } = started;
  const base = readFlowRecord(runId)!;
  try {
    const result = await ctxALS.run(ctx, () =>
      scopeALS.run({ args: args ?? {}, depth: 0 }, () => loadAndRun(script, args)),
    );
    endRecord(runDir, base, {
      status: 'completed',
      concurrency: ctx.semaphore.limit,
      taskCount: ctx.taskCount,
      ledger: ctx.ledger,
      result,
    });
    return {
      runId,
      name,
      status: 'completed',
      result,
      tokens: ctx.ledger,
      taskCount: ctx.taskCount,
    };
  } catch (e) {
    if (!ctx.stopping) {
      endRecord(runDir, base, {
        status: 'failed',
        concurrency: ctx.semaphore.limit,
        taskCount: ctx.taskCount,
        ledger: ctx.ledger,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    if (
      e instanceof CoderError &&
      (e.code === 'chain-exhausted' || e.code === 'approval-pending')
    ) {
      e.runId ??= runId;
      throw e;
    }
    throw new CoderError('flow-failed', e instanceof Error ? e.message : String(e), { runId });
  }
}

/**
 * The one run path every flow takes: resolve it by name (built-ins included) or
 * path, then run it in this process. `hooks.onStart` receives a stop handle so a
 * CLI can install a SIGINT handler; the event hooks feed live progress rendering.
 */
export async function runFlowByName(
  ref: string,
  opts: RunOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary> {
  const { started } = beginRun(ref, opts, hooks);
  const script = readFlowRecord(started.runId)!.script;
  hooks.onStart?.({
    runId: started.runId,
    requestStop: started.markStopped,
    runningIds: () => [...started.ctx.running],
  });
  return drive(started, script, readFlowRecord(started.runId)!.name, opts.args ?? {});
}

export async function resumeFlow(
  runId: string,
  opts: RunOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary> {
  const { started, args, name, replayable } = beginRun('', opts, hooks, runId);
  const script = readFlowRecord(runId)!.script;
  hooks.onStart?.({
    runId,
    requestStop: started.markStopped,
    runningIds: () => [...started.ctx.running],
  });
  if (replayable) hooks.onReplay?.(replayable);
  return drive(started, script, name, args);
}
