/** `coder model update`: change fields of a custom endpoint model. */
import { flag, str } from '../../utils/args';
import { command } from '../../cli';
import {
  contextWindowOption,
  modelSavedJson,
  modelSavedNext,
  printModelSaved,
  writeOptions,
} from './add';

export const commandModelUpdate = command({
  name: 'update',
  description: 'change a model in place',
  usage:
    'Update a configured custom model. Only the flags you pass change; the endpoint\nis re-probed and the wire protocol re-detected.',
  access: 'write',
  args: {
    name: str('the custom model'),
    'base-url': str('new API base', '<url>'),
    model: str('new provider model id', '<id>'),
    'env-key': str('new API-key env var', '<VAR>'),
    'context-window': contextWindowOption,
    workspace: flag('write to <repo>/.coder/config.json instead of the user file'),
  },
  cli: { positional: ['name'] },
  run: async ({ options, args: [name], cwd }) => {
    const { models } = await import('../../core/models');
    return models.update(name, { ...writeOptions(options), cwd });
  },
  json: modelSavedJson,
  next: ({ result }) => modelSavedNext(result),
  print: (result, { next }) =>
    printModelSaved(result, 'updated', () => next(result, { slot: 'codex' })),
});
