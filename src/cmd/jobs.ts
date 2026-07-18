import path from 'node:path';
import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import {
  lastActivityAt,
  listArchivedJobs,
  listJobs,
  markJobArchived,
  resolveWorkspaceRoot,
} from '../lib/state.js';
import { spawnArchiveSweep } from './archive.js';
import {
  IDLE_SHOW_MS,
  STALL_MS,
  ageMs,
  formatAge,
  formatHints,
  outStyle,
  paintStatus,
  printJson,
  rejectExtraArgs,
  resolveCwd,
} from '../lib/ui.js';
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type Job } from '../lib/types.js';

// Stopped tasks linger in the recent view briefly, then auto-archive on the
// next list. After that they are visible only via --archived.
const AUTO_ARCHIVE_MS = 5 * 60_000;

// coder list                   -> recent tasks: running + stopped in the last 2 min
// coder task list --running    -> only the running ones
// coder task list --stopped    -> only the recently stopped ones
// coder task list --archived   -> archived tasks (everything older)
export async function commandJobs(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd', 'dir'],
    booleanOptions: ['json', 'running', 'stopped', 'archived'],
  });
  rejectExtraArgs(positionals, 0, 'task list');
  const cwd = resolveCwd(options);

  const isStopped = (job: Job) => TERMINAL_STATUSES.includes(job.status);

  // Auto-archive sweep: any task stopped longer than AUTO_ARCHIVE_MS drops out of
  // the default view. Flag it archived inline (cheap, keeps the record and count
  // correct) but defer the slow dir move to a detached sweep so listing many
  // expired tasks isn't blocked.
  const toArchive: string[] = [];
  let jobs = listJobs(cwd).filter(job => {
    if (!isStopped(job)) return true;
    const stoppedAt = job.completedAt ?? job.updatedAt ?? job.createdAt;
    if (ageMs(stoppedAt) <= AUTO_ARCHIVE_MS) return true;
    markJobArchived(cwd, job);
    toArchive.push(job.id);
    return false;
  });
  spawnArchiveSweep(cwd, toArchive);
  if (options.archived) {
    jobs = listArchivedJobs(cwd);
  } else if (options.running) {
    jobs = jobs.filter(job => ACTIVE_STATUSES.includes(job.status));
  } else if (options.stopped) {
    jobs = jobs.filter(isStopped);
  }
  // Tasks are stored globally; an explicit --dir (or legacy --cwd) narrows the
  // view to tasks launched in that workspace (matched by git root).
  const dir = options.dir ?? options.cwd;
  if (dir) {
    const wanted = resolveWorkspaceRoot(path.resolve(String(dir)));
    jobs = jobs.filter(job => job.cwd && resolveWorkspaceRoot(job.cwd) === wanted);
  }

  const tasks = jobs.map(job => ({
    taskId: job.id,
    status: job.status,
    agent: job.agent ?? null,
    model: job.model ?? null,
    name: job.name ?? null,
    cwd: job.cwd ?? null,
    prompt: String(job.prompt ?? '').slice(0, 80),
    updatedAt: job.updatedAt,
    archived: job.archived ?? false,
    // Idle = time since the agent last emitted anything (log, heartbeat, or
    // job update), not just since the job record changed.
    idleMs: ACTIVE_STATUSES.includes(job.status) ? ageMs(lastActivityAt(cwd, job)) : null,
  }));

  if (options.json) {
    printJson(tasks);
    return;
  }
  if (!tasks.length) {
    const scope = options.archived
      ? 'archived tasks'
      : options.running
        ? 'running tasks'
        : options.stopped
          ? 'recently stopped tasks'
          : 'recent tasks';
    process.stdout.write(`No ${scope}.\n`);
    // On the default (recent) view, point at the archive if it has tasks.
    const hints: string[] = [];
    if (!options.archived) {
      const archived = listArchivedJobs(cwd, { migrate: false }).length;
      if (archived) hints.push(`${archived} archived: coder task list --archived`);
    }
    if (hints.length) {
      process.stdout.write(`\n${formatHints(hints, outStyle)}\n`);
    }
    return;
  }
  const s = outStyle;
  for (const t of tasks) {
    const mark = t.archived ? ` ${s.dim('(archived)')}` : '';
    // Named tasks show their name; unnamed ones fall back to the prompt.
    const label = t.name ? t.name : s.dim(t.prompt);
    // For a running task, show how long since its last update (slow vs hung).
    const idle =
      t.idleMs !== null && t.idleMs >= IDLE_SHOW_MS
        ? ` ${(t.idleMs > STALL_MS ? s.red : s.dim)(`· idle ${formatAge(t.idleMs)}`)}`
        : '';
    process.stdout.write(
      `${s.cyan(t.taskId.padEnd(24))} ${paintStatus(t.status, 10)} ${s.dim(((t.agent ?? '-') + (t.model ? `/${t.model}` : '')).padEnd(14))} ${s.dim((t.cwd ? path.basename(t.cwd) : '-').padEnd(12))} ${label}${idle}${mark}\n`,
    );
  }

  const hints = ['Result: coder task result <task-id>'];
  // The default view only shows recent tasks; point at the archive.
  if (!options.archived) {
    hints.push('Older tasks: coder task list --archived');
  }
  process.stdout.write(`\n${formatHints(hints, s)}\n`);
}
