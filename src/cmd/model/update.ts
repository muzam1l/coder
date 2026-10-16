/** `coder model update`: change fields of a custom endpoint model. */
import { models } from '../../core/models';
import { command } from '../../cli';
import { modelOptions, modelSavedJson, printModelSaved, writeOptions } from './add';

export const commandModelUpdate = command({
  name: 'model update',
  help: {
    usage: 'coder model update <name> [--base-url <url>] [--model <id>] [--env-key VAR]',
    summary:
      'Update a configured custom model. Only the flags you pass change; the endpoint\nis re-probed and the wire protocol re-detected.',
    flags: [
      ['--base-url <url>', 'new API base'],
      ['--model <id>', 'new provider model id'],
      ['--env-key <VAR>', 'new API-key env var'],
      ['--workspace', 'write to <repo>/.coder/config.json instead of the user file'],
    ],
  },
  options: modelOptions,
  args: 1,
  run: ({ options, args: [name], cwd }) => models.update(name, { ...writeOptions(options), cwd }),
  json: modelSavedJson,
  print: result => printModelSaved(result, 'updated'),
});
