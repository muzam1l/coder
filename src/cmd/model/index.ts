/** `coder model <sub>`: every model coder can dispatch to - built-ins, aliases and custom (OpenAI-compatible) endpoints. */
import { group } from '../../cli';

const MODEL_MENU: { usage: string; blurb: string }[] = [
  { usage: 'list', blurb: 'list built-ins, custom models, and aliases' },
  {
    usage: 'add <name> --base-url <url> --model <id> [--env-key VAR]',
    blurb: 'connect a model (alias: setup)',
  },
  {
    usage: 'update <name> [--base-url|--model|--env-key]',
    blurb: 'change a model in place',
  },
  { usage: 'remove <name>', blurb: 'delete a custom model' },
  {
    usage: 'disable <name>',
    blurb: 'turn off a model (built-in, custom, or alias)',
  },
  { usage: 'enable <name>', blurb: 're-enable a disabled model' },
  { usage: 'alias <name> <spec>', blurb: 'name a spec, e.g. fast codex:luna' },
  { usage: 'unalias <name>', blurb: 'remove an alias' },
];

export const commandModel = group(
  'model',
  {
    list: async () => (await import('./list')).commandModelList,
    ls: async () => (await import('./list')).commandModelList,
    add: async () => (await import('./add')).commandModelAdd,
    setup: async () => (await import('./add')).commandModelAdd, // alias
    update: async () => (await import('./update')).commandModelUpdate,
    remove: async () => (await import('./remove')).commandModelRemove,
    disable: async () => (await import('./disable')).commandModelDisable,
    enable: async () => (await import('./enable')).commandModelEnable,
    alias: async () => (await import('./alias')).commandModelAlias,
    unalias: async () => (await import('./unalias')).commandModelUnalias,
  },
  {
    menu: MODEL_MENU,
    description: [
      'Manage the models coder can dispatch to. `add` connects any OpenAI-compatible',
      'endpoint (Ollama, vLLM, OpenRouter, ...) as the custom engine, alongside the',
      'built-in codex/claude models. Name your own shortcuts with `alias`',
      '(e.g. fast -> codex:luna); disable/enable turns any model off and on.',
    ],
  },
);
