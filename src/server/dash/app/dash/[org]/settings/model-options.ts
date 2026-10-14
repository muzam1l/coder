import type { ModelsShape } from '@coder/client/types';

export const NO_MODELS: ModelsShape = { builtin: {}, models: {} };

export const ENGINES = ['claude', 'codex', 'custom'];
export const ENGINE_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  custom: 'Custom',
};

/** Each engine's usable model names: built-ins, then aliases and endpoints; turned-off ones left out. */
export function modelsByEngine(shape: ModelsShape): Record<string, string[]> {
  const own = Object.entries(shape.models).filter(([, entry]) => !entry.disabled);
  return Object.fromEntries(
    ENGINES.map(engine => [
      engine,
      [
        ...Object.keys(shape.builtin[engine] ?? {}).filter(name => !shape.models[name]?.disabled),
        ...own
          .filter(([, entry]) => (engine === 'custom' ? entry.baseUrl : entry.provider === engine))
          .map(([name]) => name),
      ],
    ]),
  );
}

/** An unset setting's label, naming what it resolves to; the engine picks when nothing sets it. */
export const defaultLabel = (value?: string) => `Default (${value || "engine's own"})`;

/** One picker for engine and model: `engine:model`, or `engine:` for an engine's own default. */
export function modelOptions(
  byEngine: Record<string, string[]>,
  blank: string,
): Array<[string, string]> {
  return [
    ['', blank],
    ...ENGINES.filter(engine => byEngine[engine]?.length).flatMap(
      (engine): Array<[string, string]> => [
        [`${engine}:`, 'Its default model'],
        ...byEngine[engine]!.map((model): [string, string] => [`${engine}:${model}`, model]),
      ],
    ),
  ];
}

export const modelValue = (engine?: string, model?: string) =>
  engine || model ? `${engine ?? ''}:${model ?? ''}` : '';

export function splitModel(value: string): { engine: string; model: string } {
  const at = value.indexOf(':');
  return at < 0
    ? { engine: '', model: '' }
    : { engine: value.slice(0, at), model: value.slice(at + 1) };
}

/** Section titles for `modelOptions`: each engine's name above its first option. */
export const modelHeadings = (byEngine: Record<string, string[]>): Record<string, string> =>
  Object.fromEntries(
    ENGINES.filter(engine => byEngine[engine]?.length).map(engine => [
      `${engine}:`,
      ENGINE_NAMES[engine]!,
    ]),
  );

export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  envKey: string;
  keyUrl?: string;
  needsKey: boolean;
}

/** OpenAI-compatible providers the custom endpoint form prefills. */
export const CUSTOM_PROVIDERS: CustomProvider[] = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    envKey: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    needsKey: true,
  },
  {
    id: 'vercel',
    name: 'Vercel AI Gateway',
    baseUrl: 'https://ai-gateway.vercel.sh/v1',
    envKey: 'AI_GATEWAY_API_KEY',
    keyUrl: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys',
    needsKey: true,
  },
  {
    id: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    envKey: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    needsKey: true,
  },
  {
    id: 'together',
    name: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    envKey: 'TOGETHER_API_KEY',
    keyUrl: 'https://api.together.ai/settings/api-keys',
    needsKey: true,
  },
  {
    id: 'ollama',
    name: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    envKey: '',
    needsKey: false,
  },
  { id: 'other', name: 'Other', baseUrl: '', envKey: '', needsKey: true },
];
