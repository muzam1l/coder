/** `coder model add`: a custom endpoint model, run on the codex engine pointed at its URL. */
import process from 'node:process';

import { modelAddCore, type PersistedModel } from '../../core/models';
import { outStyle } from '../../tui/output';
import { baseOptions, flag, str } from '../../utils/args';
import { command } from '../../cli';

// Flags every model subcommand takes.
export const modelOptions = {
  ...baseOptions,
  'base-url': str,
  model: str,
  'env-key': str,
  workspace: flag,
};

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
  name: 'model add',
  help: {
    usage: 'coder model add <name> --base-url <url> --model <id> [--env-key VAR]',
    summary:
      'Connect a custom model behind an OpenAI-compatible endpoint (Ollama, LM Studio,\nvLLM, OpenRouter, ...). It currently runs on the codex engine pointed at your\nURL and is usable anywhere a model is: --model <name>, --engine custom, or as an\nagent default in config. Alias: `coder model setup`.',
    flags: [
      ['--base-url <url>', 'OpenAI-compatible API base (e.g. http://localhost:11434/v1)'],
      ['--model <id>', "the provider's model id (e.g. qwen2.5-coder:32b)"],
      ['--env-key <VAR>', 'env var holding the API key (omit for keyless local endpoints)'],
      ['--workspace', 'write to <repo>/.coder/config.json instead of the user file'],
    ],
    examples: [
      [
        'coder model add qwen --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b',
        'local Ollama model, no key',
      ],
      [
        'coder model add kimi --base-url https://openrouter.ai/api/v1 --model moonshotai/kimi-k2 --env-key OPENROUTER_API_KEY',
        'third-party provider via OpenRouter',
      ],
      ['coder run --model qwen "explain this repo"', 'dispatch a task on it'],
    ],
  },
  options: modelOptions,
  args: 1,
  run: ({ options, args: [name], cwd }) => modelAddCore(cwd, name, writeOptions(options)),
  json: modelSavedJson,
  print: result => printModelSaved(result, 'saved'),
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
      : bad(install?.note ?? 'codex CLI not installed - run: npm install -g @openai/codex'),
  ];
  if (keyMissing) lines.push(bad(`env var ${entry.envKey} is not set in this shell`));
  lines.push(
    '',
    s.dim(
      [
        `Use it:       coder run --model ${name} "<task>"`,
        `Make default: coder config set engines.custom.model ${name}`,
      ].join('\n'),
    ),
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
