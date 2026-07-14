import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { deleteJob, listJobs } from '../lib/state.js';
import { fail, outStyle, printJson, rejectExtraArgs, requireJob, resolveCwd } from '../lib/ui.js';
import type { Job } from '../lib/types.js';
import { deleteCodexSession } from '../lib/codex-sessions.js';
import { deleteClaudeSession } from '../lib/claude-sessions.js';

// Also delete the engine session behind a task, so it is removed from codex/
// claude rather than lingering. Best-effort.
function deleteSessionFor(job: Job) {
  if (!job.threadId) {
    return;
  }
  if (job.engine === 'codex') {
    deleteCodexSession(job.threadId);
  } else if (job.engine === 'claude') {
    deleteClaudeSession(job.threadId);
  }
}

// coder task delete <task-id>      -> remove one task's session from disk
// coder task delete --all-archived -> remove every archived task at once
export async function commandDelete(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['all-archived', 'json'],
  });
  rejectExtraArgs(positionals, 1, 'task delete');
  const cwd = resolveCwd(options);

  if (options['all-archived']) {
    const targets = listJobs(cwd).filter(job => job.archived);
    const ids = targets
      .filter(job => {
        deleteSessionFor(job);
        return deleteJob(cwd, job.id);
      })
      .map(job => job.id);
    if (options.json) {
      printJson({ deleted: ids, count: ids.length });
      return;
    }
    process.stdout.write(
      ids.length
        ? `Deleted ${ids.length} archived task${ids.length === 1 ? '' : 's'}.\n`
        : `${outStyle.dim('No archived tasks to delete.')}\n`,
    );
    return;
  }

  const reference = positionals[0];
  if (!reference) {
    fail('Missing task id.', {
      hint: [
        'Delete one: coder task delete <task-id>',
        'Delete all archived: coder task delete --all-archived',
      ],
    });
  }
  const job = requireJob(cwd, reference);
  if (job.status === 'running') {
    fail(`Task ${job.id} is still running.`, { hint: `Stop it first: coder task stop ${job.id}` });
  }
  deleteSessionFor(job);
  deleteJob(cwd, job.id);
  if (options.json) {
    printJson({ taskId: job.id, deleted: true });
    return;
  }
  process.stdout.write(`Deleted task ${outStyle.cyan(job.id)}.\n`);
}
