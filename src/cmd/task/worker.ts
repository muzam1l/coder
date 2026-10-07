/** `coder task worker <task-id>`: runs a task's turns, detached. */
import process from 'node:process';

import { loadTask } from '../../core/state';
import { fail } from '../../tui/output';
import { str } from '../../utils/args';
import { command } from '../../cli';

export const commandWorker = command({
  name: 'task worker',
  options: { cwd: str },
  args: 1,
  async run({ args: [id], cwd }) {
    const { startAgentMailbox } = await import('../../agent/exec');
    const { runWorker } = await import('../../core/task/worker');

    const task = loadTask(cwd, id!);
    if (!task) fail(`Worker: task ${id} not found.`);
    await runWorker(cwd, task, startAgentMailbox).catch(() => process.exit(1));
  },
});
