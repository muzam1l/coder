/** `coder task stop`: stop a running task. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { serverOptions, str } from '../../utils/args';
import { command } from '../../cli';

export const commandStop = command({
  name: 'stop',
  description: 'interrupt a running task',
  usage: 'Interrupt a running task and mark it cancelled.',
  access: 'write',
  args: { 'task-id': str('the task to stop'), ...serverOptions },
  cli: { positional: ['task-id'] },
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.stop(id, { ...options, organization: options.workspace });
  },
  print: (result, { options, args: [id] }) =>
    process.stdout.write(
      options.server !== undefined
        ? `Stopped server task ${outStyle.cyan(id!)}.\n`
        : `Stopped task ${outStyle.cyan((result as { taskId: string }).taskId)} ${outStyle.dim(`(${(result as { interrupt: string }).interrupt})`)}\n`,
    ),
});
