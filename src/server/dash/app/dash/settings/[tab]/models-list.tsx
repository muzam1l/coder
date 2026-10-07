'use client';

import { client } from '@/utils/client';
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { Card, Loading } from '@/comps/ui/card';
import { ErrorText, Field } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { MenuItem } from '@/comps/ui/menu';
import { Select } from '@/comps/ui/select';
import { Combo } from '@/comps/ui/combo';
import {
  CUSTOM_PROVIDERS,
  ENGINES,
  ENGINE_NAMES,
  defaultLabel,
  type CustomProvider,
} from '@/app/dash/settings/model-options';
import { reasonText } from '@/utils/format';
import { List, Row, useConfig, useSend } from './list';
import type {
  Config,
  ConfigShape,
  CredentialRow,
  ModelEntry,
  ModelsShape,
  ProbeResult,
} from '@coder/client/types';

const PROVIDERS: Array<[string, string]> = [
  ['custom', 'Custom endpoint'],
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
/** The built-in model each engine's id field shows as its example. */
const EXAMPLES: Record<string, string> = { claude: 'sonnet', codex: 'sol' };
const EFFORTS: Array<[string, string]> = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
const SCOPES: Array<[string, string]> = [
  ['personal', 'Just me'],
  ['workspace', 'Workspace'],
];
const providers = CUSTOM_PROVIDERS;
const OTHER: CustomProvider = {
  id: 'other',
  name: 'Other',
  baseUrl: '',
  envKey: '',
  needsKey: true,
};

/** A model name from an id: its last path part, lowercase kebab, like `kimi-k2` from `moonshotai/kimi-k2`. */
const slug = (id: string) =>
  id
    .split('/')
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** The first example name no model has, for a placeholder. */
const unused = (names: string[], taken: Record<string, unknown>) =>
  names.find(name => !(name in taken));

/** A short name for a Claude or Codex model id, or a custom OpenAI-compatible endpoint. Enter adds. */
function AddModel({
  builtin,
  credentials,
  admin,
  taken,
  efforts,
  error,
  onAdd,
}: {
  builtin: ModelsShape['builtin'];
  credentials: CredentialRow[] | null;
  admin: boolean;
  /** Each engine's default effort, which an alias without one runs at. */
  efforts: Record<string, string | undefined>;
  /** Every model name in use. */
  taken: Record<string, unknown>;
  error: string;
  onAdd: (act: () => Promise<Config>) => Promise<boolean>;
}) {
  const [provider, setProvider] = useState('custom');
  const kind = provider === 'custom' ? 'custom' : 'alias';
  const engine = (
    <Field label="Engine" group>
      <Select label="Engine" options={PROVIDERS} value={provider} onChange={setProvider} />
    </Field>
  );
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const known = builtin[provider] ?? {};
  const example = known[EXAMPLES[provider]!] ?? Object.values(known)[0];
  return (
    <Card title="Add a model" actions={<ErrorText value={error} />}>
      <form
        class="add-form"
        method="post"
        onSubmit={async event => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = Object.fromEntries(
            [...new FormData(form)].map(([key, value]) => [key, String(value).trim()]),
          );
          if (kind === 'custom' && !values.name) values.name = slug(values.model ?? '');
          if (!values.name || !values.model || (kind === 'custom' && !values.baseUrl)) return;
          setBusy(true);
          const added =
            kind === 'alias'
              ? await onAdd(() =>
                  client.models.alias(
                    values.name!,
                    [provider, values.model, effort].filter(Boolean).join(':'),
                  ),
                )
              : await onAdd(async () => {
                  const envKey = values.envKey || 'OPENAI_API_KEY';
                  if (values.key)
                    await client.credentials.add({
                      env: { [envKey]: values.key },
                      engine: 'custom',
                      label: providers.find(item => item.id === values.provider)?.name,
                      workspace: values.scope === 'workspace',
                    });
                  return client.models.add({
                    name: values.name!,
                    baseUrl: values.baseUrl!,
                    model: values.model!,
                    envKey,
                  });
                });
          setBusy(false);
          if (!added) return;

          form.reset();
          setRound(round + 1);
        }}
      >
        {kind === 'alias' ? (
          <div class="add-grid">
            {engine}
            <Field label="Name">
              <input
                name="name"
                placeholder={unused(['fast', 'deep', 'quick'], taken)}
                autocomplete="off"
                pattern="[a-z0-9][a-z0-9\-]*"
              />
            </Field>
            <Field label="Model id">
              <input name="model" placeholder={example ?? 'model id'} autocomplete="off" />
            </Field>
            <Field label="Effort" hint="optional" group>
              <Select
                label="Effort"
                options={[['', defaultLabel(efforts[provider])], ...EFFORTS]}
                value={effort}
                onChange={setEffort}
              />
            </Field>
            <button class="btn" disabled={busy}>
              Add
            </button>
          </div>
        ) : (
          <CustomFields
            key={round}
            engine={engine}
            credentials={credentials}
            admin={admin}
            taken={taken}
            busy={busy}
          />
        )}
      </form>
    </Card>
  );
}

/** A custom endpoint's fields; a provider fills its URL and key variable, and a probe lists its models. */
function CustomFields({
  engine,
  credentials,
  admin,
  taken,
  busy,
}: {
  engine: ComponentChildren;
  /** Null on the local server, where keys come from this machine's environment. */
  credentials: CredentialRow[] | null;
  admin: boolean;
  taken: Record<string, unknown>;
  busy: boolean;
}) {
  const [preset, setPreset] = useState(providers[0] ?? OTHER);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [envKey, setEnvKey] = useState(preset.envKey);
  const [key, setKey] = useState('');
  const [scope, setScope] = useState('personal');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const latest = useRef(0);
  const [model, setModel] = useState('');
  const saved = (name: string) =>
    Boolean(name) && Boolean(credentials?.some(row => row.env.includes(name)));

  const [checking, setChecking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const check = (url: string, name: string, typed: string) => {
    const round = ++latest.current;
    if (!url.trim()) return setProbe(null);
    setChecking(true);
    void client.models
      .probe({
        baseUrl: url.trim(),
        ...(name.trim() ? { envKey: name.trim() } : {}),
        ...(typed.trim() ? { key: typed.trim() } : {}),
      })
      .catch((reason): ProbeResult => ({
        reachable: false,
        modelListed: null,
        models: null,
        detail: reasonText(reason),
      }))
      .then(result => {
        if (round !== latest.current) return;
        setChecking(false);
        setProbe(result.models ? { ...result, models: [...result.models].sort() } : result);
      });
  };
  // Typing settles for 250 ms before a probe, like the registry search.
  const checkSoon = (url: string, name: string, typed: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => check(url, name, typed), 250);
  };
  const status = !probe
    ? undefined
    : !probe.reachable
      ? /HTTP 40[13]/.test(probe.detail)
        ? 'key rejected'
        : probe.detail
      : probe.models
        ? `${probe.models.length} listed`
        : 'reachable, no model list';

  return (
    <>
      <div class="add-grid">
        {engine}
        <Field label="Provider" group>
          <Select
            label="Provider"
            name="provider"
            options={providers.map((provider): [string, string] => [provider.id, provider.name])}
            value={preset.id}
            onChange={id => {
              const next = providers.find(provider => provider.id === id) ?? OTHER;
              setPreset(next);
              setBaseUrl(next.baseUrl);
              setEnvKey(next.envKey);
              setProbe(null);
              if (key.trim() || saved(next.envKey) || !next.needsKey)
                check(next.baseUrl, next.envKey, key);
            }}
          />
        </Field>
        <Field label="Model name" hint="optional">
          <input
            name="name"
            placeholder={slug(model) || 'short name like kimi'}
            autocomplete="off"
            pattern="[a-z0-9][a-z0-9\-]*"
          />
        </Field>
      </div>
      <div class="add-grid">
        {preset.needsKey && credentials ? (
          <Field
            label="API key"
            hint={
              <>
                {saved(envKey) ? `optional, your saved ${envKey}` : `saved as ${envKey}`}
                {preset.keyUrl ? (
                  <>
                    {', '}
                    <a class="link" href={preset.keyUrl} target="_blank" rel="noopener noreferrer">
                      get a key
                    </a>
                  </>
                ) : null}
              </>
            }
          >
            <input
              name="key"
              type="password"
              autocomplete="off"
              placeholder={saved(envKey) ? 'Optional' : `${preset.name} API key`}
              value={key}
              onInput={event => {
                setKey(event.currentTarget.value);
                checkSoon(baseUrl, envKey, event.currentTarget.value);
              }}
            />
          </Field>
        ) : null}
        <Field
          label="Model id"
          group
          hint={checking ? <Loading label="Fetching models" inline dots /> : status}
        >
          <Combo
            label="Model id"
            onOpen={() => {
              if (!probe && !checking) check(baseUrl, envKey, key);
            }}
            name="model"
            options={probe?.models ?? []}
            placeholder={probe?.models?.[0] ?? 'qwen3-coder'}
            value={model}
            onChange={setModel}
          />
        </Field>
        {preset.needsKey && credentials && admin ? (
          <Field label="Scope" group>
            <Select label="Scope" name="scope" options={SCOPES} value={scope} onChange={setScope} />
          </Field>
        ) : null}
      </div>
      <div class="add-foot">
        <details class="add-more" open={preset.id === 'other' || undefined}>
          <summary>Advanced</summary>
          <div class="add-grid">
            <Field label="Base URL">
              <input
                name="baseUrl"
                type="url"
                placeholder="http://localhost:11434/v1"
                autocomplete="off"
                value={baseUrl}
                onInput={event => {
                  setBaseUrl(event.currentTarget.value);
                  checkSoon(event.currentTarget.value, envKey, key);
                }}
              />
            </Field>
            <Field label="Key variable">
              <input
                name="envKey"
                class="mono"
                placeholder="OPENAI_API_KEY"
                autocomplete="off"
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                value={envKey}
                onInput={event => setEnvKey(event.currentTarget.value)}
              />
            </Field>
          </div>
        </details>
        <button class="btn" disabled={busy}>
          Add model
        </button>
      </div>
    </>
  );
}

/** Each engine's models, what each points to, and its default; the default engine's default runs new tasks. */
export function ModelsList({
  first,
  config,
  credentials,
  admin,
}: {
  first: ModelsShape;
  config: ConfigShape;
  credentials: CredentialRow[] | null;
  admin: boolean;
}) {
  const models = useSend(first);
  const settings = useConfig(config.config);
  const refresh = (answer: Config) => ({ ...models.value, models: answer.models ?? {} });
  const defaultOf = (engine: string) =>
    settings.value.engines?.[engine]?.model ?? config.effective.engines?.[engine]?.model;
  const off = (name: string) => models.value.models[name]?.disabled === true;
  const chain = settings.value.chain ?? config.effective.chain ?? ENGINES;

  const own = Object.entries(models.value.models).filter(
    ([, entry]) => entry.provider || entry.baseUrl,
  );
  const shown: Array<{
    name: string;
    engine: string;
    target: string;
    entry?: ModelEntry;
    removable: boolean;
  }> = [
    // An alias named like a built-in replaces it, so the built-in row steps aside.
    ...Object.entries(models.value.builtin).flatMap(([engine, names]) =>
      Object.entries(names)
        .filter(([name]) => !own.some(([alias]) => alias === name))
        .map(([name, id]) => ({
          name,
          engine,
          target: id,
          entry: models.value.models[name],
          removable: false,
        })),
    ),
    ...own.map(([name, entry]) => ({
      name,
      engine: entry.provider ?? 'custom',
      target: entry.baseUrl
        ? `${entry.model} · ${entry.baseUrl}`
        : `${entry.model}${entry.effort ? ` · ${entry.effort}` : ''}`,
      entry,
      removable: true,
    })),
  ];
  const groups = [...new Set([...chain, ...ENGINES])]
    .map(engine => [engine, shown.filter(model => model.engine === engine)] as const)
    .filter(([, list]) => list.length);
  return (
    <>
      <AddModel
        builtin={models.value.builtin}
        credentials={credentials}
        admin={admin}
        taken={{
          ...models.value.models,
          ...Object.assign({}, ...Object.values(models.value.builtin)),
        }}
        efforts={Object.fromEntries(
          ENGINES.map(engine => [
            engine,
            settings.value.engines?.[engine]?.effort ?? config.effective.engines?.[engine]?.effort,
          ]),
        )}
        error={models.error}
        onAdd={act => models.send(act, refresh)}
      />
      {groups.map(([engine, list], index) => (
        <List
          key={engine}
          title={ENGINE_NAMES[engine] ?? engine}
          count={list.length}
          error={index ? '' : settings.error}
        >
          {list.map(({ name, target, entry, removable }) => {
            const isDefault = [name, target].includes(defaultOf(engine) ?? '');
            return (
              <Row
                key={name}
                title={name}
                badges={
                  <>
                    {isDefault && chain[0] === engine ? (
                      <Badge tone="acc">default for new tasks</Badge>
                    ) : null}
                    {isDefault && chain[0] !== engine ? (
                      <Badge>default for {ENGINE_NAMES[engine] ?? engine}</Badge>
                    ) : null}
                    {entry?.disabled ? <Badge>off</Badge> : null}
                  </>
                }
                sub={target === name ? undefined : `→ ${target}`}
                actions={
                  isDefault || entry?.disabled ? null : (
                    <button
                      type="button"
                      class="btn ghost sm"
                      onClick={() =>
                        void settings.patch({ engines: { [engine]: { model: name } } })
                      }
                    >
                      Make default
                    </button>
                  )
                }
                menu={
                  <MenuItem
                    title={off(name) ? 'Enable' : 'Disable'}
                    onClick={() =>
                      void models.send(
                        () => client.models[off(name) ? 'enable' : 'disable'](name),
                        refresh,
                      )
                    }
                  />
                }
                remove={
                  removable
                    ? {
                        title: `Remove ${name}?`,
                        body: 'Tasks that ask for it stop running.',
                        onRemove: () => models.send(() => client.models.remove(name), refresh),
                      }
                    : undefined
                }
              />
            );
          })}
        </List>
      ))}
    </>
  );
}
