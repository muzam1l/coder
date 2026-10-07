/** `coder task delete`: delete an archived task, or all of them. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { plural } from './archive';

const serverOptions = { server: optStr, workspace: str, yes: flag };

export const commandDelete = command({
  name: 'task delete',
  help: {
    usage: 'coder task delete <task-id> | coder task delete --all-archived [--server [url]]',
    summary:
      "Delete a task's session from disk. This is permanent. Pass --all-archived to\ndelete every archived task at once. A running task must be stopped first.",
    flags: [['--all-archived', 'delete every archived task'], SERVER_FLAG],
  },
  options: { ...baseOptions, 'all-archived': flag, ...serverOptions },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.delete(id, {
      ...options,
      organization: options.workspace,
      allArchived: options['all-archived'],
    });
  },
  print(result, { options }) {
    if (result.count === undefined)
      return void process.stdout.write(`Deleted task ${outStyle.cyan(result.taskId)}.\n`);
    process.stdout.write(
      options.server !== undefined
        ? `Deleted ${result.count} server task${plural(result.count)}.\n`
        : result.count
          ? `Deleted ${result.count} archived task${plural(result.count)}.\n`
          : `${outStyle.dim('No archived tasks to delete.')}\n`,
    );
  },
});
