/** `coder connection list`. */
import process from 'node:process';

import type { connection } from '../../core/connection';
import { formatHints, outStyle, renderTable } from '../../tui/output';
import { baseOptions } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { describe, serverOptions } from './add';

type Listed = Awaited<ReturnType<typeof connection.list>>;

function printConnections({ connections, declared }: Listed): void {
  const s = outStyle;
  process.stdout.write(
    connections.length
      ? renderTable(
          [
            { header: 'name', value: row => row.id, paint: c => s.cyan(c) },
            { header: 'connects', value: row => describe(row), paint: c => s.light(c) },
            { header: 'access', value: row => (row.access === 'observe' ? 'read' : 'write') },
            {
              header: 'for',
              value: row => (row.mine ? 'you' : row.owner ? row.owner : 'workspace'),
            },
            { header: 'status', value: row => row.status },
          ],
          connections,
          s,
        )
      : `${s.dim('No connections.')}\n`,
  );
  if (declared.length)
    process.stdout.write(
      `\n${s.bold('Declared in this repository')}\n${renderTable(
        [
          { header: 'name', value: row => row.name, paint: c => s.cyan(c) },
          { header: 'in', value: row => row.source },
          { header: 'runs', value: row => row.target, paint: c => s.light(c) },
          { header: 'here', value: row => (row.approved ? 'approved' : 'needs approval') },
        ],
        declared,
        s,
      )}`,
    );
  const pending = declared.filter(row => !row.approved);
  const hints = [
    ...pending.map(row => `Approve: coder connection approve ${row.name}`),
    ...(connections.length ? [] : ['Add one: coder connection add <name> --env <NAME>']),
  ];
  if (hints.length) process.stdout.write(`\n${formatHints(hints, s)}\n`);
}

export const commandConnectionList = command({
  name: 'connection list',
  help: {
    usage: 'coder connection list [--server [url]] [--json] [--cwd <dir>]',
    summary:
      'Your connections, and the MCP servers this repository and its agents declare with whether each is approved on this machine.',
    flags: [SERVER_FLAG],
  },
  options: { ...baseOptions, ...serverOptions },
  run: async ({ options, cwd }) => {
    const { connection } = await import('../../core/connection');
    return connection.list({ ...options, cwd });
  },
  print: printConnections,
});
