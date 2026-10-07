/** `coder flow discover`: the runnable flows. */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { DiscoveredFlow } from '../../flow/types';
import { formatHints, outStyle, renderTable } from '../../tui/output';
import { baseOptions } from '../../utils/args';
import { command } from '../../cli';

export const commandDiscover = command({
  name: 'flow discover',
  help: {
    usage: 'coder flow discover [--json]',
    summary:
      'List every flow discoverable from the current directory: workspace flows in\n.coder/flows/ (walking up to the repo root) and global flows in ~/.coder/flows/.',
  },
  options: baseOptions,
  run: async ({ cwd }) => {
    const { discoverFlows } = await import('../../flow/discover');
    return discoverFlows(cwd);
  },
  print: (flows, { cwd }) => printFlows(flows, cwd),
});

/** `flow discover`: the runnable flows, workspace paths relative to cwd and global ones under ~. */
function printFlows(flows: DiscoveredFlow[], cwd: string): void {
  if (!flows.length) {
    process.stdout.write(
      'No flows found in .coder/flows/ (workspace) or ~/.coder/flows/ (global).\n',
    );
    process.stdout.write(`\n${formatHints(['Authoring guide: coder docs flows'], outStyle)}\n`);
    return;
  }
  const s = outStyle;
  const shown = (f: DiscoveredFlow) =>
    f.scope === 'workspace'
      ? path.relative(cwd, f.path) || f.path
      : f.path.replace(os.homedir(), '~');
  process.stdout.write(
    renderTable(
      [
        { header: 'name', value: f => f.name, paint: c => s.cyan(c) },
        { header: 'scope', value: f => f.scope, paint: c => s.light(c) },
        { header: 'path', value: shown, paint: c => s.light(c) },
      ],
      flows,
      s,
    ),
  );
  process.stdout.write(
    `\n${formatHints(['Run one: coder flow run <name>', 'Recent runs: coder flow list'], s)}\n`,
  );
}
