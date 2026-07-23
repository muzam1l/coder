import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { flag, limitOption, parseArgs, str } from '../lib/args.js';
import {
  AUTO_ARCHIVE_MS,
  lastActivityAt,
  listArchivedJobs,
  listJobs,
  markJobArchived,
  resolveWorkspaceRoot,
} from '../lib/state.js';
import { spawnArchiveSweep } from './archive.js';
import { readFlowRecord } from '../flow/runtime.js';
import {
  IDLE_SHOW_MS,
  STALL_MS,
  ageMs,
  clipPad,
  formatAge,
  formatHints,
  outStyle,
  paintStatus,
  printJson,
  rejectExtraArgs,
  resolveCwd,
} from '../lib/ui.js';
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type Job } from '../lib/types.js';

/** Filters for the task list, mirroring the CLI flags. */
export interface ListOptions {
  running?: boolean;
  stopped?: boolean;
  archived?: boolean;
  /** Narrow to a workspace (matched by git root). */
  dir?: string;
  /** Max rows; 'all' or undefined means no limit. */
  limit?: number | 'all';
}

// Print-free core: gather the tasks the CLI (and SDK) list, applying the
// auto-archive sweep, the status/workspace filters, the default-view sort, and
// the limit. Returns the resolved jobs plus how many were clipped by --limit.
export function collectJobs(cwd: string, options: ListOptions = {}): { jobs: Job[]; clipped: number } {
  // --limit all matches the default (everything).
  const limit = options.limit === 'all' ? undefined : options.limit;

  const isStopped = (job: Job) => TERMINAL_STATUSES.includes(job.status);

  // Auto-archive sweep: any task stopped longer than AUTO_ARCHIVE_MS drops out of
  // the default view. Flag it archived inline (cheap, keeps the record and count
  // correct) but defer the slow dir move to a detached sweep.
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
  // Tasks are stored globally; an explicit dir narrows to tasks launched in that
  // workspace (matched by git root).
  if (options.dir) {
    const wanted = resolveWorkspaceRoot(path.resolve(String(options.dir)));
    jobs = jobs.filter(job => job.cwd && resolveWorkspaceRoot(job.cwd) === wanted);
  }

  // The default (recent) view surfaces what needs attention: failed tasks first,
  // then running, with completed last — so --limit trims completed tasks first.
  if (!options.archived && !options.running && !options.stopped) {
    const rank = (job: Job) =>
      job.status === 'failed'
        ? 0
        : ACTIVE_STATUSES.includes(job.status)
          ? 1
          : job.status === 'completed'
            ? 3
            : 2;
    jobs = [...jobs].sort((a, b) => rank(a) - rank(b));
  }
  const clipped = limit !== undefined ? Math.max(0, jobs.length - limit) : 0;
  if (limit !== undefined) {
    jobs = jobs.slice(0, limit);
  }
  return { jobs, clipped };
}

// coder list                   -> recent tasks: running + stopped in the last 2 min
// coder task list --running    -> only the running ones
// coder task list --stopped    -> only the recently stopped ones
// coder task list --archived   -> archived tasks (everything older)
export async function commandJobs(argv: string[]) {
  const { options, positionals } = parseArgs(
    argv,
    z.object({
      cwd: str,
      dir: str,
      limit: limitOption,
      json: flag,
      running: flag,
      stopped: flag,
      archived: flag,
    }),
  );
  rejectExtraArgs(positionals, 0, 'task list');
  const cwd = resolveCwd(options);
  const limit = options.limit === 'all' ? undefined : options.limit;

  const { jobs, clipped } = collectJobs(cwd, {
    running: options.running,
    stopped: options.stopped,
    archived: options.archived,
    dir: options.dir ?? options.cwd,
    limit: options.limit,
  });

  const tasks = jobs.map(job => ({
    taskId: job.id,
    status: job.status,
    agent: job.agent ?? null,
    model: job.model ?? null,
    name: job.name ?? null,
    cwd: job.cwd ?? null,
    prompt: String(job.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 80),
    updatedAt: job.updatedAt,
    archived: job.archived ?? false,
    flowRunId: job.flowRunId ?? null,
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
      if (archived) hints.push(`${archived} archived: coder task list --archived [--limit N]`);
    }
    if (hints.length) {
      process.stdout.write(`\n${formatHints(hints, outStyle)}\n`);
    }
    return;
  }
  const s = outStyle;
  type Row = (typeof tasks)[number];
  const renderRow = (t: Row) => {
    const mark = t.archived ? ` ${s.dim('(archived)')}` : '';
    const label = t.name ? t.name : s.light(t.prompt);
    const idle =
      t.idleMs !== null && t.idleMs >= IDLE_SHOW_MS
        ? ` ${(t.idleMs > STALL_MS ? s.red : s.dim)(`· idle ${formatAge(t.idleMs)}`)}`
        : '';
    const who =
      t.agent === 'custom' && t.model
        ? t.model
        : (t.agent ?? '-') + (t.model ? `/${t.model}` : '');
    process.stdout.write(
      `${s.cyan(t.taskId.padEnd(24))} ${paintStatus(t.status, 10)} ${s.light(clipPad(who, 14))} ${s.light(clipPad(t.cwd ? path.basename(t.cwd) : '-', 12))} ${label}${idle}${mark}\n`,
    );
  };

  process.stdout.write(
    s.bold(s.light(`${'task-id'.padEnd(24)} ${'status'.padEnd(10)} ${'agent'.padEnd(14)} ${'cwd'.padEnd(12)} prompt\n`)),
  );

  // Tasks stay in time order; a flow run renders as a header plus its grouped
  // tasks, anchored where the run's first-listed task falls in that order.
  const grouped = new Map<string, Row[]>();
  for (const t of tasks) {
    if (t.flowRunId) {
      (grouped.get(t.flowRunId) ?? grouped.set(t.flowRunId, []).get(t.flowRunId)!).push(t);
    }
  }
  // A flow group gets a blank line above and below (never doubled between
  // adjacent groups, never leading the list).
  const rendered = new Set<string>();
  let started = false;
  let afterGroup = false;
  for (const t of tasks) {
    if (!t.flowRunId) {
      if (afterGroup) process.stdout.write('\n');
      renderRow(t);
      started = true;
      afterGroup = false;
      continue;
    }
    if (rendered.has(t.flowRunId)) continue;
    rendered.add(t.flowRunId);
    // The run's header line: id first like task rows, then status, then name.
    const record = readFlowRecord(t.flowRunId);
    const header = record
      ? `(${s.bold(t.flowRunId)} ${record.status} — flow ${record.name})`
      : `(${s.bold(t.flowRunId)} flow)`;
    process.stdout.write(`${started ? '\n' : ''}${header}\n`);
    for (const row of grouped.get(t.flowRunId)!) {
      renderRow(row);
    }
    started = true;
    afterGroup = true;
  }

  if (clipped) {
    process.stdout.write(s.dim(`\n... ${clipped} more not shown (--limit ${limit})\n`));
  }

  const hints = ['Result: coder task result <task-id>'];
  // The default view only shows recent tasks; point at the archive.
  if (!options.archived) {
    hints.push('Older tasks: coder task list --archived [--limit N]');
  }
  process.stdout.write(`\n${formatHints(hints, s)}\n`);
}
