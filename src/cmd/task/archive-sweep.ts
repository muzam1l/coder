/** `coder task archive-sweep [ids...]`: finishes archiving flagged tasks, or flow runs with `--flows`, in the background. */
import { flag, str } from '../../utils/args';
import { command } from '../../cli';

export const commandArchiveSweep = command({
  name: 'task archive-sweep',
  options: { cwd: str, flows: flag },
  args: Number.POSITIVE_INFINITY,
  run: async ({ options, args, cwd }) => {
    const { archiveFlagged } = await import('../../core/task/actions');
    const { archiveFlaggedRuns } = await import('../../flow/runs');
    return options.flows ? archiveFlaggedRuns(args) : archiveFlagged(cwd, args);
  },
});
