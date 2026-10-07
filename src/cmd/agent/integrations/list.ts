/** `coder agent integrations list`: the integration catalog. */
import process from 'node:process';

import type { agents } from '../../../agent';
import { formatHints, outStyle, renderTable } from '../../../tui/output';
import { flag } from '../../../utils/args';
import { command } from '../../../cli';

function printIntegrations(rows: ReturnType<typeof agents.integrations.list>): void {
  const s = outStyle;
  process.stdout.write(
    renderTable(
      [
        { header: 'id', value: r => r.id, paint: c => s.cyan(c) },
        { header: 'description', value: r => r.description },
        { header: 'events', value: r => r.events.join(', ') },
        { header: 'tools', value: r => r.tools.join(', ') },
      ],
      rows,
      { style: s, border: true },
    ),
  );
  process.stdout.write(
    `\n${formatHints(['Event descriptions and the tools each preset allows: coder agent integrations show <id>'], s)}\n`,
  );
}

export const commandIntegrationsList = command({
  name: 'agent integrations list',
  globalFlags: { cwd: false },
  help: {
    usage: 'coder agent integrations list [--json]',
    summary:
      'One row per integration: its id, the events an agent can wire, and every tool it offers; `show` splits the tools by preset.',
  },
  options: { json: flag },
  run: async () => {
    const { agents } = await import('../../../agent');
    return agents.integrations.list();
  },
  print: printIntegrations,
});
