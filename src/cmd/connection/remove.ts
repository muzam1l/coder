/** `coder connection rm <name>`. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, serverOptions } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

export const commandConnectionRemove = command({
  name: 'connection remove',
  helpName: 'connection rm',
  help: {
    usage: 'coder connection rm <name> [--server [url]] [--json]',
    summary: 'Remove a connection. The credential an API key connection reads stays.',
    flags: [SERVER_FLAG],
  },
  options: { ...baseOptions, ...serverOptions },
  args: 1,
  run: async ({ options, args: [name], cwd }) => {
    const { connection } = await import('../../core/connection');
    return connection.remove(name, { ...options, cwd });
  },
  print: row => process.stdout.write(`Removed ${outStyle.bold(row.id)}.\n`),
});
