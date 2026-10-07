/** `coder flow resume`: continue a stopped or edited run from its journal, like flow run. */
import { command } from '../../cli';
import { RUN_FLAGS, hooks, parseRunArgs, printDetached, runOptions } from './run';
import { printFollow, printRunSummary } from './watch';

export const commandResume = command({
  name: 'flow resume',
  help: {
    usage: 'coder flow resume [run-id] [--wait] [--json] [--dry-run]',
    summary:
      'Re-run a flow from its journal: finished steps replay instantly, the first\nchanged or new step onward runs live. Defaults to the most recent run.\nAccepts the same flags as flow run.',
    flags: [
      ['--wait', 'follow the run in the foreground (Ctrl-C detaches; it keeps running)'],
      ['--concurrency <n>', 'tasks running at once'],
      ['--max-tasks <n>', 'total tasks the run may dispatch'],
    ],
    examples: [['coder flow resume', 'continue the most recent run']],
  },
  options: RUN_FLAGS,
  args: 1,
  async run({ options, args: [id], cwd }) {
    const { resumeRun } = await import('../../flow/runs');

    const started = await resumeRun(
      id,
      {
        ...runOptions(options, cwd),
        ...(options.args !== undefined ? { args: parseRunArgs(options.args, []) } : {}),
      },
      hooks(options),
    );
    if (started.status === 'running' && started.watch) await printFollow(started.watch, options);
    return started;
  },
  print: started =>
    started.status === 'running' ? printDetached(started) : printRunSummary(started),
});
