/** `coder runner list`: the runners a server knows. */
import process from 'node:process';

import type { RunnerRow } from '../../client/types';
import { outStyle, renderTable } from '../../tui/output';
import { command, CREDENTIAL_SERVER_FLAG } from '../../cli';
import { runnerOptions } from './remove';

function printRunners({ items: rows }: { items: RunnerRow[] }): void {
  if (!rows.length) return void process.stdout.write(`${outStyle.dim('No runners.')}\n`);
  process.stdout.write(
    `${renderTable(
      [
        { header: 'id', value: (row: RunnerRow) => row.id, paint: c => outStyle.cyan(c) },
        { header: 'name', value: (row: RunnerRow) => row.name },
        { header: 'scope', value: (row: RunnerRow) => row.scope },
        { header: 'status', value: (row: RunnerRow) => (row.online ? 'online' : 'offline') },
        { header: 'kind', value: (row: RunnerRow) => row.kind },
        { header: 'default', value: (row: RunnerRow) => (row.default ? 'yes' : '') },
      ],
      rows,
      outStyle,
    )}\n`,
  );
}

export const commandRunnerList = command({
  name: 'runner list',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder runner list [--server [url]] [--json]',
    flags: [CREDENTIAL_SERVER_FLAG],
  },
  options: runnerOptions,
  run: async ({ options }) => {
    const { listRunners } = await import('../../runner');
    return listRunners(options);
  },
  print: printRunners,
});
