'use client';

import { client } from '@/utils/client';
import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { Card, FoldCard, Loading } from '@/comps/ui/card';
import { Field } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { Button } from '@/comps/ui/button';
import { MenuItem } from '@/comps/ui/menu-items';
import { Select } from '@/comps/ui/select';
import { Combo } from '@/comps/ui/combo';
import {
  CUSTOM_PROVIDERS,
  EFFORTS,
  ENGINES,
  ENGINE_NAMES,
  SCOPES,
  defaultLabel,
} from '@/app/dash/[org]/settings/model-options';
import { reasonText } from '@/utils/format';
import { useAction } from '@/utils/action';
import { List, Row, replaceTitle, useConfig, useReplace } from './list';
import type {
  Config,
  ConfigShape,
  CredentialRow,
  ModelEntry,
  ModelsShape,
  ProbeResult,
} from '@coder/client/types';

const KINDS: Array<[string, string]> = [
  ['endpoint', 'Endpoint'],
  ['alias', 'Engine alias'],
];
const ALIAS_ENGINES: Array<[string, string]> = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
];
/** The built-in model each engine's id field shows as its example. */
const EXAMPLES: Record<string, string> = { claude: 'sonnet', codex: 'sol' };
const providers = CUSTOM_PROVIDERS;
const OTHER = providers.at(-1)!;

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

/** A short name for a Claude or Codex model id, or an OpenAI-compatible endpoint. Enter adds. */
function AddModel({
  builtin,
  credentials,
  admin,
  taken,
  efforts,
  onAdd,
}: {
  builtin: ModelsShape['builtin'];
  credentials: CredentialRow[] | null;
  admin: boolean;
  /** Each engine's default effort, which an alias without one runs at. */
  efforts: Record<string, string | undefined>;
  /** Every model name in use. */
  taken: Record<string, unknown>;
  onAdd: (act: () => Promise<Config>) => Promise<boolean>;
}) {
  const [kind, setKind] = useState('endpoint');
  const kindField = (
    <Field label="Kind" group>
      <Select label="Kind" options={KINDS} value={kind} onChange={setKind} />
    </Field>
  );
  const [engine, setEngine] = useState('claude');
  const [effort, setEffort] = useState('');
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const replace = useReplace();
  const known = builtin[engine] ?? {};
  const example = known[EXAMPLES[engine]!] ?? Object.values(known)[0];

  const add = async (form: HTMLFormElement, values: Record<string, string>) => {
    setBusy(true);
    const added =
      kind === 'alias'
        ? await onAdd(() =>
            client.models.alias(
              values.name!,
              [engine, values.model, effort].filter(Boolean).join(':'),
            ),
          )
        : await onAdd(async () => {
            const envKey = values.envKey || 'OPENAI_API_KEY';
            if (values.key)
              await client.credentials.add({
                env: { [envKey]: values.key },
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
  };

  return (
    <FoldCard
      title="Add a model"
      note="A short name for an engine model, or an OpenAI-compatible endpoint"
    >
      <form
        class="add-form"
        method="post"
        onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget;
          const values = Object.fromEntries(
            [...new FormData(form)].map(([key, value]) => [key, String(value).trim()]),
          );
          if (kind === 'endpoint' && !values.name) values.name = slug(values.model ?? '');
          if (!values.name || !values.model || (kind === 'endpoint' && !values.baseUrl)) return;
          const envKey = values.envKey || 'OPENAI_API_KEY';
          const scope = values.scope || 'personal';
          if (
            kind === 'endpoint' &&
            values.key &&
            credentials?.some(row => row.name === envKey && row.scope === scope)
          )
            return replace.ask(replaceTitle(envKey, scope), () => void add(form, values));
          void add(form, values);
        }}
      >
        {kind === 'alias' ? (
          <div class="add-grid">
            {kindField}
            <Field label="Engine" group>
              <Select label="Engine" options={ALIAS_ENGINES} value={engine} onChange={setEngine} />
            </Field>
            <Field label="Model id">
              <input name="model" placeholder={example ?? 'model id'} autocomplete="off" />
            </Field>
            <Field label="Short name" hint="used as --model">
              <input
                name="name"
                placeholder={unused(['fast', 'deep', 'quick'], taken)}
                autocomplete="off"
                pattern="[a-z0-9][a-z0-9\-]*"
              />
            </Field>
            <Field label="Effort" hint="optional" group>
              <Select
                label="Effort"
                options={[['', defaultLabel(efforts[engine])], ...EFFORTS]}
                value={effort}
                onChange={setEffort}
              />
            </Field>
            <Button type="submit" loading={busy}>
              Add
            </Button>
          </div>
        ) : (
          <CustomFields
            key={round}
            kind={kindField}
            credentials={credentials}
            admin={admin}
            busy={busy}
          />
        )}
      </form>
      {replace.dialog}
    </FoldCard>
  );
}

/** A custom endpoint's fields: the model in one row, its key in the next; a provider fills its URL and key variable, and a probe lists its models. */
function CustomFields({
  kind,
  credentials,
  admin,
  busy,
}: {
  kind: ComponentChildren;
  /** Null on the local server, where keys come from this machine's environment. */
  credentials: CredentialRow[] | null;
  admin: boolean;
  busy: boolean;
}) {
  const [preset, setPreset] = useState(providers[0] ?? OTHER);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [envKey, setEnvKey] = useState(preset.envKey);
  const [key, setKey] = useState('');
  const [scope, setScope] = useState(admin ? 'workspace' : 'personal');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const latest = useRef(0);
  const [model, setModel] = useState('');
  const has = (name: string, where: string) =>
    Boolean(name) && Boolean(credentials?.some(row => row.name === name && row.scope === where));
  // The scope whose saved key a model would use; a member's tasks fall back to the workspace's.
  const saved = (name: string, where = scope) =>
    has(name, where) ? where : !admin && has(name, 'workspace') ? 'workspace' : undefined;
  const collapsed = saved(envKey, admin ? 'workspace' : 'personal');
  const whose = (where?: string) => (where === 'workspace' ? "the workspace's" : 'your');

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
  const keyRow =
    preset.needsKey && credentials ? (
      <div class="add-grid">
        <Field
          label="API key"
          hint={
            <>
              {saved(envKey)
                ? `uses ${whose(saved(envKey))} saved ${envKey}; enter one to replace it`
                : `a new key, stored as ${envKey}`}
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
            placeholder={saved(envKey) ? 'Leave empty to use the saved key' : `${preset.name} API key`}
            value={key}
            onInput={event => {
              setKey(event.currentTarget.value);
              checkSoon(baseUrl, envKey, event.currentTarget.value);
            }}
          />
        </Field>
        {admin ? (
          <Field label="Scope" group>
            <Select label="Scope" name="scope" options={SCOPES} value={scope} onChange={setScope} />
          </Field>
        ) : null}
      </div>
    ) : null;

  return (
    <>
      <div class="add-grid">
        {kind}
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
        <Field label="Short name" hint="used as --model; defaults to the model id">
          <input
            name="name"
            placeholder={slug(model) || 'kimi'}
            autocomplete="off"
            pattern="[a-z0-9][a-z0-9\-]*"
          />
        </Field>
      </div>
      {keyRow && collapsed ? (
        <details key={envKey} class="add-more">
          <summary>
            API key · uses {whose(collapsed)} saved {envKey}
          </summary>
          {keyRow}
        </details>
      ) : (
        keyRow
      )}
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
        <Button type="submit" loading={busy}>
          Add model
        </Button>
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
  const [models, setModels] = useState(first);
  const action = useAction();
  const settings = useConfig(config.config);
  const send = (act: () => Promise<Config>) =>
    action.run('send', async () => {
      const answer = await act();
      setModels(now => ({ ...now, models: answer.models ?? {} }));
    });
  const defaultOf = (engine: string) =>
    settings.value.engines?.[engine]?.model ?? config.effective.engines?.[engine]?.model;
  const off = (name: string) => models.models[name]?.disabled === true;
  const chain = settings.value.chain ?? config.effective.chain ?? ENGINES;

  const own = Object.entries(models.models).filter(([, entry]) => entry.provider || entry.baseUrl);
  const shown: Array<{
    name: string;
    engine: string;
    target: string;
    entry?: ModelEntry;
    removable: boolean;
  }> = [
    // An alias named like a built-in replaces it, so the built-in row steps aside.
    ...Object.entries(models.builtin).flatMap(([engine, names]) =>
      Object.entries(names)
        .filter(([name]) => !own.some(([alias]) => alias === name))
        .map(([name, id]) => ({
          name,
          engine,
          target: id,
          entry: models.models[name],
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
        builtin={models.builtin}
        credentials={credentials}
        admin={admin}
        taken={{
          ...models.models,
          ...Object.assign({}, ...Object.values(models.builtin)),
        }}
        efforts={Object.fromEntries(
          ENGINES.map(engine => [
            engine,
            settings.value.engines?.[engine]?.effort ?? config.effective.engines?.[engine]?.effort,
          ]),
        )}
        onAdd={send}
      />
      {groups.map(([engine, list]) => (
        <List key={engine} title={ENGINE_NAMES[engine] ?? engine} count={list.length}>
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
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        void settings.patch({ engines: { [engine]: { model: name } } })
                      }
                    >
                      Make default
                    </Button>
                  )
                }
                menu={
                  <MenuItem
                    title={off(name) ? 'Enable' : 'Disable'}
                    onClick={() =>
                      void send(() => client.models[off(name) ? 'enable' : 'disable'](name))
                    }
                  />
                }
                remove={
                  removable
                    ? {
                        title: `Remove ${name}?`,
                        body: 'Tasks that ask for it stop running.',
                        onRemove: () => send(() => client.models.remove(name)),
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
