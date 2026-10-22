import process from 'node:process';

import { str } from '../../utils/args';
import { command } from '../../cli';
import { driveRun } from '../../flow/runs';

export const commandDrive = command({
  name: 'drive',
  description: "drive a run's orchestrator, detached",
  access: 'write',
  approvalPolicy: 'deny',
  args: {
    'run-id': str(),
    task: str('the task this run reports to; it gets the result as a message', '<id>'),
    tool: str('with --task: the async tool the run answers for', '<name>'),
    timeout: str('with --task: stop the run after this many seconds', '<s>'),
  },
  globalFlags: { json: false },
  cli: { positional: ['run-id'] },
  mcp: false,
  async run({ args: [id], options, cwd }) {
    if (!options.task) return driveRun(id!, cwd);
    const [{ driveAsyncTool }, { asyncTools }] = await Promise.all([
      import('../../core/task/async'),
      import('../../core/task/context/tools'),
    ]);
    const tool = asyncTools.find(candidate => candidate.name === options.tool);
    if (!tool) throw new Error(`Unknown async tool "${options.tool}"`);

    await driveAsyncTool(
      tool,
      id!,
      cwd,
      options.task,
      options.timeout ? Number(options.timeout) : undefined,
    );
    // Tasks the run stopped may still hold timers; the result is delivered.
    process.exit(0);
  },
});
