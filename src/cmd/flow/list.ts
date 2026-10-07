/** `coder flow list`: recent runs. */
import process from 'node:process';

import { ageMs } from '../../core/state';
import type { FlowRecord } from '../../flow/types';
import {
  clipPad,
  formatAge,
  formatHints,
  formatTokenCount,
  outStyle,
  paintStatus,
} from '../../tui/output';
import { baseOptions, flag, limitOption } from '../../utils/args';
import { command } from '../../cli';

export const commandList = command({
  name: 'flow list',
  help: {
    usage: 'coder flow list [--archived] [--limit N] [--json]',
    summary:
      'List recent flow runs, most recent first: running runs plus ones that ended\nwithin the last 10 minutes. Older runs auto-archive and move to --archived.',
    flags: [
      ['--archived', 'show archived runs (auto-archived or via flow archive)'],
      ['--limit <n|all>', 'show at most n runs (default all)'],
    ],
  },
  options: { ...baseOptions, archived: flag, limit: limitOption },
  run: async ({ options }) => {
    const { collectFlowRuns } = await import('../../flow/runs');
    return collectFlowRuns(options);
  },
  json: listed => listed.runs,
  print: (listed, { options }) => printRuns(listed, options),
});

/** `flow list`: the runs table, or how to start one. */
function printRuns(
  { runs, clipped }: { runs: FlowRecord[]; clipped: number },
  options: { archived?: boolean; limit?: number | 'all' },
): void {
  if (!runs.length) {
    process.stdout.write(options.archived ? 'No archived flow runs.\n' : 'No recent flow runs.\n');
    process.stdout.write(
      `\n${formatHints(['Run one: coder flow run <name>', 'Runnable flows: coder flow discover'], outStyle)}\n`,
    );
    return;
  }
  const s = outStyle;
  const col = (min: number, max: number, values: string[]) =>
    Math.min(max, Math.max(min, ...values.map(v => v.length)));
  const w = {
    id: col(
      'run-id'.length,
      28,
      runs.map(r => r.runId),
    ),
    name: col(
      'name'.length,
      30,
      runs.map(r => r.name),
    ),
  };
  process.stdout.write(
    s.bold(
      s.light(
        `${'run-id'.padEnd(w.id)}  ${'name'.padEnd(w.name)}  ${'status'.padEnd(10)}  ${'tasks'.padEnd(9)}  ${'tokens'.padEnd(10)}  age\n`,
      ),
    ),
  );
  for (const r of runs) {
    const tokens = Object.values(r.ledger).reduce((sum, t) => sum + t.total, 0);
    process.stdout.write(
      `${s.cyan(clipPad(r.runId, w.id))}  ${clipPad(r.name, w.name)}  ${paintStatus(r.status, 10)}  ${s.light(clipPad(`${r.taskCount} tasks`, 9))}  ${s.light(clipPad(tokens ? `${formatTokenCount(tokens)} tok` : '-', 10))}  ${s.light(formatAge(ageMs(r.startedAt)))}\n`,
    );
  }
  if (clipped) {
    process.stdout.write(s.dim(`\n... ${clipped} more not shown (--limit ${options.limit})\n`));
  }
  process.stdout.write(
    `\n${formatHints(['Result: coder flow result <run-id>', 'Tasks: coder list', 'Runnable flows: coder flow discover'], s)}\n`,
  );
}
