/** Running a flow in this process: prepare its record, drive it to a result, stop it, resume it, follow its events. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { CoderError } from '../core/dispatch';
import { processStartMs, processStarts, loadTask } from '../core/state';
import { createJsonlTail, watchChanges } from '../utils/fsx';
import { stopTask } from '../core/task/actions';
import { TERMINAL_STATUSES, type Access, type TokenUsage } from '../core/types';
import {
  Journal,
  readJournal,
  type FlowHooks,
  type RunContext,
  ctxALS,
  scopeALS,
  Semaphore,
  loadAndRun,
  emitFlowEvent,
} from './runtime';
import { resolveFlow } from './discover';
import type { FlowEvent, FlowRecord } from './types';
import type { ReviewArgs, ReviewResult } from './builtin/review';
import {
  generateRunId,
  latestRun,
  readFlowRecord,
  readRawRecord,
  runDirFor,
  unarchiveRun,
  writeFlowRecord,
  flowTaskIds,
} from './runs';

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
  connections?: RunContext['connections'];
  /** The agent's access, which caps every task this run starts. */
  access?: Access;
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
  record: FlowRecord;
  ctx: RunContext;
  replayable: number;
  markStopped: () => void;
}

/** Prepare a live run for this process or its detached orchestrator. */
export function prepareRun(
  ref: string,
  opts: RunOptions = {},
  resumeRunId?: string,
  pid?: number,
): FlowRecord {
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
    ...(pid ? { pid, pidStartedAt: new Date().toISOString() } : {}),
    ...(opts.concurrency !== undefined ? { concurrencySet: true } : {}),
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

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Liveness with a recycled-pid guard: a live pid whose process started well
// after the record stamped it is NOT our orchestrator (the real one died and
// the OS reused the number). This mirrors pidIsOurWorker for task workers.
export function orchestratorAlive(record: FlowRecord, startMs = processStartMs): boolean {
  if (!record.pid || !pidAlive(record.pid)) return false;
  const started = startMs(record.pid);
  const recorded = Date.parse(record.pidStartedAt ?? '');
  if (started === null || !Number.isFinite(recorded)) {
    return true; // Cannot verify the start time, so trust liveness.
  }
  return started <= recorded + 60_000;
}

function runningTaskIdsFor(runId: string): string[] {
  return flowTaskIds(runId).filter(id => {
    const task = loadTask(process.cwd(), id);

    return task && !TERMINAL_STATUSES.includes(task.status);
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

/** Stop the orchestrator, optionally leaving its tasks running. */
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
  const changes = watchChanges(runDir);
  try {
    process.kill(record.pid!, opts.keepTasks ? 'SIGTERM' : 'SIGINT');
  } catch (error) {
    changes.close();
    throw error;
  }
  const current = await changes.until(() => {
    const value = readRawRecord(record.runId);
    return value?.status === 'running' ? undefined : value;
  }, 5000);
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
}

// ---------------------------------------------------------------------------
// streamFlowCore follows a run's event stream for the CLI and SDK.
// ---------------------------------------------------------------------------

/** Replay and follow events, using bootPid until the orchestrator records its own pid. */
export async function* streamFlowCore(
  runId: string,
  bootPid?: number,
  opts: { tail?: number | 'all' } = {},
): AsyncGenerator<FlowEvent> {
  const changes = watchChanges(runDirFor(runId));
  try {
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

    const startMs = processStarts();
    let record = readRawRecord(runId);
    while (!record || record.status === 'running') {
      yield* drain();
      record = readRawRecord(runId) ?? record;
      if (record && record.status !== 'running') break;
      // The run dying without a terminal write: pid dead (boot pid until the
      // orchestrator records its own) on a still-running record.
      // Prefer the record's own pid (with the recycled-pid guard); the boot pid
      // only bridges the gap before the orchestrator records itself.
      const dead = record?.pid
        ? !orchestratorAlive(record, startMs)
        : bootPid !== undefined && !pidAlive(bootPid);
      if (record && (record.pid || bootPid !== undefined) && dead) {
        markRunFailed(runId, 'orchestrator died');
        break;
      }
      await changes.wait(1000);
    }
    yield* drain();
  } finally {
    changes.close();
  }
}

// Build the context and flow.json for a fresh or resumed run.
function beginRun(
  ref: string,
  opts: RunOptions,
  hooks: FlowHooks,
  resumeRunId?: string,
  prepared?: FlowRecord,
): StartedRun {
  const record = prepared
    ? { ...prepared, pid: process.pid, pidStartedAt: new Date().toISOString() }
    : prepareRun(ref, opts, resumeRunId, process.pid);
  const { runId } = record;
  const runDir = runDirFor(runId);
  if (prepared) writeFlowRecord(runDir, record);
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '', 'utf8');

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
    ...(opts.connections ? { connections: opts.connections } : {}),
    ...(opts.access ? { access: opts.access } : {}),
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

  return { record, ctx, markStopped, replayable: recorded.length };
}

async function drive(started: StartedRun): Promise<RunSummary> {
  const { ctx, record: base } = started;
  const { runDir, runId } = ctx;
  const { script, name, args } = base;
  try {
    const result = await ctxALS.run(ctx, () =>
      scopeALS.run({ args: args ?? {}, depth: 0 }, () => loadAndRun(script, args, base)),
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

async function execute(
  ref: string,
  opts: RunOptions,
  hooks: FlowHooks,
  resumeRunId?: string,
  prepared?: FlowRecord,
): Promise<RunSummary> {
  const started = beginRun(ref, opts, hooks, resumeRunId, prepared);
  hooks.onStart?.({
    runId: started.ctx.runId,
    requestStop: started.markStopped,
    runningIds: () => [...started.ctx.running],
  });
  if (started.replayable) emitFlowEvent(started.ctx, { kind: 'replay', count: started.replayable });

  return drive(started);
}

export function runFlowByName(
  ref: string,
  opts: RunOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary> {
  return execute(ref, opts, hooks);
}

export function resumeFlow(
  runId: string,
  opts: RunOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary> {
  return execute('', opts, hooks, runId);
}

export function drivePreparedRun(
  record: FlowRecord,
  cwd: string,
  hooks: FlowHooks,
): Promise<RunSummary> {
  return execute(
    '',
    {
      cwd,
      concurrency: record.concurrencySet ? record.concurrency : undefined,
      maxTasks: record.maxTasks,
    },
    hooks,
    record.runId,
    record,
  );
}

export const review = {
  async run(options: ReviewArgs = {}): Promise<ReviewResult & { runId: string }> {
    const run = await runFlowByName('review', { cwd: options.cwd, args: options });
    return { ...(run.result as ReviewResult), runId: run.runId };
  },
};
