/** `coder model list`: built-ins, aliases and custom models, with each endpoint probed. */
import process from 'node:process';

import { modelListData } from '../../core/models';
import { formatHints, outStyle } from '../../tui/output';
import { command, MODEL_HINT } from '../../cli';
import { modelOptions } from './add';

export const commandModelList = command({
  name: 'model list',
  help: {
    usage: 'coder model list [--json]',
    summary: `List built-in aliases, configured custom models, and user aliases. Only custom\nmodels are probed.\n\n${MODEL_HINT}`,
  },
  options: modelOptions,
  run: ({ cwd }) => modelListData(cwd),
  print: printModelList,
});

function printModelList(data: Awaited<ReturnType<typeof modelListData>>): void {
  const s = outStyle;
  const suffix = (disabled?: boolean) => (disabled ? ` ${s.dim('(disabled)')}` : '');
  const lines: string[] = [];

  const providerSection = (title: string, rows: typeof data.codex) => {
    lines.push(s.bold(title));
    for (const row of rows) {
      if ('overrides' in row) {
        lines.push(
          `  ${row.disabled ? s.dim('∅') : s.cyan('↳')} ${row.alias.padEnd(14)} ${s.dim(`-> ${row.spec} (overrides ${row.overrides})`)}${suffix(row.disabled)}`,
        );
      } else if ('builtin' in row) {
        lines.push(
          `  ${row.disabled ? s.dim('∅') : s.green('✔')} ${row.alias.padEnd(14)} ${s.dim(`-> ${row.model}`)}${suffix(row.disabled)}`,
        );
      } else {
        lines.push(
          `  ${row.disabled ? s.dim('∅') : s.cyan('↳')} ${row.alias.padEnd(14)} ${s.dim(`-> ${row.spec}`)}${suffix(row.disabled)}`,
        );
      }
    }
    lines.push('');
  };
  providerSection('Codex models', data.codex);
  providerSection('Claude models', data.claude);

  lines.push(s.bold('Custom models'), '');
  if (!data.custom.length) lines.push(s.dim('  None.'));
  for (const { name, probe, ...entry } of data.custom) {
    const reach = entry.disabled ? s.dim('∅') : probe.reachable ? s.green('✔') : s.red('✘');
    lines.push(
      `  ${reach} ${name.padEnd(14)} ${entry.model} ${s.dim(`@ ${entry.baseUrl}. ${probe.detail}`)}${suffix(entry.disabled)}`,
    );
  }
  lines.push('');

  if (data.toggles) {
    lines.push(s.bold('Other'), '');
    for (const toggle of data.toggles) {
      lines.push(
        `  ${toggle.disabled ? s.dim('∅') : s.green('✔')} ${toggle.name.padEnd(14)} ${s.dim('raw model id')}${suffix(toggle.disabled)}`,
      );
    }
    lines.push('');
  }

  lines.push(
    ...MODEL_HINT.split('\n'),
    '',
    formatHints(
      [
        'Add a custom model: coder model add <name> --base-url <url> --model <id> [--env-key VAR]',
        'Alias a model, e.g. fast codex:luna: coder model alias <name> <spec>',
        'Run with a model: coder run --model <name> "<task>"',
      ],
      s,
    ),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
