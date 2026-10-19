import { execFileSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  moveDirectory,
  readJsonFile,
  watchChanges,
  withFileLock,
  writeFileAtomic,
} from '../utils/fsx';
import { archiveCodexSession } from './engines/codex/sessions';
import { type Task, type TurnResult, ACTIVE_STATUSES, TERMINAL_STATUSES } from './types';
import type { TaskLogEntry } from './task/log-view';
import { redactConnectionSecrets } from './connections';
export type { TaskLogEntry } from './task/log-view';

const CODER_HOME_ENV = 'CODER_HOME';

// Task/run ids come straight from CLI positionals and SDK args and are joined
// into state paths. Reject anything that could traverse out of the state root.
const VALID_ID = /^[a-z0-9][a-z0-9_-]*$/i;

export function isValidId(id: string): boolean {
  return VALID_ID.test(id);
}

export function assertValidId(id: string, what: string): void {
  if (!isValidId(id)) {
    throw new Error(`Invalid ${what} "${id}".`);
  }
}

export function coderHome(...parts: string[]): string {
  return path.join(
    path.resolve(process.env[CODER_HOME_ENV] || path.join(os.homedir(), '.coder')),
    ...parts,
  );
}

export function coderCache(...parts: string[]): string {
  const home = os.homedir();
  const platform = os.platform();
  const root =
    process.env.CODER_CACHE_HOME ||
    (platform === 'darwin'
      ? path.join(home, 'Library', 'Caches', 'wular-coder')
      : platform === 'win32'
        ? path.join(
            process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
            'wular-coder',
            'cache',
          )
        : path.join(process.env.XDG_CACHE_HOME || path.join(home, '.cache'), 'wular-coder'));

  return path.join(path.resolve(root), ...parts);
}

export function resolveFlowsDir(): string {
  return coderHome('state', 'global', 'flows');
}

export function resolveFlowsArchiveDir(): string {
  return coderCache('flows-archived');
}

export function resolveUsageFile(): string {
  return coderCache('usage.json');
}

export function resolveUsageTempFile(file = resolveUsageFile()): string {
  return `${file}.${process.pid}.${randomUUID()}.tmp`;
}

export function resolveRunnerUsageFile(): string {
  return coderCache('runner', 'usage.json');
}

export function resolveWorkspaceRoot(cwd: string): string {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return cwd;
  }
}

const GLOBAL_STATE_SLUG = 'global';

export function resolveStateDir(_cwd: string): string {
  return coderHome('state', GLOBAL_STATE_SLUG);
}

export function resolveTasksDir(cwd: string): string {
  return path.join(resolveStateDir(cwd), 'jobs');
}

// Stopped tasks (and flow runs) linger in the recent view this long, then move
// to the archived view. Shared by `coder list` and `coder flow list`.
export const AUTO_ARCHIVE_MS = 30 * 60_000;

/** Whether a task stopped at this time (ms) is past AUTO_ARCHIVE_MS. */
export const archiveDue = (stoppedAt: number, now = Date.now()) =>
  now - stoppedAt > AUTO_ARCHIVE_MS;

// Archived tasks live in a separate bin, so the default list only ever scans
// the (tiny) active bin instead of every task ever run.
export function resolveArchiveDir(_cwd: string): string {
  return coderCache('archive');
}

export function resolveTaskDir(cwd: string, taskId: string): string {
  assertValidId(taskId, 'task id');
  const globalDir = path.join(resolveTasksDir(cwd), taskId);
  if (fs.existsSync(path.join(globalDir, 'job.json'))) {
    return globalDir;
  }
  const archivedDir = path.join(resolveArchiveDir(cwd), taskId);
  if (fs.existsSync(path.join(archivedDir, 'job.json'))) {
    return archivedDir;
  }
  return globalDir;
}

// Active workers keep their files in place until they stop.
export function archiveTask(cwd: string, task: Task, opts: { auto?: boolean } = {}): Task {
  const active = ACTIVE_STATUSES.includes(task.status);
  if (!active) {
    const from = resolveTaskDir(cwd, task.id);
    const to = path.join(resolveArchiveDir(cwd), task.id);
    if (from !== to) moveDirectory(from, to);
  }
  const next = task.archived
    ? opts.auto || !task.autoArchived
      ? task
      : writeTask(cwd, task.id, { autoArchived: undefined })
    : writeTask(
        cwd,
        task.id,
        {
          archived: true,
          archivedAt: new Date().toISOString(),
          ...(opts.auto ? { autoArchived: true } : {}),
        },
        { touch: !opts.auto },
      );
  if (!active && task.engine !== 'claude' && task.threadId)
    void archiveCodexSession(cwd, task.threadId);

  return next;
}

// A resumed task belongs in the active list even if its old archive flag remains.
function resumedAfterArchive(task: Task): boolean {
  return Boolean(task.archived) && (task.resumedAt ?? '') > (task.archivedAt ?? '');
}

// Undo archiveTask: clear the flag and move the dir back into the active bin.
export function unarchiveTask(cwd: string, task: Task): Task {
  const from = resolveTaskDir(cwd, task.id);
  const to = path.join(resolveTasksDir(cwd), task.id);
  if (from !== to) moveDirectory(from, to);

  return writeTask(cwd, task.id, {
    archived: undefined,
    archivedAt: undefined,
    autoArchived: undefined,
  });
}

export function generateTaskId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `task-${Date.now().toString(36)}-${random}`;
}

/** `touch: false` keeps updatedAt, for silent bookkeeping such as the auto-archive sweep. */
export function writeTask(
  cwd: string,
  taskId: string,
  patch: Partial<Task>,
  opts: { touch?: boolean } = {},
): Task {
  const taskDir = resolveTaskDir(cwd, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'job.json');
  const existing: Task =
    loadTask(cwd, taskId) ??
    ({ id: taskId, createdAt: new Date().toISOString(), status: 'queued' } as Task);
  const next: Task = {
    ...existing,
    ...patch,
    updatedAt: opts.touch === false ? existing.updatedAt : new Date().toISOString(),
  };
  writeFileAtomic(taskFile, `${redactConnectionSecrets(next)}\n`);
  return next;
}

export function loadTask(cwd: string, taskId: string): Task | null {
  // A lookup by user-supplied reference: a malformed id is just "not found".
  if (!isValidId(taskId)) {
    return null;
  }
  const taskFile = path.join(resolveTaskDir(cwd, taskId), 'job.json');
  if (!fs.existsSync(taskFile)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(taskFile, 'utf8')) as Task;
  } catch {
    return null;
  }
}

export function removeTaskDir(cwd: string, taskId: string): boolean {
  const taskDir = resolveTaskDir(cwd, taskId);
  if (!fs.existsSync(taskDir)) {
    return false;
  }
  fs.rmSync(taskDir, { recursive: true, force: true });
  return true;
}

// Whether a process is still alive. Signal 0 tests existence without delivering
// a signal; EPERM means it exists but we may not signal it (still alive).
export function isPidAlive(pid?: number | null): boolean {
  if (!pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Epoch ms when the process holding `pid` started, or null if unknown (process
// gone, or `ps` unavailable). Distinguishes a worker from a recycled pid.
export function processStartMs(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      // Pin ps to the JS runtime's timezone: lstart has no zone marker, and
      // env TZ can differ from the runtime's (e.g. bun test forces UTC).
      env: { ...process.env, TZ: Intl.DateTimeFormat().resolvedOptions().timeZone },
    }).trim();
    const parsed = out ? Date.parse(out) : NaN;
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Our worker is spawned within moments of the task being created, so a live pid
// whose process started well after the task's createdAt is a recycled pid. The
// real worker is gone.
export function pidIsOurWorker(pid: number, task: Task, startMs = processStartMs): boolean {
  if (!isPidAlive(pid)) {
    return false;
  }
  const started = startMs(pid);
  // A steer-resumed worker spawns at resumedAt, long after createdAt.
  const created = Date.parse(task.resumedAt ?? task.createdAt ?? '');
  if (started === null || !Number.isFinite(created)) {
    return true; // Cannot verify start time, so trust liveness.
  }
  return started <= created + 60_000;
}

// How long a running/queued task with no recorded pid may sit untouched before
// it is treated as dead. Long enough to clear the brief queued-before-pid window
// on a freshly created task.
const STALE_NO_PID_MS = 60_000;

// Self-heal a zombie: a task marked running/queued whose worker process is gone
// (crash, kill, reboot) can never reach a terminal status on its own, so mark it
// failed. Detect it through a dead pid or through staleness for tasks with no pid.
export function reconcileTask(cwd: string, task: Task, startMs = processStartMs): Task {
  const active = task.status === 'running' || task.status === 'queued';
  if (!active && !task.rollingOver) {
    return task;
  }
  let dead: boolean;
  if (task.pid) {
    dead = !pidIsOurWorker(task.pid, task, startMs);
  } else {
    const ts = Date.parse(task.updatedAt ?? task.createdAt ?? '');
    dead = Number.isFinite(ts) && Date.now() - ts > STALE_NO_PID_MS;
  }
  if (dead) {
    // The worker may have finished since `task` was read; judge its latest record.
    const latest = loadTask(cwd, task.id);
    if (latest && (latest.status !== task.status || latest.updatedAt !== task.updatedAt))
      return reconcileTask(cwd, latest, startMs);
    if (!active) return writeTask(cwd, task.id, { rollingOver: false }, { touch: false });
    return writeTask(cwd, task.id, {
      status: 'failed',
      rollingOver: false,
      error: 'worker exited without finishing',
      completedAt: new Date().toISOString(),
    });
  }
  return task;
}

function taskIds(dir: string): string[] {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function scanTasks(dir: string, seen = new Set<string>()): Task[] {
  return taskIds(dir).flatMap(id => {
    if (seen.has(id)) return [];
    try {
      const task = JSON.parse(fs.readFileSync(path.join(dir, id, 'job.json'), 'utf8')) as Task;
      seen.add(id);

      return [task];
    } catch {
      return [];
    }
  });
}

/** Task folders for background readers, without loading every archived record. */
export async function* taskDirectories(
  cwd: string,
): AsyncGenerator<{ id: string; dir: string; archived: boolean }> {
  const dirs = [
    { dir: resolveTasksDir(cwd), archived: false },
    { dir: resolveArchiveDir(cwd), archived: true },
  ];
  for (const { dir, archived } of dirs) {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries)
      if (entry.isDirectory() && isValidId(entry.name))
        yield { id: entry.name, dir: path.join(dir, entry.name), archived };
  }
}

const byRecency = (left: Task, right: Task) =>
  String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? ''));

export function processStarts(): typeof processStartMs {
  const starts = new Map<number, number | null>();
  let expires = Date.now() + 30_000;
  return pid => {
    if (Date.now() >= expires) {
      starts.clear();
      expires = Date.now() + 30_000;
    }
    if (!starts.has(pid)) starts.set(pid, processStartMs(pid));
    return starts.get(pid)!;
  };
}

// A running archived task stays beside its worker until it stops.
export function listTasks(cwd: string): Task[] {
  const startMs = processStarts();
  const tasks: Task[] = [];
  for (const stored of scanTasks(resolveTasksDir(cwd))) {
    const task = reconcileTask(cwd, stored, startMs);
    if (task.archived && !resumedAfterArchive(task)) {
      archiveTask(cwd, task, { auto: true });
    } else {
      tasks.push(task.archived ? unarchiveTask(cwd, task) : task);
    }
  }
  return tasks.sort(byRecency);
}

/** Whether a local server's queue row is a newer execution than its task's CLI job records: queued, a continuation whose CLI turn has not begun, or a task with no CLI job. The job is the truth for the execution it records. */
export function queueRowWins(
  cwd: string,
  row: { task: { id: string }; status: string; generation?: number; startedAt?: number },
  listed = false,
): boolean {
  if (row.status === 'queued') return true;
  const generation = row.generation ?? 0;
  if (listed && !generation) return false;
  const job = loadTask(cwd, row.task.id);
  if (!job) return true;
  if (!generation) return false;

  // A continuation's CLI turn stamps the job's resumedAt once it begins.
  return row.startedAt === undefined || (Date.parse(job.resumedAt ?? '') || 0) < row.startedAt;
}

type ServerTaskRow = {
  task: {
    id: string;
    name?: string;
    prompt?: string;
    source?: string;
    agent?: string;
    cwd?: string;
  };
  status: string;
  generation?: number;
  startedAt?: number;
  error?: string;
  createdAt: number;
  finishedAt?: number;
  updatedAt: number;
  archivedAt?: number;
};

/** A local server's queue rows that are newer executions than their CLI jobs (`queueRowWins`), such as startup failures, archived once past AUTO_ARCHIVE_MS. */
export function queueOwnedTasks(cwd: string): Task[] {
  const rows =
    readJsonFile<Record<string, { value: ServerTaskRow }>>(
      path.join(resolveStateDir(cwd), 'runner', 'task.json'),
    ) ?? {};
  const iso = (ms?: number) => (ms === undefined ? undefined : new Date(ms).toISOString());

  return Object.values(rows)
    .map(({ value }) => value)
    .filter(row => queueRowWins(cwd, row))
    .map(row => {
      const status = (row.status === 'waiting' ? 'running' : row.status) as Task['status'];
      const archivedAt =
        row.archivedAt ??
        (TERMINAL_STATUSES.includes(status) && archiveDue(row.finishedAt ?? row.updatedAt)
          ? (row.finishedAt ?? row.updatedAt)
          : undefined);

      return {
        id: row.task.id,
        status,
        ...(row.task.name ? { name: row.task.name } : {}),
        ...(row.task.prompt ? { prompt: row.task.prompt } : {}),
        ...(row.task.cwd ? { cwd: row.task.cwd } : {}),
        ...(row.task.agent ? { agentId: row.task.agent } : {}),
        source: row.task.source ?? 'dashboard',
        ...(row.error ? { error: row.error } : {}),
        createdAt: iso(row.createdAt)!,
        updatedAt: iso(row.updatedAt),
        ...(row.finishedAt ? { completedAt: iso(row.finishedAt) } : {}),
        ...(archivedAt === undefined ? {} : { archived: true, archivedAt: iso(archivedAt) }),
      };
    });
}

// Archived workers finish in the live bin; resumed archived workers return there.
// migrate: false leaves directories in place for callers that only need a count.
export function listArchivedTasks(cwd: string, opts?: { migrate?: boolean }): Task[] {
  const startMs = processStarts();
  const migrate = opts?.migrate ?? true;
  const seen = new Set<string>();
  const archived: Task[] = [];
  for (const task of scanTasks(resolveArchiveDir(cwd), seen)) {
    if (!resumedAfterArchive(task)) {
      archived.push(reconcileTask(cwd, task, startMs));
    } else if (migrate) {
      unarchiveTask(cwd, reconcileTask(cwd, task, startMs));
    }
  }
  for (const task of scanTasks(resolveTasksDir(cwd), seen)) {
    if (task.archived && !resumedAfterArchive(task)) {
      const current = reconcileTask(cwd, task, startMs);
      archived.push(migrate ? archiveTask(cwd, current, { auto: true }) : current);
    }
  }
  return archived.sort(byRecency);
}

export function findTask(cwd: string, reference?: string): Task | null {
  if (!reference) {
    const archived = listArchivedTasks(cwd);

    return [...listTasks(cwd), ...archived].sort(byRecency)[0] ?? null;
  }
  const current = (task: Task) => {
    const reconciled = reconcileTask(cwd, task);

    return resumedAfterArchive(reconciled) ? unarchiveTask(cwd, reconciled) : reconciled;
  };
  const exact = loadTask(cwd, reference);
  if (exact) return current(exact);
  if (!isValidId(reference)) return null;
  const ids = new Set(
    [resolveTasksDir(cwd), resolveArchiveDir(cwd)].flatMap(dir =>
      taskIds(dir).filter(id => id.startsWith(reference)),
    ),
  );
  const matches = [...ids].flatMap(id => {
    const task = loadTask(cwd, id);

    return task ? [task] : [];
  });
  if (matches.length > 1)
    throw new Error(`Task reference "${reference}" is ambiguous. Use a longer id.`);

  return matches[0] ? current(matches[0]) : null;
}

// Cheap activity heartbeat: engines touch this file (throttled) on any server
// event, including ones we do not log, like command output deltas, so idle
// means "time since the engine emitted anything", not "since we logged".
export function touchActivity(cwd: string, taskId: string): void {
  const taskDir = resolveTaskDir(cwd, taskId);
  try {
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, 'heartbeat'), '', 'utf8');
  } catch {
    // Best-effort: a missed heartbeat only overstates idle time.
  }
}

// Most recent sign of life for a task: the latest of its task.json update, its
// last log append, and its heartbeat. Uses file mtimes so it stays O(1) per task.
export function lastActivityAt(cwd: string, task: Task): string | undefined {
  const taskDir = resolveTaskDir(cwd, task.id);
  let best = Date.parse(task.updatedAt ?? '') || 0;
  for (const file of ['log.jsonl', 'heartbeat']) {
    try {
      best = Math.max(best, fs.statSync(path.join(taskDir, file)).mtimeMs);
    } catch {
      // File not created yet.
    }
  }
  return best ? new Date(best).toISOString() : undefined;
}

// Follow-ups steered into a still-running task that could not be injected into
// the live turn because it was starting or completing are queued in this file.
// The worker that owns the task
// drains it when its turn finishes, running each as a resumed turn.
const STEER_QUEUE_FILE = 'steer-queue.jsonl';

export function withTaskAdmission<T>(cwd: string, taskId: string, work: () => T) {
  assertValidId(taskId, 'task id');
  return withFileLock(path.join(resolveStateDir(cwd), 'steer', `${taskId}.lock`), work);
}

export function enqueueSteer(cwd: string, taskId: string, text: string): void {
  const taskDir = resolveTaskDir(cwd, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.appendFileSync(
    path.join(taskDir, STEER_QUEUE_FILE),
    `${JSON.stringify({ at: new Date().toISOString(), text })}\n`,
    'utf8',
  );
}

export function hasQueuedSteers(cwd: string, taskId: string): boolean {
  return fs.existsSync(path.join(resolveTaskDir(cwd, taskId), STEER_QUEUE_FILE));
}

// Atomically claim every queued follow-up, oldest first. Renames the queue file
// aside before reading so a steer racing this drain starts a fresh file (its
// entry is never lost. The next drain picks it up and the worker is the sole
// consumer, so a claimed entry is never dispatched twice.
export function claimSteers(cwd: string, taskId: string): string[] {
  const taskDir = resolveTaskDir(cwd, taskId);
  const queueFile = path.join(taskDir, STEER_QUEUE_FILE);
  const claimFile = path.join(taskDir, `steer-claim-${process.pid}-${Date.now()}.tmp`);
  try {
    fs.renameSync(queueFile, claimFile);
  } catch {
    return []; // nothing queued
  }
  try {
    return fs
      .readFileSync(claimFile, 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          return String((JSON.parse(line) as { text?: unknown }).text ?? '');
        } catch {
          return '';
        }
      })
      .filter(Boolean);
  } finally {
    try {
      fs.unlinkSync(claimFile);
    } catch {
      // Best-effort cleanup of the claimed file.
    }
  }
}

export function appendTaskLog(cwd: string, taskId: string, entry: TaskLogEntry): void {
  appendTaskDirLog(resolveTaskDir(cwd, taskId), entry);
}

export function appendTaskDirLog(taskDir: string, entry: TaskLogEntry): void {
  fs.mkdirSync(taskDir, { recursive: true });
  fs.appendFileSync(
    path.join(taskDir, 'log.jsonl'),
    `${redactConnectionSecrets({ at: new Date().toISOString(), ...entry })}\n`,
    'utf8',
  );
}

/** The log line of a steer the engine took into its running turn, before the steer's text. */
export const LIVE_STEER = 'Steer accepted live:\n';

export interface TurnResultEntry {
  at?: string;
  prompt?: string | null;
  /** Steers the engine took into this turn while it ran. */
  steers?: string[];
  lastReply?: string;
  finalMessage?: string;
  error?: TurnResult['error'];
  status?: number;
  tokens?: TurnResult['tokens'];
  model?: TurnResult['model'];
  [key: string]: unknown;
}

export function watchTask(cwd: string, taskId: string, worker?: ChildProcess) {
  const changes = watchChanges(resolveTaskDir(cwd, taskId));
  worker?.on('message', changes.notify);
  worker?.on('exit', changes.notify);
  worker?.on('error', changes.notify);
  return {
    wait: changes.wait,
    close() {
      worker?.off('message', changes.notify);
      worker?.off('exit', changes.notify);
      worker?.off('error', changes.notify);
      changes.close();
    },
  };
}

export function readTurnResults(cwd: string, taskId: string): TurnResultEntry[] {
  const file = path.join(resolveTaskDir(cwd, taskId), 'results.jsonl');
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line): TurnResultEntry[] => {
      try {
        return [JSON.parse(line) as TurnResultEntry];
      } catch {
        return [];
      }
    });
}

// Keep the last `tail` steps, plus whatever trails them. Token snapshots are
// bookkeeping, not steps: counting them lets a tail land on an entry that
// renders to nothing, which is why `--tail 1` could show an empty transcript.
export function tailSteps(entries: TaskLogEntry[], tail: number): TaskLogEntry[] {
  if (tail <= 0) return [];
  let steps = 0;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i]?.kind !== 'usage' && (steps += 1) === tail) return entries.slice(i);
  }
  return entries;
}

export function readTaskLog(cwd: string, taskId: string, maxLines = 40): TaskLogEntry[] {
  if (maxLines <= 0) return [];
  const logFile = path.join(resolveTaskDir(cwd, taskId), 'log.jsonl');
  let fd: number;
  try {
    fd = fs.openSync(logFile, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  try {
    const size = fs.fstatSync(fd).size;
    let bytes = Math.min(size, 64 * 1024);
    for (;;) {
      const start = size - bytes;
      const buffer = Buffer.alloc(bytes);
      const read = fs.readSync(fd, buffer, 0, bytes, start);
      const text = buffer.toString('utf8', 0, read);
      const lines = (start ? text.slice(text.indexOf('\n') + 1) : text)
        .split(/\r?\n/)
        .filter(Boolean);
      if (start === 0 || (text.includes('\n') && lines.length >= maxLines))
        return lines.slice(-maxLines).map((line): TaskLogEntry => {
          try {
            return JSON.parse(line) as TaskLogEntry;
          } catch {
            return { message: line };
          }
        });
      bytes = Math.min(size, bytes * 2);
    }
  } finally {
    fs.closeSync(fd);
  }
}

// "engine/model/effort", dropping unset parts (e.g. "claude/opus/medium", "codex", "claude/opus").
export function formatEngineSpec(task: {
  engine?: string | null;
  model?: string | null;
  effort?: string | null;
}): string {
  return [task.engine ?? '-', task.model, task.model ? task.effort : null]
    .filter(Boolean)
    .join('/');
}

// Milliseconds since an ISO timestamp (0 if unparseable).
export function ageMs(iso?: string): number {
  const t = Date.parse(iso ?? '');
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : 0;
}

// A running/queued task idle this long with no pending approval is flagged as
// possibly stalled. This is advisory. A silent hang and streamed output count as
// activity via the heartbeat).
export const STALL_MS = 10 * 60_000;
