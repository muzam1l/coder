/** `coder model alias`: a named spec for any model name. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { str } from '../../utils/args';
import { command } from '../../cli';
import { workspaceFlag } from './add';

export const commandModelAlias = command({
  name: 'alias',
  description: 'name a spec, e.g. fast codex/luna',
  usage:
    'Save an alias for an engine spec, e.g. fast -> codex/luna. An alias may reuse a\nbuilt-in name to override it; an engine name sets what that bare engine runs.',
  access: 'write',
  approvalPolicy: 'ask',
  args: {
    name: str('the alias'),
    spec: str('the engine spec, such as codex/luna'),
    workspace: workspaceFlag,
  },
  cli: { positional: ['name', 'spec'] },
  run: async ({ options, args: [name, spec], cwd }) => {
    const { models } = await import('../../core/models');
    return models.alias(name, spec, { ...options, cwd });
  },
  print: result => 'alias' in result && printModelAlias(result),
});

function printModelAlias(result: { alias: string; model: string; file: string }): void {
  const s = outStyle;
  process.stdout.write(
    `aliased ${s.cyan(result.alias)} -> ${result.model}  ${s.dim(`(${result.file})`)}\n`,
  );
}
