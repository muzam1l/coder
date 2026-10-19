/** `coder connection list`. */
import process from 'node:process';

import type { connection } from '../../core/connection';
import { outStyle, renderTable } from '../../tui/output';
import { serverOptions } from '../../utils/args';
import { command, nextSteps } from '../../cli';
import { describe } from './add';

type Listed = Awaited<ReturnType<typeof connection.list>>;

function printConnections({ connections, declared }: Listed): void {
  const s = outStyle;
  process.stdout.write(
    connections.length
      ? renderTable(
          [
            { header: 'name', value: row => row.id, paint: c => s.cyan(c) },
            { header: 'connects', value: row => describe(row), paint: c => s.light(c) },
            {
              header: 'access',
              value: row =>
                row.access === 'read' ? 'Read-only' : row.access ? 'Read-write' : 'Default',
            },
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
}

export const commandConnectionList = command({
  name: 'list',
  description: 'list connections and the MCP servers this repository declares',
  usage:
    'Your connections, and the MCP servers this repository and its agents declare with whether each is approved on this machine.',
  access: 'read',
  args: serverOptions,
  run: async ({ options, cwd }) => {
    const { connection } = await import('../../core/connection');
    return connection.list({ ...options, cwd });
  },
  next: ({ result: { connections, declared } }) =>
    nextSteps([
      ...declared
        .filter(row => !row.approved)
        .map(row => `Approve: coder connection approve ${row.name}`),
      ...(connections.length ? [] : ['Add one: coder connection add <name> --env <NAME>']),
    ]),
  print: printConnections,
});
