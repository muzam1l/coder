/** `coder model alias`: a named spec for any model name. */
import process from 'node:process';

import { modelAliasCore } from '../../core/models';
import { outStyle } from '../../tui/output';
import { command } from '../../cli';
import { modelOptions } from './add';

export const commandModelAlias = command({
  name: 'model alias',
  help: {
    usage: 'coder model alias <name> <spec> [--workspace]',
    summary:
      'Save an alias for an engine spec, e.g. fast -> codex:luna. An alias may reuse a\nbuilt-in name to override it.',
    flags: [['--workspace', 'target <repo>/.coder/config.json instead of the user file']],
  },
  options: modelOptions,
  args: 2,
  run: ({ options, args: [name, spec], cwd }) => modelAliasCore(cwd, name, spec, options),
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
