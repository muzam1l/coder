/** `coder flow archive`: hide a run, or every stopped one, from the default list. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag } from '../../utils/args';
import { command } from '../../cli';

export const plural = (count: number) => (count === 1 ? '' : 's');

export const commandArchive = command({
  name: 'flow archive',
  help: {
    usage: 'coder flow archive <run-id> | coder flow archive --all-stopped',
    summary:
      'Archive a flow run so it drops out of the default list (see it again with\n`coder flow list --archived [--limit N]`). Pass --all-stopped to archive every\nfinished run. A running run must be stopped first.',
    flags: [['--all-stopped', 'archive every stopped (finished) run']],
  },
  options: { ...baseOptions, 'all-stopped': flag },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { archiveRuns } = await import('../../flow/runs');
    return archiveRuns(id, { allStopped: options['all-stopped'] });
  },
  print(result) {
    if (!('count' in result))
      return void process.stdout.write(`Archived run ${outStyle.cyan(result.runId)}.\n`);
    process.stdout.write(
      result.count
        ? `Archived ${result.count} stopped run${plural(result.count)}.\n`
        : `${outStyle.dim('No stopped runs to archive.')}\n`,
    );
  },
});
