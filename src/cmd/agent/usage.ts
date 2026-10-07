/** `coder agent usage`: tasks, runner time and tokens per agent over a period. */
import process from 'node:process';

import type { UsageTotals } from '../../server/tasks/usage';
import { outStyle, renderTable } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

function printUsage(result: UsageTotals, by?: string): void {
  const rows = Array.isArray(result.totals)
    ? result.totals.map(row => ({ group: by ?? '', ...row }))
    : Object.entries(result.totals).flatMap(([group, values]) =>
        values.map(row => ({ group, ...row })),
      );
  if (!rows.length)
    return void process.stdout.write(`${outStyle.dim('No usage in this period.')}\n`);
  process.stdout.write(
    `${renderTable(
      [
        { header: 'by', value: row => row.group },
        { header: 'key', value: row => row.key, paint: c => outStyle.cyan(c) },
        { header: 'tasks', value: row => String(row.tasks) },
        { header: 'runner ms', value: row => String(row.runnerMs) },
        {
          header: 'tokens',
          value: row => (row.tokens === undefined ? '' : JSON.stringify(row.tokens)),
        },
      ],
      rows,
      outStyle,
    )}\n`,
  );
}

export const commandAgentUsage = command({
  name: 'agent usage',
  help: {
    usage:
      'coder agent usage [--since 7d|24h|<ms>] [--by agent|installation|engine] [--server [url]] [--json] [--cwd <dir>]',
    flags: [
      ['--since <period|ms>', 'period such as 7d or 24h, or milliseconds since epoch'],
      ['--by <group>', 'agent, installation, or engine'],
      SERVER_FLAG,
    ],
  },
  options: { ...baseOptions, ...serverOptions, since: str, by: str },
  run: async ({ options, cwd }) => {
    const { agents } = await import('../../agent');
    return agents.usage({
      ...options,
      cwd,
      organization: options.workspace,
      since: options.since ?? '7d',
    });
  },
  print: (result, { options }) => printUsage(result, options.by),
});
