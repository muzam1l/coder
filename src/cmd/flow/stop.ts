/** `coder flow stop`: stop a running run and, unless kept, its tasks. */
import process from 'node:process';

import type { StopSummary } from '../../flow/executor';
import { outStyle, paintStatus } from '../../tui/output';
import { flag, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';

export const commandStop = command({
  name: 'stop',
  description: 'stop a run and its still-running tasks',
  usage:
    'Stop a running flow: signal the orchestrator so it stops dispatching, stamp the\nrun stopped, and stop its still-running tasks. Defaults to the most recent run;\nthe journal stays ready for `coder flow resume`.',
  access: 'write',
  approvalPolicy: 'deny',
  args: {
    'run-id': str('the run (default: the most recent)'),
    'keep-tasks': flag("leave the run's still-running tasks running"),
  },
  cli: { positional: ['run-id'] },
  run: async ({ options, args: [id] }) => {
    const { stopRun } = await import('../../flow/executor');
    return stopRun(id, { keepTasks: options['keep-tasks'] });
  },
  next: ({ result }) => nextSteps([`Resume: coder flow resume ${result.runId}`]),
  print: printStop,
});

/** `flow stop`: what stopped and what was left running. */
function printStop(summary: StopSummary): void {
  const s = outStyle;
  if (summary.status === 'failed') {
    // Stale record reconciled: the orchestrator was already dead.
    process.stdout.write(
      `${s.dim('[flow]')} Run ${s.cyan(summary.runId)} orchestrator died. Marked ${paintStatus('failed')}.\n`,
    );
  } else {
    process.stdout.write(
      `${s.dim('[flow]')} run ${s.cyan(summary.runId)} ${paintStatus(summary.status)}.\n`,
    );
  }
  if (summary.stoppedTasks.length) {
    process.stdout.write(`${s.dim('[flow]')} stopped tasks: ${summary.stoppedTasks.join(', ')}\n`);
  }
  if (summary.keptTasks.length) {
    process.stdout.write(`${s.dim('[flow]')} left running: ${summary.keptTasks.join(', ')}\n`);
  }
}
