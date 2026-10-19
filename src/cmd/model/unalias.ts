/** `coder model unalias`: drop a named spec. */
import { str } from '../../utils/args';
import { command } from '../../cli';
import { workspaceFlag } from './add';
import { printModelChange } from './remove';

export const commandModelUnalias = command({
  name: 'unalias',
  description: 'remove an alias',
  usage: 'Remove a user-defined alias.',
  access: 'write',
  args: { name: str('the alias'), workspace: workspaceFlag },
  cli: { positional: ['name'] },
  run: async ({ options, args: [name], cwd }) => {
    const { models } = await import('../../core/models');
    return models.unalias(name, { ...options, cwd });
  },
  print: result => printModelChange('unaliased', result.unaliased, result.file),
});
