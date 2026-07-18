import { spawn } from 'node:child_process';
import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { archiveJob, findJob, listJobs } from '../lib/state.js';
import { CLI_PATH } from '../lib/runtime.js';
import { fail, outStyle, printJson, rejectExtraArgs, requireJob, resolveCwd } from '../lib/ui.js';
import { TERMINAL_STATUSES } from '../lib/types.js';

// Finish archiving already-flagged jobs (dir move + codex session) in a detached
// child so a `list` sweep never blocks on the fs moves. Best-effort: if it never
// runs, the migration in listJobs/listArchivedJobs completes the move later.
export function spawnArchiveSweep(cwd: string, jobIds: string[]) {
  if (!jobIds.length) return;
  try {
    const child = spawn(process.execPath, [CLI_PATH, '_archiveSweep', '--cwd', cwd, ...jobIds], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

// Hidden-command body invoked detached by spawnArchiveSweep.
export async function commandArchiveSweep(argv: string[]) {
  const { options, positionals } = parseArgs(argv, { valueOptions: ['cwd'] });
  const cwd = resolveCwd(options);
  for (const id of positionals) {
    const job = findJob(cwd, id);
    if (job) {
      archiveJob(cwd, job);
    }
  }
}

// coder task archive <task-id>     -> hide one task from the default list
// coder task archive --all-stopped -> archive every stopped (finished) task at once
export async function commandArchive(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['all-stopped', 'json'],
  });
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
