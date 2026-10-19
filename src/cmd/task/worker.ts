/** `coder task worker <task-id>`: runs a task's turns, detached. */
import { loadTask } from '../../core/state';
import { fail } from '../../tui/output';
import { str } from '../../utils/args';
import { command } from '../../cli';

export const commandWorker = command({
  name: 'worker',
  description: "run a task's turns, detached",
  access: 'write',
  args: { 'task-id': str() },
  globalFlags: { json: false },
  cli: { positional: ['task-id'] },
  mcp: false,
  async run({ args: [id], cwd }) {
    const { runWorker } = await import('../../core/task/worker');

    const task = loadTask(cwd, id!);
    if (!task) fail(`Worker: task ${id} not found.`);
    await runWorker(cwd, task);
  },
});
