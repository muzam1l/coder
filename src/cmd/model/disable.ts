/** `coder model disable`: turn off any model name. */
import type { CommandHelpSpec } from '../../core/types';
import { modelToggleCore } from '../../core/models';
import { command } from '../../cli';
import { modelOptions } from './add';
import { printModelChange } from './remove';

// Any name is a valid target - a built-in, a configured entry, or a raw engine slug.
export const toggle = (disable: boolean, help: CommandHelpSpec) =>
  command({
    name: `model ${disable ? 'disable' : 'enable'}`,
    help,
    options: modelOptions,
    args: 1,
    run: ({ options, args: [name], cwd }) => modelToggleCore(cwd, name, disable, options),
    json: ({ name, file }) => ({ [disable ? 'disabled' : 'enabled']: name, file }),
    print: ({ name, file }) => printModelChange(disable ? 'disabled' : 'enabled', name, file),
  });

export const commandModelDisable = toggle(true, {
  usage: 'coder model disable <name> [--workspace]',
  summary: 'Disable a model - built-in, custom, or alias. Requests for it fail until re-enabled.',
  flags: [['--workspace', 'target <repo>/.coder/config.json instead of the user file']],
});
