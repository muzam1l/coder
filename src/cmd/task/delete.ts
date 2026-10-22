/** `coder task delete`: delete an archived task, or all of them. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, serverOptions, str } from '../../utils/args';
import { command } from '../../cli';
import { plural } from './archive';

export const commandDelete = command({
  name: 'delete',
  description: 'delete a session (or --all-archived)',
  usage:
    "Delete a task's session from disk. This is permanent. Pass --all-archived to\ndelete every archived task at once. A running task must be stopped first.",
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/tasks/:task-id',
      label: 'Delete the task',
      action: 'delete',
      args: ['task-id'],
      button: 'Delete',
    },
  },
  args: {
    'task-id': str('the task to delete'),
    'all-archived': flag('delete every archived task'),
    ...serverOptions,
  },
  cli: { positional: ['task-id'] },
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.delete(id, {
      ...options,
      organization: options.workspace,
      allArchived: options['all-archived'],
    });
  },
  print(result) {
    if (result.count === undefined)
      return void process.stdout.write(`Deleted task ${outStyle.cyan(result.taskId)}.\n`);
    process.stdout.write(
      result.count
        ? `Deleted ${result.count} archived task${plural(result.count)}.\n`
        : `${outStyle.dim('No archived tasks to delete.')}\n`,
    );
  },
});
