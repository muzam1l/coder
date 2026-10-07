/** `coder flow delete`: remove a run, or every archived one, from disk. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag } from '../../utils/args';
import { command } from '../../cli';
import { plural } from './archive';

export const commandDelete = command({
  name: 'flow delete',
  help: {
    usage: 'coder flow delete <run-id> | coder flow delete --all-archived',
    summary:
      "Delete a flow run's record from disk (its journal, events, and logs). This is\npermanent; the run's tasks are ordinary tasks and are not touched. Pass\n--all-archived to delete every archived run at once. A running run must be\nstopped first.",
    flags: [['--all-archived', 'delete every archived run']],
  },
  options: { ...baseOptions, 'all-archived': flag },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { deleteRuns } = await import('../../flow/runs');
    return deleteRuns(id, { allArchived: options['all-archived'] });
  },
  print(result) {
    if (!('count' in result))
      return void process.stdout.write(`Deleted run ${outStyle.cyan(result.runId)}.\n`);
    process.stdout.write(
      result.count
        ? `Deleted ${result.count} archived run${plural(result.count)}.\n`
        : `${outStyle.dim('No archived runs to delete.')}\n`,
    );
  },
});
