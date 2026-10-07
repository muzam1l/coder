/** `coder model remove`: drop a custom endpoint model. */
import process from 'node:process';

import { modelRemoveCore } from '../../core/models';
import { outStyle } from '../../tui/output';
import { command } from '../../cli';
import { modelOptions } from './add';

export const commandModelRemove = command({
  name: 'model remove',
  help: {
    usage: 'coder model remove <name>',
    summary: 'Remove a configured custom model.',
    flags: [['--workspace', 'target <repo>/.coder/config.json instead of the user file']],
  },
  options: modelOptions,
  args: 1,
  run: ({ options, args: [name], cwd }) => modelRemoveCore(cwd, name, options),
  print: result => printModelChange('removed', result.removed, result.file),
});

/** One `model <verb>` line: the name and the file it changed. */
export function printModelChange(verb: string, name: string, file: string): void {
  process.stdout.write(`${verb} ${outStyle.cyan(name)}  ${outStyle.dim(`(${file})`)}\n`);
}
