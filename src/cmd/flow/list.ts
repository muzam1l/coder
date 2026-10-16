/** `coder flow list`: recent runs. */
import process from 'node:process';

import { ageMs } from '../../core/state';
import type { FlowRecord } from '../../flow/types';
import {
  formatAge,
  formatHints,
  formatTokenCount,
  outStyle,
  paintStatus,
  renderTable,
} from '../../tui/output';
import { baseOptions, flag, limitOption } from '../../utils/args';
import { command } from '../../cli';

export const commandList = command({
  name: 'flow list',
  help: {
    usage: 'coder flow list [--archived] [--limit N] [--json]',
    summary:
      'List recent flow runs, most recent first: running runs plus ones that ended\nwithin the last 30 minutes. Older runs auto-archive and move to --archived.',
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
  process.stdout.write(
    `${renderTable(
      [
        {
          header: 'run-id',
          value: (r: FlowRecord) => r.runId,
          max: 28,
          paint: cell => s.cyan(cell),
        },
        { header: 'name', value: r => r.name, max: 30 },
        {
          header: 'status',
          value: r => r.status,
          paint: (cell, row) => paintStatus(row.status, cell.length),
        },
        { header: 'tasks', value: r => `${r.taskCount} tasks`, paint: cell => s.light(cell) },
        {
          header: 'tokens',
          value: r => {
            const tokens = Object.values(r.ledger).reduce((sum, t) => sum + t.total, 0);
            return tokens ? `${formatTokenCount(tokens)} tok` : '-';
          },
          paint: cell => s.light(cell),
        },
        { header: 'age', value: r => formatAge(ageMs(r.startedAt)), paint: cell => s.light(cell) },
      ],
      runs,
      s,
    )}\n`,
  );
  if (clipped) {
    process.stdout.write(s.dim(`\n... ${clipped} more not shown (--limit ${options.limit})\n`));
  }
  process.stdout.write(
    `\n${formatHints(['Result: coder flow result <run-id>', 'Tasks: coder list', 'Runnable flows: coder flow discover'], s)}\n`,
  );
}
