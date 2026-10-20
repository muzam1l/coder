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
  print: ({ taskId, interrupt }) =>
    process.stdout.write(
      `Stopped task ${outStyle.cyan(taskId)} ${outStyle.dim(`(${interrupt})`)}\n`,
    ),
});
