import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { writeJob } from '../lib/state.js';
import { interruptTurn } from '../lib/codex-core.js';
import { outStyle, printJson, rejectExtraArgs, requireJob, resolveCwd } from '../lib/ui.js';

export async function commandStop(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });
  rejectExtraArgs(positionals, 1, 'task stop');
  const cwd = resolveCwd(options);
  const job = requireJob(cwd, positionals[0]);

  // Claude tasks have no app-server turn to interrupt; killing the worker
  // takes the claude child down with it (SIGTERM handler in claude-core).
  const interrupt =
    job.engine === 'claude'
      ? { detail: 'claude worker terminated' }
      : await interruptTurn(cwd, { threadId: job.threadId, turnId: job.turnId });
  if (job.pid && job.status === 'running') {
    try {
      process.kill(job.pid, 'SIGTERM');
    } catch {
      // Worker already exited.
    }
  }
  writeJob(cwd, job.id, { status: 'cancelled', completedAt: new Date().toISOString() });

  if (options.json) {
    printJson({ taskId: job.id, status: 'cancelled', interrupt: interrupt.detail });
    return;
  }
  process.stdout.write(
    `Stopped task ${outStyle.cyan(job.id)} ${outStyle.dim(`(${interrupt.detail})`)}\n`,
  );
}
