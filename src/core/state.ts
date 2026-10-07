import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { moveDirectory } from '../utils/fsx';
import { archiveCodexSession } from './engines/codex/sessions';
import { type Task, type TurnResult, ACTIVE_STATUSES, TERMINAL_STATUSES } from './types';
import type { TaskLogEntry } from './task/log-view';
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

export function resolveCoderHome(): string {
  return coderHome();
}

export function resolveFlowsDir(mailbox?: string): string {
  return mailbox ? path.join(mailbox, 'flows') : coderHome('state', 'global', 'flows');
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

// Task state is global: a task's cwd is just where the engine works, not a
// storage key. `cwd` params on the helpers below are kept only so legacy
// per-workspace dirs (pre-global layouts) remain readable.
const GLOBAL_STATE_SLUG = 'global';

export function resolveStateDir(_cwd: string): string {
  return coderHome('state', GLOBAL_STATE_SLUG);
}

// Pre-global-state layout has one directory per workspace under state/. It is read-only now.
// tasks found there are listed and updated in place, but new tasks never land there.
function legacyStateDirs(): string[] {
  const root = coderHome('state');
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    // No state yet.
  }
  return entries
    .filter(entry => entry.isDirectory() && entry.name !== GLOBAL_STATE_SLUG)
    .map(entry => path.join(root, entry.name));
}

export function resolveTasksDir(cwd: string): string {
  return path.join(resolveStateDir(cwd), 'jobs');
}

// Stopped tasks (and flow runs) linger in the recent view this long, then move
// to the archived view. Shared by `coder list` and `coder flow list`.
export const AUTO_ARCHIVE_MS = 10 * 60_000;

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
  // Legacy per-workspace task: keep operating on it where it lives, so a worker
  // started by an older build and this build see the same record.
  for (const stateDir of legacyStateDirs()) {
    const candidate = path.join(stateDir, 'jobs', taskId);
    if (fs.existsSync(path.join(candidate, 'job.json'))) {
      return candidate;
    }
  }
  return globalDir;
}

// Flag a task archived without moving its dir; the migration in listTasks/
// listArchivedTasks tolerates the flag-without-move interim and finishes the move.
export function markTaskArchived(cwd: string, task: Task): Task {
  return task.archived
    ? task
    : writeTask(cwd, task.id, { archived: true, archivedAt: new Date().toISOString() });
}

// Active workers keep their files in place until they stop.
export function archiveTask(cwd: string, task: Task): Task {
  if (ACTIVE_STATUSES.includes(task.status)) return markTaskArchived(cwd, task);
  const from = resolveTaskDir(cwd, task.id);
  const to = path.join(resolveArchiveDir(cwd), task.id);
  if (from !== to) moveDirectory(from, to);
  const next = markTaskArchived(cwd, task);
  if (task.engine !== 'claude' && task.threadId) {
    void archiveCodexSession(cwd, task.threadId);
  }

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

  return writeTask(cwd, task.id, { archived: undefined, archivedAt: undefined });
}

export function generateTaskId(): string {
  const random = Math.random().toString(36).slice(2, 8);
  return `task-${Date.now().toString(36)}-${random}`;
}

export function writeTask(cwd: string, taskId: string, patch: Partial<Task>): Task {
  const taskDir = resolveTaskDir(cwd, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  const taskFile = path.join(taskDir, 'job.json');
  const existing: Task =
    loadTask(cwd, taskId) ??
    ({ id: taskId, createdAt: new Date().toISOString(), status: 'queued' } as Task);
  const next: Task = { ...existing, ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(taskFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

// Older records kept the engine in `agent`.
function normalizeTask(task: Task & { agent?: Task['engine'] }): Task {
  if (task.agent) task.engine = task.agent;
  delete task.agent;
  return task;
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
    return normalizeTask(JSON.parse(fs.readFileSync(taskFile, 'utf8')) as Task);
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
function isPidAlive(pid?: number | null): boolean {
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
function pidIsOurWorker(pid: number, task: Task, startMs: typeof processStartMs): boolean {
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
  if (task.status !== 'running' && task.status !== 'queued') {
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
    return writeTask(cwd, task.id, {
      status: 'failed',
      error: 'worker exited without finishing',
      completedAt: new Date().toISOString(),
    });
  }
  return task;
}

function scanTasks(dirs: string[], seen: Set<string>): Task[] {
  const tasks: Task[] = [];
  for (const tasksDir of dirs) {
    let ids: string[] = [];
    try {
      ids = fs.readdirSync(tasksDir);
    } catch {
      continue;
    }
    for (const id of ids) {
      if (seen.has(id)) {
        continue;
      }
      const taskFile = path.join(tasksDir, id, 'job.json');
      try {
        const task = normalizeTask(JSON.parse(fs.readFileSync(taskFile, 'utf8')) as Task);
        seen.add(id);
        tasks.push(task);
      } catch {
        // Skip a non-task or unreadable directory.
      }
    }
  }
  return tasks;
}

/** Task folders for background readers, without loading every archived record. */
export async function* taskDirectories(
  cwd: string,
): AsyncGenerator<{ id: string; dir: string; archived: boolean }> {
  const states = await fs.promises
    .readdir(path.dirname(resolveStateDir(cwd)), { withFileTypes: true })
    .catch(() => []);
  const dirs = [
    { dir: resolveTasksDir(cwd), archived: false },
    { dir: resolveArchiveDir(cwd), archived: true },
    ...states
      .filter(entry => entry.isDirectory() && entry.name !== GLOBAL_STATE_SLUG)
      .map(entry => ({
        dir: path.join(path.dirname(resolveStateDir(cwd)), entry.name, 'jobs'),
        archived: false,
      })),
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

function processStarts(): typeof processStartMs {
  const starts = new Map<number, number | null>();
  return pid => {
    if (!starts.has(pid)) starts.set(pid, processStartMs(pid));
    return starts.get(pid)!;
  };
}

// Active tasks: the global tasks bin plus legacy per-workspace dirs, deduped by
// id (global wins). Tasks flagged archived but still sitting in an active bin
// (older builds archived in place) migrate to the archive bin as they're seen.
export function listTasks(cwd: string): Task[] {
  const startMs = processStarts();
  const tasksDirs = [resolveTasksDir(cwd), ...legacyStateDirs().map(dir => path.join(dir, 'jobs'))];
  const tasks: Task[] = [];
  for (const stored of scanTasks(tasksDirs, new Set())) {
    const task = reconcileTask(cwd, stored, startMs);
    if (task.archived && !resumedAfterArchive(task)) {
      archiveTask(cwd, task);
    } else {
      tasks.push(task.archived ? unarchiveTask(cwd, task) : task);
    }
  }
  return tasks.sort(byRecency);
}

// Archived tasks. Scans the active bins too so in-place-archived legacy tasks
// show up (and migrate); those bins stay small once migration has run.
// migrate: false skips the directory moves for cheap counts on hot paths. The
// detached sweep or a later migrating scan finishes the moves).
export function listArchivedTasks(cwd: string, opts?: { migrate?: boolean }): Task[] {
  const startMs = processStarts();
  const migrate = opts?.migrate ?? true;
  const seen = new Set<string>();
  const archived: Task[] = [];
  for (const task of scanTasks([resolveArchiveDir(cwd)], seen)) {
    if (!resumedAfterArchive(task)) {
      archived.push(reconcileTask(cwd, task, startMs));
    } else if (migrate) {
      unarchiveTask(cwd, reconcileTask(cwd, task, startMs));
    }
  }
  const tasksDirs = [resolveTasksDir(cwd), ...legacyStateDirs().map(dir => path.join(dir, 'jobs'))];
  for (const task of scanTasks(tasksDirs, seen)) {
    if (task.archived && !resumedAfterArchive(task)) {
      const current = reconcileTask(cwd, task, startMs);
      archived.push(migrate ? archiveTask(cwd, current) : current);
    }
  }
  return archived.sort(byRecency);
}

export function findTask(cwd: string, reference?: string): Task | null {
  // Search active and archived alike (result/steer/delete accept archived
  // ids), newest first across both bins.
  // Archived first: it moves resumed tasks back to the active bin.
  const archived = listArchivedTasks(cwd);
  const tasks = [...listTasks(cwd), ...archived].sort(byRecency);
  if (!reference) {
    return tasks[0] ?? null;
  }
  const exact = tasks.find(task => task.id === reference);
  if (exact) {
    return exact;
  }
  const prefixed = tasks.filter(task => task.id.startsWith(reference));
  if (prefixed.length === 1) {
    return prefixed[0]!;
  }
  if (prefixed.length > 1) {
    throw new Error(`Task reference "${reference}" is ambiguous. Use a longer id.`);
  }
  return null;
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

// Block until a task reaches a terminal status, then return the final task.
// Reconciles each poll so a dead worker (zombie) resolves instead of hanging.
export async function waitForTerminalTask(cwd: string, task: Task, pollMs = 400): Promise<Task> {
  let current = task;
  while (!TERMINAL_STATUSES.includes(current.status)) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    current = reconcileTask(cwd, loadTask(cwd, current.id) ?? current);
  }
  return current;
}

// Follow-ups steered into a still-running task that could not be injected into
// the live turn because it was starting or completing are queued in this file.
// The worker that owns the task
// drains it when its turn finishes, running each as a resumed turn.
const STEER_QUEUE_FILE = 'steer-queue.jsonl';

export function enqueueSteer(cwd: string, taskId: string, text: string): void {
  const taskDir = resolveTaskDir(cwd, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.appendFileSync(
    path.join(taskDir, STEER_QUEUE_FILE),
    `${JSON.stringify({ at: new Date().toISOString(), text })}\n`,
    'utf8',
  );
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
  const taskDir = resolveTaskDir(cwd, taskId);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.appendFileSync(
    path.join(taskDir, 'log.jsonl'),
    `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`,
    'utf8',
  );
}

export interface TurnResultEntry {
  at?: string;
  prompt?: string | null;
  finalMessage?: string;
  status?: number;
  tokens?: TurnResult['tokens'];
  model?: TurnResult['model'];
  [key: string]: unknown;
}

export function readTurnResults(cwd: string, taskId: string): TurnResultEntry[] {
  const file = path.join(resolveTaskDir(cwd, taskId), 'results.jsonl');
  if (!fs.existsSync(file)) {
    return [];
  }
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
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
  const logFile = path.join(resolveTaskDir(cwd, taskId), 'log.jsonl');
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines).map((line): TaskLogEntry => {
    try {
      return JSON.parse(line) as TaskLogEntry;
    } catch {
      return { message: line };
    }
  });
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
