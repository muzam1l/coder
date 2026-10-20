/** `coder task archive`: archive a task, or all stopped tasks. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, serverOptions, str } from '../../utils/args';
import { command } from '../../cli';

export const plural = (count: number) => (count === 1 ? '' : 's');

export const commandArchive = command({
  name: 'archive',
  description: 'archive a session (or --all-stopped)',
  usage:
    'Archive a task session so it drops out of the default list (see it again with\n`coder task list --archived [--limit N]`). Pass --all-stopped to archive every\nfinished task. A running task keeps running; steering an archived task\nbrings it back.',
  access: 'write',
  args: {
    'task-id': str('the task to archive'),
    'all-stopped': flag('archive every stopped (finished) task'),
    ...serverOptions,
  },
  cli: { positional: ['task-id'] },
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.archive(id, {
      ...options,
      organization: options.workspace,
      allStopped: options['all-stopped'],
    });
  },
  print(result) {
    if (result.count === undefined)
      return void process.stdout.write(`Archived task ${outStyle.cyan(result.taskId)}.\n`);
    process.stdout.write(
      result.count
        ? `Archived ${result.count} stopped task${plural(result.count)}.\n`
        : `${outStyle.dim('No stopped tasks to archive.')}\n`,
    );
  },
});
