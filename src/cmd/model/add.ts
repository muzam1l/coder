/** `coder model add`: a custom endpoint model, run on the codex engine pointed at its URL. */
import process from 'node:process';

import type { PersistedModel } from '../../core/models';
import { outStyle } from '../../tui/output';
import { flag, str } from '../../utils/args';
import { command, nextSteps, type CommandNext } from '../../cli';

/** `--workspace` on the model commands that write config. */
export const workspaceFlag = flag('target <repo>/.coder/config.json instead of the user file');

export const writeOptions = (options: {
  'base-url'?: string;
  model?: string;
  'env-key'?: string;
  workspace?: boolean;
}) => ({
  baseUrl: options['base-url'],
  model: options.model,
  envKey: options['env-key'],
  workspace: options.workspace,
});

export const commandModelAdd = command({
  name: 'add',
  description: 'connect a model',
  usage:
    'Connect a custom model behind an OpenAI-compatible endpoint (Ollama, LM Studio,\nvLLM, OpenRouter, ...). It currently runs on the codex engine pointed at your\nURL and is usable anywhere a model is: --model <name>, --engine custom, or as an\nagent default in config. Alias: `coder model setup`.',
  access: 'write',
  args: {
    name: str('the name to dispatch it by'),
    'base-url': str('OpenAI-compatible API base (e.g. http://localhost:11434/v1)', '<url>'),
    model: str("the provider's model id (e.g. qwen2.5-coder:32b)", '<id>'),
    'env-key': str('env var holding the API key (omit for keyless local endpoints)', '<VAR>'),
    workspace: flag('write to <repo>/.coder/config.json instead of the user file'),
  },
  cli: {
    positional: ['name'],
    examples: [
      'coder model add qwen --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b  # local Ollama model, no key',
      'coder model add kimi --base-url https://openrouter.ai/api/v1 --model moonshotai/kimi-k2 --env-key OPENROUTER_API_KEY  # third-party provider via OpenRouter',
      'coder run --model qwen "explain this repo"  # dispatch a task on it',
    ],
  },
  run: async ({ options, args: [name], cwd }) => {
    const { models } = await import('../../core/models');
    return models.add(name, { ...writeOptions(options), cwd });
  },
  json: modelSavedJson,
  next: ({ result }) => modelSavedNext(result),
  print: (result, { next }) =>
    printModelSaved(result, 'saved', () => next(result, { slot: 'codex' })),
});

/** What `model add|update --json` prints. */
export function modelSavedJson({
  name,
  entry,
  file,
  probe,
  codex,
  install,
  ready,
}: PersistedModel) {
  return {
    name,
    ...entry,
    file,
    probe,
    codex,
    ...(install ? { codexInstall: install } : {}),
    ready,
  };
}

export function printModelSaved(
  { name, entry, file, probe, codex, install, nativeResponses, keyMissing }: PersistedModel,
  verb: 'saved' | 'updated',
  next: () => void,
): void {
  const s = outStyle;
  const good = (text: string) => `  ${s.green('✔')} ${text}`;
  const bad = (text: string) => `  ${s.red('✘')} ${text}`;
  const lines = [
    `${verb} ${s.cyan(name)} -> ${entry.model} @ ${entry.baseUrl}  ${s.dim(`(${file})`)}`,
    '',
    probe.reachable
      ? good(
          `${probe.detail} ${s.dim(`(${nativeResponses ? 'responses api, direct' : 'chat api, auto-translated'})`)}`,
        )
      : bad(probe.detail),
    codex.available
      ? good(
          install?.installed
            ? `${install.note} ${s.dim(`(${codex.detail})`)}`
            : `codex engine ${s.dim(`(${codex.detail})`)}`,
        )
      : install?.note
        ? bad(install.note)
        : null,
  ];
  if (lines.at(-1) === null) {
    lines.pop();
    process.stdout.write(`${lines.join('\n')}\n`);
    lines.length = 0;
    next();
  }
  if (keyMissing) lines.push(bad(`env var ${entry.envKey} is not set in this shell`));
  if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
}

export function modelSavedNext({ name, codex, install }: PersistedModel) {
  const steps: CommandNext[] =
    !codex.available && !install?.note
      ? [
          {
            usage: 'npm install -g @openai/codex',
            blurb: 'codex CLI not installed',
            cli: {
              text: `  ${outStyle.red('✘')} codex CLI not installed - run: npm install -g @openai/codex`,
              layout: 'plain',
              prefix: '',
              slot: 'codex',
            },
          },
        ]
      : [];
  return [
    ...steps,
    ...nextSteps(
      [
        `Use it:       coder run --model ${name} "<task>"`,
        `Make default: coder config set engines.custom.model ${name}`,
      ],
      { layout: 'plain', dim: true },
    ),
  ];
}
