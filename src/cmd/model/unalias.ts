/** `coder model unalias`: drop a named spec. */
import { modelUnaliasCore } from '../../core/models';
import { command } from '../../cli';
import { modelOptions } from './add';
import { printModelChange } from './remove';

export const commandModelUnalias = command({
  name: 'model unalias',
  help: {
    usage: 'coder model unalias <name> [--workspace]',
    summary: 'Remove a user-defined alias.',
    flags: [['--workspace', 'target <repo>/.coder/config.json instead of the user file']],
  },
  options: modelOptions,
  args: 1,
  run: ({ options, args: [name], cwd }) => modelUnaliasCore(cwd, name, options),
  print: result => printModelChange('unaliased', result.unaliased, result.file),
});
