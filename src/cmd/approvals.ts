import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs } from '../lib/args.js';
import { listJobs, resolveJobDir } from '../lib/state.js';
import { answerApproval, listPendingApprovals } from '../lib/approvals.js';
import {
  ageMs,
  fail,
  formatAge,
  formatHints,
  outStyle,
  printJson,
  rejectExtraArgs,
  requireJob,
  resolveCwd,
} from '../lib/ui.js';
import { ACTIVE_STATUSES } from '../lib/types.js';

interface PendingRow {
  taskId: string;
  id: string;
  summary: string;
  createdAt?: string;
}

// Unanswered approvals across every active task.
function collectPending(cwd: string): PendingRow[] {
  return listJobs(cwd)
    .filter(job => ACTIVE_STATUSES.includes(job.status))
    .flatMap(job =>
      listPendingApprovals(resolveJobDir(cwd, job.id))
        .filter(a => !a.response)
        .map(a => ({
          taskId: job.id,
          id: a.id,
          summary: String(a.summary ?? ''),
          createdAt: a.createdAt ? String(a.createdAt) : undefined,
        })),
    );
}

// coder approvals            -> pending approvals across all tasks
// coder approvals <task-id>  -> that task's approvals (answered ones included)
export async function commandApprovals(argv: string[]) {
  const { options, positionals } = parseArgs(argv, z.object(baseOptions));
  rejectExtraArgs(positionals, 1, 'task approvals');
  const cwd = resolveCwd(options);
  const s = outStyle;

  if (positionals[0]) {
    const job = requireJob(cwd, positionals[0]);
    const items = listPendingApprovals(resolveJobDir(cwd, job.id)).map(approval => ({
      id: approval.id,
      summary: approval.summary,
      createdAt: approval.createdAt,
      answered: approval.response?.decision ?? null,
    }));
    if (options.json) {
      printJson(items);
      return;
    }
    if (!items.length) {
      process.stdout.write(`${s.dim(`No approvals for task ${job.id}.`)}\n`);
      return;
    }
    for (const item of items) {
      const state = item.answered ?? 'pending';
      process.stdout.write(`${s.cyan(item.id)}  ${state.padEnd(8)} ${s.dim(String(item.summary ?? ''))}\n`);
    }
    const pending = items.filter(item => !item.answered);
    if (pending.length) {
      const ref = pending.length === 1 ? pending[0]!.id : '<approval-id>';
      process.stdout.write(`\n${formatHints([`Answer: coder approve ${ref} [--deny]`], s)}\n`);
    }
    return;
  }

  const rows = collectPending(cwd);
  if (options.json) {
    printJson(rows);
    return;
  }
  if (!rows.length) {
    process.stdout.write(`${s.dim('No pending approvals.')}\n`);
    return;
  }
  const w = {
    id: Math.max('approval-id'.length, ...rows.map(r => r.id.length)),
    task: Math.max('task-id'.length, ...rows.map(r => r.taskId.length)),
  };
  process.stdout.write(
    s.bold(s.light(`${'approval-id'.padEnd(w.id)}  ${'task-id'.padEnd(w.task)}  age    summary\n`)),
  );
  for (const r of rows) {
    const age = r.createdAt ? formatAge(ageMs(r.createdAt)) : '-';
    process.stdout.write(
      `${s.cyan(r.id.padEnd(w.id))}  ${s.cyan(r.taskId.padEnd(w.task))}  ${age.padEnd(5)}  ${s.light(r.summary)}\n`,
    );
  }
  const ref = rows.length === 1 ? rows[0]!.id : '<approval-id>';
  process.stdout.write(`\n${formatHints([`Answer: coder approve ${ref} [--deny]`], s)}\n`);
}

export async function commandApprove(argv: string[]) {
  const { options, positionals } = parseArgs(argv, z.object({ ...baseOptions, deny: flag }));
  rejectExtraArgs(positionals, 2, 'task approve');
  const cwd = resolveCwd(options);
  // Approval ids are globally unique, so the task id is optional:
  //   coder approve <approval-id>  |  coder approve <task-id> <approval-id>
  let [reference, approvalId]: (string | undefined)[] = positionals;
  if (reference && !approvalId && reference.startsWith('apr-')) {
    approvalId = reference;
    reference = collectPending(cwd).find(r => r.id === approvalId)?.taskId;
    if (!reference) {
      fail(`No pending approval "${approvalId}".`, { hint: 'List them: coder approvals' });
    }
  }
  if (!reference || !approvalId) {
    fail('Missing approval id.', {
      hint: ['List them: coder approvals', 'Usage: coder approve [task-id] <approval-id> [--deny]'],
    });
  }
  const job = requireJob(cwd, reference);
  const decision = options.deny ? 'decline' : 'accept';
  answerApproval(resolveJobDir(cwd, job.id), approvalId, decision);

  if (options.json) {
    printJson({ taskId: job.id, approvalId, decision });
    return;
  }
  process.stdout.write(
    `${options.deny ? 'Denied' : 'Approved'} ${outStyle.cyan(approvalId)} on task ${outStyle.cyan(job.id)}.\n`,
  );
}
