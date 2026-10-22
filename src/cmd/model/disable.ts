/** `coder model disable`: turn off any model name. */
import { str } from '../../utils/args';
import { command } from '../../cli';
import { workspaceFlag } from './add';
import { printModelChange } from './remove';

// Any name is a valid target - a built-in, a configured entry, or a raw engine slug.
export const toggle = (disable: boolean, description: string, usage?: string) =>
  command({
    name: disable ? 'disable' : 'enable',
    description,
    usage,
    access: 'write',
    approvalPolicy: 'ask',
    args: { name: str('a built-in, custom model, or alias'), workspace: workspaceFlag },
    cli: { positional: ['name'] },
    run: async ({ options, args: [name], cwd }) => {
      const { models } = await import('../../core/models');
      return models[disable ? 'disable' : 'enable'](name, { ...options, cwd });
    },
    json: result =>
      'file' in result
        ? { [disable ? 'disabled' : 'enabled']: result.name, file: result.file }
        : result,
    print: result =>
      'file' in result &&
      printModelChange(disable ? 'disabled' : 'enabled', result.name, result.file),
  });

export const commandModelDisable = toggle(
  true,
  'turn off a model (built-in, custom, or alias)',
  'Disable a model - built-in, custom, or alias. Requests for it fail until re-enabled.',
);
