/** `coder model alias`: a named spec for any model name. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { str } from '../../utils/args';
import { command } from '../../cli';
import { workspaceFlag } from './add';

export const commandModelAlias = command({
  name: 'alias',
  description: 'name a spec, e.g. fast codex:luna',
  usage:
    'Save an alias for an engine spec, e.g. fast -> codex:luna. An alias may reuse a\nbuilt-in name to override it.',
  access: 'write',
  args: {
    name: str('the alias'),
    spec: str('the engine spec, such as codex:luna'),
    workspace: workspaceFlag,
  },
  cli: { positional: ['name', 'spec'] },
  run: async ({ options, args: [name, spec], cwd }) => {
    const { models } = await import('../../core/models');
    return models.alias(name, spec, { ...options, cwd });
  },
  print: printModelAlias,
});

function printModelAlias(result: {
  alias: string;
  provider: string;
  model: string;
  effort?: string;
  file: string;
}): void {
  const s = outStyle;
  const desc = `${result.provider} ${result.model}${result.effort ? ` (${result.effort})` : ''}`;
  process.stdout.write(
    `aliased ${s.cyan(result.alias)} -> ${result.provider}:${result.model}${result.effort ? `:${result.effort}` : ''} ${s.dim(`= ${desc}`)}  ${s.dim(`(${result.file})`)}\n`,
  );
}
