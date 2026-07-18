import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { archiveJob, listJobs } from '../lib/state.js';
import { fail, outStyle, printJson, rejectExtraArgs, requireJob, resolveCwd } from '../lib/ui.js';
import { TERMINAL_STATUSES, type Job } from '../lib/types.js';
import { archiveCodexSession } from '../lib/codex-sessions.js';

// Also archive the codex session behind a task, so it moves to codex's archived
// section instead of lingering in the Codex app. Best-effort, codex tasks only.
export function archiveSessionFor(job: Job) {
  if (job.engine === 'codex' && job.threadId) {
    archiveCodexSession(job.threadId);
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
      archiveSessionFor(job);
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
  archiveSessionFor(job);
  if (options.json) {
    printJson({ taskId: job.id, archived: true });
    return;
  }
  process.stdout.write(`Archived task ${outStyle.cyan(job.id)}.\n`);
}
