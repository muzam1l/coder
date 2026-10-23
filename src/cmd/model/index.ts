/** `coder model <sub>`: every model coder can dispatch to - built-ins, aliases and custom (OpenAI-compatible) endpoints. */
import { group } from '../../cli';
import { commandModelAdd } from './add';
import { commandModelAlias } from './alias';
import { commandModelDisable } from './disable';
import { commandModelEnable } from './enable';
import { commandModelList } from './list';
import { commandModelRemove } from './remove';
import { commandModelUnalias } from './unalias';
import { commandModelUpdate } from './update';

export const commandModel = group({
  name: 'model',
  description: 'manage models: built-ins, aliases, custom endpoints',
  usage:
    'Manage the models coder can dispatch to. `add` connects any OpenAI-compatible\nendpoint (Ollama, vLLM, OpenRouter, ...) as the custom engine, alongside the\nbuilt-in codex/claude models. Name your own shortcuts with `alias`\n(e.g. fast -> codex/luna); disable/enable turns any model off and on.',
  commands: [
    commandModelList,
    commandModelAdd,
    commandModelUpdate,
    commandModelRemove,
    commandModelDisable,
    commandModelEnable,
    commandModelAlias,
    commandModelUnalias,
  ],
  aliases: { ls: 'list' },
});
