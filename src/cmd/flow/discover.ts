/** `coder flow discover`: the runnable flows. */
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import type { DiscoveredFlow } from '../../flow/types';
import { outStyle, renderTable } from '../../tui/output';
import { command, nextSteps } from '../../cli';

export const commandDiscover = command({
  name: 'discover',
  description: 'list flows runnable here (workspace + global)',
  usage:
    'List every flow discoverable from the current directory: workspace flows in\n.coder/flows/ (walking up to the repo root) and global flows in ~/.coder/flows/.',
  access: 'read',
  run: async ({ cwd }) => {
    const { discoverFlows } = await import('../../flow/discover');
    return discoverFlows(cwd);
  },
  next: ({ result }) =>
    nextSteps(
      result.length
        ? ['Run one: coder flow run <name>', 'Recent runs: coder flow list']
        : ['Authoring guide: coder docs flows'],
    ),
  print: (flows, { cwd }) => printFlows(flows, cwd),
});

/** `flow discover`: the runnable flows, workspace paths relative to cwd and global ones under ~. */
function printFlows(flows: DiscoveredFlow[], cwd: string): void {
  if (!flows.length) {
    process.stdout.write(
      'No flows found in .coder/flows/ (workspace) or ~/.coder/flows/ (global).\n',
    );
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
}
