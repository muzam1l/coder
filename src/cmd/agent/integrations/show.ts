/** `coder agent integrations show <id>`: one integration's events and tool presets. */
import process from 'node:process';

import type { agents } from '../../../agent';
import { outStyle, renderTable } from '../../../tui/output';
import { str } from '../../../utils/args';
import { command } from '../../../cli';

type CatalogRow = { kind: string; name: string; does: string };

function printIntegration(detail: ReturnType<typeof agents.integrations.show>): void {
  const s = outStyle;
  const rows: CatalogRow[] = [
    ...Object.entries(detail.events).map(([name, does]) => ({ kind: 'event', name, does })),
    ...Object.entries(detail.tools).map(([name]) => ({
      kind: 'tools',
      name: name === 'read-only' ? 'Read-only' : 'Auto',
      does: name === 'read-only' ? 'Platform tools marked read-only' : 'All platform tools',
    })),
  ];
  process.stdout.write(
    renderTable<CatalogRow>(
      [
        { header: 'kind', value: r => r.kind, paint: c => s.light(c) },
        { header: 'name', value: r => r.name },
        { header: 'does', value: r => r.does },
      ],
      rows,
      s,
    ),
  );
}

export const commandIntegrationsShow = command({
  name: 'show',
  description: 'events and tools of one integration',
  usage:
    'Describe one integration: each event with what triggers it, and the tools each access (read-only, auto) allows.',
  access: 'read',
  args: { id: str('the integration') },
  globalFlags: { cwd: false },
  cli: {
    positional: ['id'],
    examples: ['coder agent integrations show github  # the GitHub integration in full'],
  },
  run: async ({ args: [id] }) => {
    const { agents } = await import('../../../agent');
    return agents.integrations.show(id);
  },
  print: printIntegration,
});
