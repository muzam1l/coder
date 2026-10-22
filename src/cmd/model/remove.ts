/** `coder model remove`: drop a custom endpoint model. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { str } from '../../utils/args';
import { command } from '../../cli';
import { workspaceFlag } from './add';

export const commandModelRemove = command({
  name: 'remove',
  description: 'delete a custom model',
  usage: 'Remove a configured custom model.',
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/settings/models',
      label: 'Remove the model',
      action: 'delete',
      args: ['name'],
      button: 'Remove',
    },
  },
  args: { name: str('the custom model'), workspace: workspaceFlag },
  cli: { positional: ['name'] },
  run: async ({ options, args: [name], cwd }) => {
    const { models } = await import('../../core/models');
    return models.remove(name, { ...options, cwd });
  },
  print: result => printModelChange('removed', result.removed, result.file),
});

/** One `model <verb>` line: the name and the file it changed. */
export function printModelChange(verb: string, name: string, file: string): void {
  process.stdout.write(`${verb} ${outStyle.cyan(name)}  ${outStyle.dim(`(${file})`)}\n`);
}
