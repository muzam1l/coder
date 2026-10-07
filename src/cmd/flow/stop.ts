/** `coder flow stop`: stop a running run and, unless kept, its tasks. */
import process from 'node:process';

import type { StopSummary } from '../../flow/executor';
import { formatHints, outStyle, paintStatus } from '../../tui/output';
import { baseOptions, flag } from '../../utils/args';
import { command } from '../../cli';

export const commandStop = command({
  name: 'flow stop',
  help: {
    usage: 'coder flow stop [run-id] [--keep-tasks] [--json]',
    summary:
      'Stop a running flow: signal the orchestrator so it stops dispatching, stamp the\nrun stopped, and stop its still-running tasks. Defaults to the most recent run;\nthe journal stays ready for `coder flow resume`.',
    flags: [['--keep-tasks', "leave the run's still-running tasks running"]],
  },
  options: { ...baseOptions, 'keep-tasks': flag },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { stopRun } = await import('../../flow/executor');
    return stopRun(id, { keepTasks: options['keep-tasks'] });
  },
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
  process.stdout.write(`\n${formatHints([`Resume: coder flow resume ${summary.runId}`], s)}\n`);
}
