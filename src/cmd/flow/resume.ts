/** `coder flow resume`: continue a stopped or edited run from its journal, like flow run. */
import { str } from '../../utils/args';
import { command } from '../../cli';
import { RUN_FLAGS, finishRun, hooks, parseRunArgs, printDetached, runOptions } from './run';
import { printRunSummary, flowNext } from './watch';

export const commandResume = command({
  name: 'resume',
  description: 'continue a stopped or edited run',
  usage:
    'Re-run a flow from its journal: finished steps replay instantly, the first\nchanged or new step onward runs live. Defaults to the most recent run.\nAccepts the same flags as flow run.',
  access: 'write',
  args: { 'run-id': str('the run (default: the most recent)'), ...RUN_FLAGS },
  cli: {
    positional: ['run-id'],
    examples: ['coder flow resume  # continue the most recent run'],
  },
  async run({ options, args: [id], cwd, tool, next }) {
    const { resumeRun } = await import('../../flow/runs');

    const started = await resumeRun(
      id,
      {
        ...runOptions(options, cwd),
        ...(options.args !== undefined ? { args: parseRunArgs(options.args, []) } : {}),
      },
      hooks(options, tool),
    );
    return finishRun(started, options, tool, next);
  },
  next: ({ result }) => flowNext(result),
  print: started =>
    started.status === 'running' ? printDetached(started) : printRunSummary(started),
});
