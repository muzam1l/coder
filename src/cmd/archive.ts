import { spawn } from 'node:child_process';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs, str } from '../lib/args.js';
import { archiveJob, findJob, listJobs } from '../lib/state.js';
import { CLI_PATH } from '../lib/runtime.js';
import { archiveRun, readFlowRecord } from '../flow/runtime.js';
import { fail, outStyle, printJson, rejectExtraArgs, requireJob, resolveCwd } from '../lib/ui.js';
import { TERMINAL_STATUSES } from '../lib/types.js';

// Finish archiving already-flagged jobs (dir move + codex session) — or, with
// flows, flow runs — in a detached child so a `list` sweep never blocks on the
// fs moves. Best-effort: if it never runs, the migration in listJobs/
// listArchivedJobs (listRuns/listArchivedRuns) completes the move later.
export function spawnArchiveSweep(cwd: string, ids: string[], opts: { flows?: boolean } = {}) {
  if (!ids.length) return;
  try {
    const child = spawn(
      process.execPath,
      [CLI_PATH, '_archiveSweep', '--cwd', cwd, ...(opts.flows ? ['--flows'] : []), ...ids],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    child.unref();
  } catch {
    /* best-effort */
  }
}

// Hidden-command body invoked detached by spawnArchiveSweep.
export async function commandArchiveSweep(argv: string[]) {
  const { options, positionals } = parseArgs(argv, z.object({ cwd: str, flows: flag }));
  const cwd = resolveCwd(options);
  for (const id of positionals) {
    if (options.flows) {
      const record = readFlowRecord(id);
      if (record) {
        archiveRun(record);
      }
      continue;
    }
    const job = findJob(cwd, id);
    if (job) {
      archiveJob(cwd, job);
    }
  }
}

// coder task archive <task-id>     -> hide one task from the default list
// coder task archive --all-stopped -> archive every stopped (finished) task at once
export async function commandArchive(argv: string[]) {
  const { options, positionals } = parseArgs(argv, z.object({ ...baseOptions, 'all-stopped': flag }));
  rejectExtraArgs(positionals, 1, 'task archive');
  const cwd = resolveCwd(options);

  if (options['all-stopped']) {
    const targets = listJobs(cwd).filter(job => TERMINAL_STATUSES.includes(job.status));
    for (const job of targets) {
      archiveJob(cwd, job);
    }
    const ids = targets.map(job => job.id);
    if (options.json) {
      printJson({ archived: ids, count: ids.length });
      return;
    }
    process.stdout.write(
      ids.length
        ? `Archived ${ids.length} stopped task${ids.length === 1 ? '' : 's'}.\n`
        : `${outStyle.dim('No stopped tasks to archive.')}\n`,
    );
    return;
  }

  const reference = positionals[0];
  if (!reference) {
    fail('Missing task id.', {
      hint: [
        'Archive one: coder task archive <task-id>',
        'Archive all stopped: coder task archive --all-stopped',
      ],
    });
  }
  const job = requireJob(cwd, reference);
  archiveJob(cwd, job);
  if (options.json) {
    printJson({ taskId: job.id, archived: true });
    return;
  }
  process.stdout.write(`Archived task ${outStyle.cyan(job.id)}.\n`);
}
