/** `coder task stop`: stop a running task. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

export const commandStop = command({
  name: 'task stop',
  help: {
    usage: 'coder task stop <task-id> [--server [url]]',
    summary: 'Interrupt a running task and mark it cancelled.',
    flags: [SERVER_FLAG],
  },
  options: { ...baseOptions, ...serverOptions },
  args: 1,
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
