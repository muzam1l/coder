/**
 * Blocking wait shared by `run --wait` and `result --wait`. Returns when the
 * task finishes OR a pending approval appears, so a --wait surfaces the approval
 * (which is answered out of band with `coder approve`) instead of blocking
 * silently through it until the worker's 120s auto-decline.
 */
import { readJob, reconcileJob, resolveJobDir } from './state.js';
import { listPendingApprovals } from './approvals.js';
import { TERMINAL_STATUSES, type Job } from './types.js';

export interface WaitOutcome {
  job: Job;
  reason: 'terminal' | 'approval';
  approval?: { id: string; summary: string };
}

export async function waitForTaskAttention(cwd: string, job: Job, pollMs = 400): Promise<WaitOutcome> {
  let current = job;
  for (;;) {
    if (TERMINAL_STATUSES.includes(current.status)) {
      return { job: current, reason: 'terminal' };
    }
    const pending = listPendingApprovals(resolveJobDir(cwd, current.id)).filter(a => !a.response);
    if (pending[0]) {
      return {
        job: current,
        reason: 'approval',
        approval: { id: pending[0].id, summary: String(pending[0].summary ?? '') },
      };
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
    current = reconcileJob(cwd, readJob(cwd, current.id) ?? current);
  }
}
