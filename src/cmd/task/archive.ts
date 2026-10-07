/** `coder task archive`: archive a task, or all stopped tasks. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

export const plural = (count: number) => (count === 1 ? '' : 's');

export const commandArchive = command({
  name: 'task archive',
  help: {
    usage: 'coder task archive <task-id> | coder task archive --all-stopped [--server [url]]',
    summary:
      'Archive a task session so it drops out of the default list (see it again with\n`coder task list --archived [--limit N]`). Pass --all-stopped to archive every\nfinished task. A running task keeps running; steering an archived task\nbrings it back.',
    flags: [['--all-stopped', 'archive every stopped (finished) task'], SERVER_FLAG],
  },
  options: { ...baseOptions, 'all-stopped': flag, ...serverOptions },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.archive(id, {
      ...options,
      organization: options.workspace,
      allStopped: options['all-stopped'],
    });
  },
  print(result, { options }) {
    if (result.count === undefined)
      return void process.stdout.write(`Archived task ${outStyle.cyan(result.taskId)}.\n`);
    process.stdout.write(
      options.server !== undefined
        ? `Archived ${result.count} server task${plural(result.count)}.\n`
        : result.count
          ? `Archived ${result.count} stopped task${plural(result.count)}.\n`
          : `${outStyle.dim('No stopped tasks to archive.')}\n`,
    );
  },
});
