import path from 'node:path';
import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { lastActivityAt, listJobs, resolveWorkspaceRoot } from '../lib/state.js';
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

// coder list                   -> active tasks (queued/running), non-archived
// coder task list --stopped    -> finished tasks (completed/failed/cancelled)
// coder task list --all        -> running + stopped (non-archived)
// coder task list --archived   -> archived tasks only
export async function commandJobs(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd', 'dir'],
    booleanOptions: ['json', 'all', 'stopped', 'archived'],
  });
  rejectExtraArgs(positionals, 0, 'task list');
  const cwd = resolveCwd(options);

  const isArchived = (job: Job) => job.archived === true;
  const isStopped = (job: Job) => TERMINAL_STATUSES.includes(job.status);
  const isActive = (job: Job) => ACTIVE_STATUSES.includes(job.status);

  let jobs = listJobs(cwd);
  // Tasks are stored globally; an explicit --dir (or legacy --cwd) narrows the
  // view to tasks launched in that workspace (matched by git root).
  const dir = options.dir ?? options.cwd;
  if (dir) {
    const wanted = resolveWorkspaceRoot(path.resolve(String(dir)));
    jobs = jobs.filter(job => job.cwd && resolveWorkspaceRoot(job.cwd) === wanted);
  }
  if (options.archived) {
    jobs = jobs.filter(isArchived);
  } else {
    // Archived is a separate bin: only the --archived view shows it.
    jobs = jobs.filter(job => !isArchived(job));
    if (options.stopped) {
      jobs = jobs.filter(isStopped);
    } else if (!options.all) {
      jobs = jobs.filter(isActive);
    }
  }

  const tasks = jobs.map(job => ({
    taskId: job.id,
    status: job.status,
    agent: job.agent ?? null,
    model: job.model ?? null,
    name: job.name ?? null,
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
      : options.stopped
        ? 'stopped tasks'
        : options.all
          ? 'tasks'
          : 'running tasks';
    process.stdout.write(`No ${scope}.\n`);
    // On the default (running) view, point at other scopes that do have tasks.
    const hints: string[] = [];
    if (!options.archived && !options.stopped && !options.all) {
      const all = listJobs(cwd);
      const stopped = all.filter(j => !isArchived(j) && isStopped(j)).length;
      const archived = all.filter(isArchived).length;
      if (stopped) hints.push(`${stopped} stopped: coder task list --stopped`);
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
      `${s.cyan(t.taskId.padEnd(24))} ${paintStatus(t.status, 10)} ${s.dim(((t.agent ?? '-') + (t.model ? `/${t.model}` : '')).padEnd(14))} ${label}${idle}${mark}\n`,
    );
  }

  const hints = ['Result: coder task result <task-id>'];
  // The default view only shows active tasks; point at the full list.
  if (!options.all && !options.stopped && !options.archived) {
    hints.push('All tasks: coder task list --all');
  }
  process.stdout.write(`\n${formatHints(hints, s)}\n`);
}
