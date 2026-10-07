/** Run lifecycle the CLI and SDK share: start or resume (detached or here), follow, inspect, archive and delete runs. */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { CoderError } from '../core/dispatch';
import { CLI_PATH } from '../core/runtime';
import { errStyle, formatHints } from '../tui/output';
import { resolveFlow } from './discover';
import { readJournal } from './journal';
import type { FlowHooks } from './runtime';
import {
  STOP_KEEP_TASKS_MARKER,
  markRunFailed,
  prepareRun,
  resumeFlow,
  runFlowByName,
  stopFlowTasks,
  streamFlowCore,
  type RunOptions,
  type RunSummary,
  orchestratorAlive,
} from './executor';
import type { FlowEvent, FlowRecord, FlowStep, JournalEntry } from './types';
import { mailboxDir } from '../core/mailbox';
import {
  AUTO_ARCHIVE_MS,
  assertValidId,
  isValidId,
  listTasks,
  resolveFlowsDir,
  resolveFlowsArchiveDir,
  ageMs,
} from '../core/state';
import { moveDirectory } from '../utils/fsx';
import { spawnArchiveSweep } from '../core/task/actions';

// Marks the detached orchestrator child with the run id to attach to; unlike WORKER_ENV it may still dispatch tasks.
const FLOW_ATTACH_ENV = 'CODER_FLOW_ATTACH';

export interface StartOptions extends RunOptions {
  /** The `coder flow` argv this run came from (CLI only): a real run re-runs it as a detached orchestrator, and a .ts flow re-runs under bun when this runtime cannot load it. */
  argv?: string[];
  /** With argv, follow the detached run until it ends. */
  wait?: boolean;
}

/** A run handed to a detached orchestrator; `watch` follows it when asked to wait. */
export interface DetachedRun {
  runId: string;
  status: 'running';
  watch?: FlowWatch;
}

/** A run's record with its step rows, trimmed journal and recorded events. */
export type RunResult = FlowRecord & {
  steps: FlowStep[];
  journal: Array<Pick<JournalEntry, 'kind' | 'taskId' | 'tokens'>>;
  events: FlowEvent[];
};

export interface FlowWatch {
  /** The run as the watch began. */
  record: FlowRecord;
  /** Its events, replayed then followed live, ending once the run is terminal. */
  events: AsyncGenerator<FlowEvent>;
  /** The run once the stream ends. */
  final(): RunResult;
}

function bunAvailable(): boolean {
  try {
    return spawnSync('bun', ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

// A .ts flow needs bun or node with type stripping (23.6+); otherwise re-run the command under bun, before any detach.
function ensureTsRuntime(scriptPath: string, argv: string[]): void {
  if (!scriptPath.endsWith('.ts') || process.versions.bun || process.features.typescript) return;
  if (!bunAvailable()) {
    throw new CoderError(
      'invalid-option',
      `This flow is a TypeScript file (${scriptPath}) and this Node cannot run TypeScript.`,
      {
        hint: [
          'Upgrade to Node 23.6+ or install bun: https://bun.sh',
          'Or write the flow as .mjs / .js',
        ],
      },
    );
  }
  const result = spawnSync('bun', [CLI_PATH, ...argv], { stdio: 'inherit' });
  process.exit(result.status ?? 1);
}

// SIGINT in the detached child (sent by `flow stop`): stop dispatching, stop its running tasks unless
// `flow stop --keep-tasks` left its marker, stamp the run stopped and exit 130. Stderr here is flow.log.
function installStop(h: {
  runId: string;
  requestStop: () => void;
  runningIds: () => string[];
}): void {
  process.once('SIGINT', () => {
    void (async () => {
      const { runId } = h;
      const keep = fs.existsSync(path.join(runDirFor(runId), STOP_KEEP_TASKS_MARKER));
      process.stderr.write(`\n[flow] Stopping run ${runId}. No new tasks will dispatch.\n`);
      if (keep) {
        const ids = h.runningIds();
        if (ids.length) process.stderr.write(`[flow] left running: ${ids.join(', ')}\n`);
      } else {
        const stopped = await stopFlowTasks(runId, h.runningIds());
        if (stopped.length) process.stderr.write(`[flow] stopped tasks: ${stopped.join(', ')}\n`);
      }
      process.stderr.write(`\n${formatHints([`Resume: coder flow resume ${runId}`], errStyle)}\n`);
      h.requestStop();
      process.exit(130);
    })();
  });
}

// The detached child's hooks: append every event to events.jsonl (what followers tail) and arm the stop handler.
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

// In the detached child (FLOW_ATTACH_ENV set), drive the run the parent prepared and exit; otherwise return.
async function attachRun(opts: RunOptions): Promise<void> {
  const runId = process.env[FLOW_ATTACH_ENV];
  if (!runId) return;
  delete process.env[FLOW_ATTACH_ENV];
  try {
    await resumeFlow(runId, opts, fileHooks(runId));
    process.exit(0);
  } catch (error) {
    // drive() records flow failures itself; this covers a crash before it got there.
    markRunFailed(runId, error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// Spawn the orchestrator as a detached child re-running the same command with the attach marker.
function detachRun(record: FlowRecord, argv: string[], wait?: boolean): DetachedRun {
  const runDir = runDirFor(record.runId);
  // A fresh stream per attempt, so a resume does not replay the prior attempt's events.
  fs.writeFileSync(path.join(runDir, 'events.jsonl'), '', 'utf8');
  const logFd = fs.openSync(path.join(runDir, 'flow.log'), 'a');
  const child = spawn(process.execPath, [CLI_PATH, ...argv], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, [FLOW_ATTACH_ENV]: record.runId },
  });
  child.unref();
  fs.closeSync(logFd);
  return {
    runId: record.runId,
    status: 'running',
    ...(wait ? { watch: watchRun(record.runId, { bootPid: child.pid }) } : {}),
  };
}

// A run driven in this process, its failure worded with the resume hint.
async function driven(
  verb: 'run' | 'resume',
  dryRun: boolean | undefined,
  drive: () => Promise<RunSummary>,
): Promise<RunSummary> {
  try {
    return await drive();
  } catch (error) {
    if (!(error instanceof CoderError) || error.code !== 'flow-failed') throw error;
    const note = dryRun
      ? '\n[flow] dry-run ended early: a downstream step depends on real task output (stub it or run for real).'
      : '';
    throw new CoderError(
      'flow-failed',
      `[flow] ${verb} ${error.runId} failed: ${error.message}${note}`,
      {
        runId: error.runId,
        hint: `Resume${verb === 'resume' ? ' again' : ''}: coder flow resume ${error.runId}`,
      },
    );
  }
}

function findRun(runId: string | undefined, none: string): FlowRecord {
  const record = runId ? readFlowRecord(runId) : latestRun();
  if (!record) {
    throw new CoderError('flow-failed', runId ? `No flow run "${runId}".` : none, {
      hint: 'Run one: coder flow run <name>',
    });
  }
  return record;
}

/** Run a flow: here (awaiting its result), or with `argv` in a detached orchestrator unless `dryRun`. */
export async function startRun(
  ref: string,
  opts: StartOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary | DetachedRun> {
  if (opts.argv) {
    ensureTsRuntime(
      resolveFlow(ref, opts.cwd ? path.resolve(opts.cwd) : process.cwd()).path,
      opts.argv,
    );
    await attachRun(opts);
    if (!opts.dryRun) return detachRun(prepareRun(ref, opts), opts.argv, opts.wait);
  }
  return driven('run', opts.dryRun, () => runFlowByName(ref, opts, hooks));
}

/** Continue a stopped or edited run (the most recent without an id) from its journal, like startRun. */
export async function resumeRun(
  runId?: string,
  opts: StartOptions = {},
  hooks: FlowHooks = {},
): Promise<RunSummary | DetachedRun> {
  const record = findRun(runId, 'No flow runs to resume.');
  if (opts.argv) {
    ensureTsRuntime(record.script, opts.argv);
    await attachRun(opts);
    if (!opts.dryRun) return detachRun(prepareRun('', opts, record.runId), opts.argv, opts.wait);
  }
  return driven('resume', opts.dryRun, () => resumeFlow(record.runId, opts, hooks));
}

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

/** A run (the most recent without an id) with its steps, journal and events; `tail` caps the steps. */
export function runResult(runId?: string, opts: { tail?: number | 'all' } = {}): RunResult | null {
  const record = runId ? readFlowRecord(runId) : latestRun();
  if (!record) return null;
  return {
    ...record,
    steps: flowSteps(record.runId, opts.tail),
    journal: readJournal(path.join(runDirFor(record.runId), 'journal.jsonl')).map(e => ({
      kind: e.kind,
      taskId: e.taskId,
      tokens: e.tokens,
    })),
    events: readEvents(record.runId),
  };
}

/** Follow a run (the most recent without an id): replay its events, then tail them until it ends. `bootPid` is a just-spawned orchestrator. */
export function watchRun(
  runId?: string,
  opts: { tail?: number | 'all'; bootPid?: number } = {},
): FlowWatch {
  const record = findRun(runId, 'No flow runs yet.');
  return {
    record,
    events: streamFlowCore(record.runId, opts.bootPid, { tail: opts.tail }),
    final() {
      const result = runResult(record.runId, { tail: 0 });
      if (!result) {
        throw new CoderError(
          'flow-failed',
          `[flow] run ${record.runId} vanished while following.`,
          {
            hint: 'Recent runs: coder flow list',
          },
        );
      }
      return result;
    },
  };
}

// Archive and delete act on terminal runs only; a running run must be stopped first.
function requireStoppedRun(runId: string): FlowRecord {
  const record = readFlowRecord(runId);
  if (!record)
    throw new CoderError('flow-failed', `No flow run "${runId}".`, {
      hint: 'Recent runs: coder flow list',
    });
  if (record.status === 'running' || record.status === 'queued') {
    throw new CoderError('flow-failed', `Run ${record.runId} is still running.`, {
      runId: record.runId,
      hint: `Stop it first: coder flow stop ${record.runId}`,
    });
  }
  return record;
}

type Archived = { runId: string; archived: true };
type ArchivedAll = { archived: string[]; count: number };

/** Archive one stopped run, or with `allStopped` every one. */
export function archiveRuns(runId: string, opts?: { allStopped?: false }): Archived;
export function archiveRuns(runId: string | undefined, opts: { allStopped: true }): ArchivedAll;
export function archiveRuns(
  runId?: string,
  opts?: { allStopped?: boolean },
): Archived | ArchivedAll;
export function archiveRuns(
  runId?: string,
  opts: { allStopped?: boolean } = {},
): Archived | ArchivedAll {
  if (opts.allStopped) {
    const targets = listRuns().filter(r => r.status !== 'running' && r.status !== 'queued');
    for (const record of targets) archiveRun(record);
    const ids = targets.map(record => record.runId);
    return { archived: ids, count: ids.length };
  }
  if (!runId) {
    throw new CoderError('invalid-option', 'Missing run id.', {
      hint: [
        'Archive one: coder flow archive <run-id>',
        'Archive all stopped: coder flow archive --all-stopped',
      ],
    });
  }
  const record = requireStoppedRun(runId);
  archiveRun(record);
  return { runId: record.runId, archived: true };
}

type Deleted = { runId: string; deleted: boolean };
type DeletedAll = { deleted: string[]; count: number };

/** Delete one stopped run's record (its tasks are left alone), or with `allArchived` every archived one. */
export function deleteRuns(runId: string, opts?: { allArchived?: false }): Deleted;
export function deleteRuns(runId: string | undefined, opts: { allArchived: true }): DeletedAll;
export function deleteRuns(runId?: string, opts?: { allArchived?: boolean }): Deleted | DeletedAll;
export function deleteRuns(
  runId?: string,
  opts: { allArchived?: boolean } = {},
): Deleted | DeletedAll {
  if (opts.allArchived) {
    const ids = listArchivedRuns()
      .filter(record => deleteRun(record.runId))
      .map(record => record.runId);
    return { deleted: ids, count: ids.length };
  }
  if (!runId) {
    throw new CoderError('invalid-option', 'Missing run id.', {
      hint: [
        'Delete one: coder flow delete <run-id>',
        'Delete all archived: coder flow delete --all-archived',
      ],
    });
  }
  const record = requireStoppedRun(runId);
  return { runId: record.runId, deleted: deleteRun(record.runId) };
}

// ---------------------------------------------------------------------------
// Run store
// ---------------------------------------------------------------------------

export function generateRunId(): string {
  return `flow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function flowsStateDir(): string {
  // Inside an agent's sandbox the mailbox is the only place a run can write.
  const mailbox = mailboxDir();
  return resolveFlowsDir(mailbox);
}

function flowsArchiveDir(): string {
  return resolveFlowsArchiveDir();
}

// Resolves to whichever bin holds the run (live wins); a fresh run id falls
// through to the live bin.
export function runDirFor(runId: string): string {
  assertValidId(runId, 'flow run id');
  const live = path.join(flowsStateDir(), runId);
  if (fs.existsSync(path.join(live, 'flow.json'))) return live;
  const archived = path.join(flowsArchiveDir(), runId);
  if (fs.existsSync(path.join(archived, 'flow.json'))) return archived;
  return live;
}

// Flag a run archived without moving its dir; listRuns/listArchivedRuns
// tolerate the flag-without-move interim and finish the move.
export function markRunArchived(record: FlowRecord): FlowRecord {
  if (record.archived) return record;
  const next: FlowRecord = { ...record, archived: true, archivedAt: new Date().toISOString() };
  writeFlowRecord(runDirFor(record.runId), next);
  return next;
}

// Archive a run fully: flag the record and move its dir into the archive bin.
// The run's tasks are ordinary tasks and are left alone.
export function archiveRun(record: FlowRecord): FlowRecord {
  const from = runDirFor(record.runId);
  const to = path.join(flowsArchiveDir(), record.runId);
  if (from !== to) moveDirectory(from, to);

  return markRunArchived(record);
}

/** The detached half of a run archive sweep. */
export function archiveFlaggedRuns(ids: string[]): void {
  for (const id of ids) {
    const record = readFlowRecord(id);
    if (record) archiveRun(record);
  }
}

// Resuming an archived run makes it running again: move it back to the live
// bin and clear the flag.
export function unarchiveRun(record: FlowRecord): FlowRecord {
  const from = runDirFor(record.runId);
  const to = path.join(flowsStateDir(), record.runId);
  if (from !== to) moveDirectory(from, to);
  const next: FlowRecord = { ...record, archived: undefined, archivedAt: undefined };
  writeFlowRecord(runDirFor(record.runId), next);
  return next;
}

// Delete a run's dir (record, journal, events, logs) from either bin. The
// run's tasks are ordinary tasks and are not touched.
export function deleteRun(runId: string): boolean {
  const runDir = runDirFor(runId);
  if (!fs.existsSync(path.join(runDir, 'flow.json'))) return false;
  fs.rmSync(runDir, { recursive: true, force: true });
  return true;
}

export function readRawRecord(runId: string): FlowRecord | null {
  // A lookup by user-supplied reference: a malformed id is just "not found".
  if (!isValidId(runId)) return null;
  const file = path.join(runDirFor(runId), 'flow.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as FlowRecord;
  } catch {
    return null;
  }
}

// Self-heal a zombie run on read. This mirrors reconcileTask for tasks. Pidless
// records are left alone: no pid means the run is still booting
// (streamFlowCore's boot-pid bridge covers that window).
export function reconcileRun(record: FlowRecord): FlowRecord {
  if (record.status !== 'running' || !record.pid) return record;
  if (orchestratorAlive(record)) return record;
  markRunFailed(record.runId, 'orchestrator died');
  return readRawRecord(record.runId) ?? record;
}

export function readFlowRecord(runId: string): FlowRecord | null {
  const record = readRawRecord(runId);
  return record ? reconcileRun(record) : null;
}

export function writeFlowRecord(runDir: string, record: FlowRecord): void {
  fs.writeFileSync(path.join(runDir, 'flow.json'), `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

function scanRuns(dir: string): FlowRecord[] {
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const runs: FlowRecord[] = [];
  for (const id of ids) {
    try {
      runs.push(
        reconcileRun(
          JSON.parse(fs.readFileSync(path.join(dir, id, 'flow.json'), 'utf8')) as FlowRecord,
        ),
      );
    } catch {
      // Skip a non-run or unreadable directory.
    }
  }
  return runs;
}

const byStart = (a: FlowRecord, b: FlowRecord) =>
  String(b.startedAt).localeCompare(String(a.startedAt));

/** Live runs newest-first (by startedAt); runs flagged archived in place migrate out. */
export function listRuns(): FlowRecord[] {
  const runs: FlowRecord[] = [];
  for (const r of scanRuns(flowsStateDir())) {
    if (r.archived) archiveRun(r);
    else runs.push(r);
  }
  return runs.sort(byStart);
}

/**
 * Archived runs. Scans the live bin too so flagged-in-place runs show up (and
 * migrate); migrate: false skips the dir moves for cheap counts on hot paths.
 */
export function listArchivedRuns(opts?: { migrate?: boolean }): FlowRecord[] {
  const migrate = opts?.migrate ?? true;
  const archived = scanRuns(flowsArchiveDir());
  const seen = new Set(archived.map(r => r.runId));
  for (const r of scanRuns(flowsStateDir())) {
    if (r.archived && !seen.has(r.runId)) {
      archived.push(migrate ? archiveRun(r) : r);
    }
  }
  return archived.sort(byStart);
}

export function latestRun(): FlowRecord | null {
  // Search live and archived alike (result/stream/resume accept archived
  // runs), newest first across both bins. This mirrors findTask for tasks.
  return [...listRuns(), ...listArchivedRuns()].sort(byStart)[0] ?? null;
}

/**
 * A run's journal-derived step rows (SDK `flow.result` / `coder flow result`),
 * each task step with its current task status. `tail` keeps only the last n
 * ('all', the default, keeps every step; 0 none).
 */
export function flowSteps(runId: string, tail: number | 'all' = 'all'): FlowStep[] {
  if (tail === 0) return [];
  const entries = readJournal(path.join(runDirFor(runId), 'journal.jsonl')).filter(
    e => e.kind === 'task',
  );
  const tasks = listTasks(process.cwd());
  const byId = new Map(tasks.map(j => [j.id, j]));
  // Display name: the task's name, else the prompt's opening line as-is (the
  // same fallback the task lists use).
  const displayName = (task?: { name?: string | null; prompt?: string }) =>
    task?.name ?? task?.prompt?.replace(/\s+/g, ' ').trim().slice(0, 60) ?? null;
  const steps: FlowStep[] = entries.map(e => {
    const task = e.taskId ? byId.get(e.taskId) : undefined;
    return {
      taskId: e.taskId ?? null,
      name: displayName(task),
      status: task?.status ?? (e.result as { status?: string } | null)?.status ?? '?',
      tokens: e.tokens ?? null,
    };
  });
  // A task that threw (failed dispatch, stopped mid-run) never reaches the
  // journal; pick those up from the run-tagged tasks so no step goes missing.
  const seen = new Set(steps.map(st => st.taskId));
  for (const task of tasks) {
    if (task.flowRunId === runId && !seen.has(task.id)) {
      steps.push({ taskId: task.id, name: displayName(task), status: task.status, tokens: null });
    }
  }
  return tail === 'all' ? steps : steps.slice(-tail);
}

/**
 * Runs for `coder flow list`: running runs always, terminal ones that ended
 * inside the archive window; `archived` lists the archived bin instead.
 */
export function collectFlowRuns(opts: { archived?: boolean; limit?: number | 'all' } = {}): {
  runs: FlowRecord[];
  clipped: number;
} {
  const limit = opts.limit === 'all' ? undefined : opts.limit;
  let runs: FlowRecord[];
  if (opts.archived) {
    runs = listArchivedRuns();
  } else {
    // Auto-archive sweep: any terminal run older than AUTO_ARCHIVE_MS drops
    // out of the default view. Flag it archived inline (cheap, keeps the
    // record correct) but defer the slow dir move to a detached sweep.
    const toArchive: string[] = [];
    runs = listRuns().filter(r => {
      if (r.status === 'running' || r.status === 'queued') return true;
      if (ageMs(r.endedAt ?? r.startedAt) <= AUTO_ARCHIVE_MS) return true;
      markRunArchived(r);
      toArchive.push(r.runId);
      return false;
    });
    spawnArchiveSweep(process.cwd(), toArchive, { flows: true });
  }
  const clipped = limit !== undefined ? Math.max(0, runs.length - limit) : 0;
  return { runs: limit !== undefined ? runs.slice(0, limit) : runs, clipped };
}
