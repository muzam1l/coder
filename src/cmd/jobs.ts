import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { listJobs } from '../lib/state.js';
import { formatHints, outStyle, paintStatus, printJson, rejectExtraArgs, resolveCwd } from '../lib/ui.js';
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type Job } from '../lib/types.js';

// coder list                   -> active tasks (queued/running), non-archived
// coder task list --stopped    -> finished tasks (completed/failed/cancelled)
// coder task list --all        -> running + stopped (non-archived)
// coder task list --archived   -> archived tasks only
export async function commandJobs(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json', 'all', 'stopped', 'archived'],
  });
  rejectExtraArgs(positionals, 0, 'task list');
  const cwd = resolveCwd(options);

  const isArchived = (job: Job) => job.archived === true;
  const isStopped = (job: Job) => TERMINAL_STATUSES.includes(job.status);
  const isActive = (job: Job) => ACTIVE_STATUSES.includes(job.status);

  let jobs = listJobs(cwd);
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
    name: job.name ?? null,
    prompt: String(job.prompt ?? '').slice(0, 80),
    updatedAt: job.updatedAt,
    archived: job.archived ?? false,
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
    process.stdout.write(
      `${s.cyan(t.taskId.padEnd(24))} ${paintStatus(t.status, 10)} ${s.dim((t.agent ?? '-').padEnd(7))} ${label}${mark}\n`,
    );
  }

  const anyRunning = tasks.some(t => t.status === 'running' || t.status === 'queued');
  const hints = ['Result: coder task result <task-id>'];
  if (anyRunning) {
    hints.push('Follow running: coder task stream <task-id>');
  }
  process.stdout.write(`\n${formatHints(hints, s)}\n`);
}
