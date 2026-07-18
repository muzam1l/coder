import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs } from '../lib/args.js';
import { resolveJobDir } from '../lib/state.js';
import { answerApproval, listPendingApprovals } from '../lib/approvals.js';
import { fail, outStyle, printJson, rejectExtraArgs, requireJob, resolveCwd } from '../lib/ui.js';

export async function commandApprovals(argv: string[]) {
  const { options, positionals } = parseArgs(argv, z.object(baseOptions));
  rejectExtraArgs(positionals, 1, 'task approvals');
  const cwd = resolveCwd(options);
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
    process.stdout.write(`${outStyle.dim(`No approvals for task ${job.id}.`)}\n`);
    return;
  }
  const s = outStyle;
  for (const item of items) {
    const state = item.answered ?? 'pending';
    process.stdout.write(`${s.cyan(item.id)}  ${state.padEnd(8)} ${s.dim(item.summary)}\n`);
  }
}

export async function commandApprove(argv: string[]) {
  const { options, positionals } = parseArgs(argv, z.object({ ...baseOptions, deny: flag }));
  rejectExtraArgs(positionals, 2, 'task approve');
  const cwd = resolveCwd(options);
  const [reference, approvalId] = positionals;
  if (!reference || !approvalId) {
    fail('Missing task id or approval id.', {
      hint: ['List them: coder task approvals <task-id>', 'Usage: coder task approve <task-id> <id> [--deny]'],
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
