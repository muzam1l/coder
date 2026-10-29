import type { AgentRow, ModelsShape } from '@coder/client/types';

export const NO_MODELS: ModelsShape = { builtin: {}, models: {} };

export const ENGINES = ['claude', 'codex', 'custom'];
export const EFFORTS: Array<[string, string]> = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
export const ACCESS: Array<[string, string]> = [
  ['auto', 'Auto'],
  ['read-only', 'Read-only'],
];
export const SCOPES: Array<[string, string]> = [
  ['personal', 'Personal'],
  ['workspace', 'Workspace'],
];
export const ENGINE_NAMES: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  custom: 'Custom',
};

/** The engine a model name runs on: its alias's, an endpoint's custom, else Codex. */
export function engineOf(shape: ModelsShape, name: string): string {
  const entry = name in shape.models ? shape.models[name] : shape.builtin[name];
  if (entry && typeof entry === 'object') return 'custom';
  const first = typeof entry === 'string' ? entry.split('/')[0]! : '';
  if (ENGINES.includes(first)) return first;
  const target = first !== name ? shape.builtin[first] : undefined;

  return target ? target.split('/')[0]! : 'codex';
}

/** Each engine's usable model names: built-ins, then aliases and endpoints; turned-off ones left out. */
export function modelsByEngine(shape: ModelsShape): Record<string, string[]> {
  const names = [...new Set([...Object.keys(shape.builtin), ...Object.keys(shape.models)])].filter(
    name => shape.models[name] !== false,
  );
  return Object.fromEntries(
    ENGINES.map(engine => [engine, names.filter(name => engineOf(shape, name) === engine)]),
  );
}

/** Every usable model name, engine by engine, for a model picker. */
export const modelNames = (shape: ModelsShape) =>
  ENGINES.flatMap(engine => modelsByEngine(shape)[engine] ?? []);

/** A spec as people read it: its model's name, such as `sol` for `codex/sol` or `codex`, without its effort. */
export function specName(spec: string, builtin: ModelsShape['builtin']): string {
  const [first = '', second] = spec.split('/');
  const model = second && !EFFORTS.some(([effort]) => effort === second) ? second : undefined;
  if (ENGINES.includes(first) && model)
    return (
      Object.keys(builtin).find(
        name => !ENGINES.includes(name) && builtin[name] === `${first}/${model}`,
      ) ?? model
    );
  const target = ENGINES.includes(first) ? builtin[first] : undefined;

  return target ? specName(target, builtin) : first;
}

/** An unset setting's label, naming what it resolves to; the engine picks when nothing sets it. */
export const defaultLabel = (value?: string) => `Default (${value || "engine's own"})`;

/** The agent picks its own model, here or in agent.json, ahead of the default chain. */
export const ownModel = (agent: AgentRow) =>
  !!(agent.settings?.engine || agent.settings?.model || agent.definition?.model);

/** An agent's own model and where it is set: here or in its agent.json. */
export const modelSource = (agent: AgentRow) =>
  `${agent.model ?? agent.settings?.model ?? agent.definition?.model ?? 'Default'}, ${
    agent.settings?.engine || agent.settings?.model ? 'set here' : 'from agent.json'
  }`;

const isEffort = (part: string) => EFFORTS.some(([effort]) => effort === part);

/** A spec as the pickers show it: its model's name and its effort, such as sol and low for `codex/sol/low`. */
export function splitSpec(spec: string, shape: ModelsShape): { model: string; effort: string } {
  const parts = spec.split('/').filter(Boolean);
  const effort = parts.length > 1 && isEffort(parts.at(-1)!) ? parts.pop()! : '';
  const model = parts.join('/');
  const named = model in shape.builtin || model in shape.models || !model.includes('/');

  return { model: named ? model : specName(model, shape.builtin), effort };
}

/** A model and effort as one spec; the model's own effort is left out. */
export const joinSpec = (model: string, effort: string, shape: ModelsShape) =>
  model && effort && effort !== ownEffort(model, shape) ? `${model}/${effort}` : model;

/** The effort a name runs at with none given: its alias's, else medium. */
export function ownEffort(name: string, shape: ModelsShape): string {
  const entry = shape.models[name] ?? shape.builtin[name];
  const last = typeof entry === 'string' ? entry.split('/').at(-1)! : '';

  return isEffort(last) ? last : 'medium';
}

/** The no-model choice, which runs the workspace chain; the default chain link shows its models. */
export const chainChoice = () => ({ label: 'Default chain' });

/** A model picker's options: Codex, Claude and custom names under their headings, each with what it runs. */
export function modelChoices(shape: ModelsShape, keep = '') {
  const byEngine = modelsByEngine(shape);
  const options: Array<[string, string]> = [];
  const headings: Record<string, string> = {};
  const subs: Record<string, string> = {};
  for (const engine of ['codex', 'claude', 'custom']) {
    const names = byEngine[engine] ?? [];
    if (names[0]) headings[names[0]] = ENGINE_NAMES[engine]!;
    for (const name of names) {
      const entry = shape.models[name] ?? shape.builtin[name];
      options.push([name, name]);
      subs[name] = typeof entry === 'object' && entry ? entry.model : String(entry ?? '');
    }
  }
  // A spec no name matches, such as a full model id, stays pickable.
  if (keep && !options.some(([name]) => name === keep)) options.unshift([keep, keep]);

  return { options, headings, subs };
}

interface CustomProvider {
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
    keyUrl:
      'https://vercel.com/d?to=%2F%5Bteam%5D%2F~%2Fai-gateway%2Fapi-keys&title=AI+Gateway+API+Keys',
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
