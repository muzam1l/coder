/** `coder agent integrations list`: the integration catalog. */
import process from 'node:process';

import type { agents } from '../../../agent';
import { outStyle, renderTable } from '../../../tui/output';
import { command, nextSteps } from '../../../cli';

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
}

export const commandIntegrationsList = command({
  name: 'list',
  description: 'list integrations with their events and tools',
  usage:
    'One row per integration: its id, the events an agent can wire, and every tool it offers; `show` splits the tools by preset.',
  access: 'read',
  globalFlags: { cwd: false },
  run: async () => {
    const { agents } = await import('../../../agent');
    return agents.integrations.list();
  },
  next: () =>
    nextSteps([
      'Event descriptions and the tools each preset allows: coder agent integrations show <id>',
    ]),
  print: printIntegrations,
});
