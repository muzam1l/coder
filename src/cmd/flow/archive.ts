/** `coder flow archive`: hide a run, or every stopped one, from the default list. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, str } from '../../utils/args';
import { command } from '../../cli';

export const plural = (count: number) => (count === 1 ? '' : 's');

export const commandArchive = command({
  name: 'archive',
  description: 'hide a run (or all stopped) from the list',
  usage:
    'Archive a flow run so it drops out of the default list (see it again with\n`coder flow list --archived [--limit N]`). Pass --all-stopped to archive every\nfinished run. A running run must be stopped first.',
  access: 'write',
  approvalPolicy: 'deny',
  args: {
    'run-id': str('the run to archive'),
    'all-stopped': flag('archive every stopped (finished) run'),
  },
  cli: { positional: ['run-id'] },
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
