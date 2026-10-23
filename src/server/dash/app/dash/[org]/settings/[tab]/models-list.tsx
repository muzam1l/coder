'use client';

import './models-list.css';

import { client } from '@/utils/client';
import { Fragment } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { useSearchParams } from '@wular/pnext/navigation/client';

import { Card, Loading } from '@/comps/ui/card';
import { Field } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { Button, LinkButton } from '@/comps/ui/button';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuHead, MenuItem, MenuLabel } from '@/comps/ui/menu-items';
import { Select } from '@/comps/ui/select';
import { Combo } from '@/comps/ui/combo';
import { Modal } from '@/comps/ui/modal';
import { Notice } from '@/comps/ui/notice';
import { iAlert, iCheck, iDots, iFirst, iLeft, iOff, iPencil, iPlus, iRight, iTrash, iUndo } from '@/comps/ui/icons';
import { useOrg } from '@/comps/nav/org';
import {
  CUSTOM_PROVIDERS,
  SCOPES,
  modelChoices,
  splitSpec,
} from '@/app/dash/[org]/settings/model-options';
import { ModelPick } from '@/app/dash/[org]/settings/model-pick';
import { reasonText } from '@/utils/format';
import { useAction } from '@/utils/action';
import { toastError } from '@/comps/frame/task-toasts';
import { List, Row, replaceTitle, useAddDialog, useConfig, useReplace } from './list';
import type {
  Config,
  ConfigShape,
  CredentialRow,
  ModelsShape,
  ProbeResult,
} from '@coder/client/types';

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

/** An OpenAI-compatible model, such as Ollama or OpenRouter, in a dialog. Enter adds. */
function AddModel({
  credentials,
  admin,
  onAdd,
  onClose,
}: {
  credentials: CredentialRow[] | null;
  admin: boolean;
  onAdd: (act: () => Promise<Config>) => Promise<boolean>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const replace = useReplace();

  const add = async (values: Record<string, string>) => {
    setBusy(true);
    const added = await onAdd(async () => {
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
        ...(values.contextWindow ? { contextWindow: Number(values.contextWindow) } : {}),
      });
    });
    setBusy(false);
    if (added) onClose();
  };

  return (
    <>
      <Modal
        class="add-modal"
        title="Add a model"
        dismiss
        busy={busy}
        onSubmit={event => {
          event.preventDefault();
          const form = event.currentTarget as HTMLFormElement;
          const values = Object.fromEntries(
            [...new FormData(form)].map(([key, value]) => [key, String(value).trim()]),
          );
          if (!values.name) values.name = slug(values.model ?? '');
          if (!values.name || !values.model || !values.baseUrl) return;
          const envKey = values.envKey || 'OPENAI_API_KEY';
          const scope = values.scope || 'personal';
          if (values.key && credentials?.some(row => row.name === envKey && row.scope === scope))
            return replace.ask(replaceTitle(envKey, scope), () => void add(values));
          void add(values);
        }}
        onClose={onClose}
        actions={
          <Button type="submit" loading={busy}>
            Add model
          </Button>
        }
      >
        <div class="add-form">
          <CustomFields credentials={credentials} admin={admin} />
        </div>
      </Modal>
      {replace.dialog}
    </>
  );
}

/** A custom endpoint's fields: the model in one row, its key in the next; a provider fills its URL and key variable, and a probe lists its models. */
function CustomFields({
  credentials,
  admin,
}: {
  /** Null on the local server, where keys come from this machine's environment. */
  credentials: CredentialRow[] | null;
  admin: boolean;
}) {
  // A chat's link fills the form in.
  const asked = useSearchParams();
  const askedUrl = asked.get('base-url') ?? '';
  const [preset, setPreset] = useState(
    askedUrl
      ? (providers.find(provider => provider.baseUrl === askedUrl) ?? OTHER)
      : (providers[0] ?? OTHER),
  );
  const [baseUrl, setBaseUrl] = useState(askedUrl || preset.baseUrl);
  const [envKey, setEnvKey] = useState(asked.get('env-key') ?? preset.envKey);
  const [key, setKey] = useState('');
  const [scope, setScope] = useState(admin ? 'workspace' : 'personal');
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const latest = useRef(0);
  // One toast per failure; a probe that works again clears it.
  const failed = useRef('');
  const [model, setModel] = useState(asked.get('model') ?? '');
  const [contextWindow, setContextWindow] = useState(asked.get('context-window'));
  const reported = probe?.contextWindows?.[model];
  const has = (name: string, where: string) =>
    Boolean(name) && Boolean(credentials?.some(row => row.name === name && row.scope === where));
  // The scope whose saved key a model would use; a member's tasks fall back to the workspace's.
  const saved = (name: string, where = scope) =>
    has(name, where) ? where : !admin && has(name, 'workspace') ? 'workspace' : undefined;
  const collapsed = saved(envKey, admin ? 'workspace' : 'personal');
  const whose = (where?: string) => (where === 'workspace' ? "the workspace's" : 'the personal');

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
        const failure = result.reachable
          ? ''
          : /HTTP 40[13]/.test(result.detail)
            ? 'The API key was rejected.'
            : `${url.trim()} isn't reachable.`;
        if (failure && failure !== failed.current) toastError('Models not listed', failure);
        failed.current = failure;
      });
  };
  // Typing settles for 250 ms before a probe, like the registry search.
  const checkSoon = (url: string, name: string, typed: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => check(url, name, typed), 250);
  };
  // Only what the endpoint lists; an unreachable one just offers no suggestions.
  const status = probe?.models ? `${probe.models.length} listed` : undefined;
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
            placeholder={
              saved(envKey) ? 'Leave empty to use the saved key' : `${preset.name} API key`
            }
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
              // The model and a typed key belong to the previous provider.
              setModel('');
              setContextWindow(null);
              setKey('');
              setProbe(null);
              if (saved(next.envKey) || !next.needsKey) check(next.baseUrl, next.envKey, '');
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
            onChange={next => {
              setModel(next);
              setContextWindow(null);
            }}
          />
        </Field>
        <Field label="Short name" hint="used as --model; defaults to the model id">
          <input
            name="name"
            defaultValue={asked.get('add') ?? undefined}
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
          <Field label="Context window" hint="tokens; empty uses Codex's default, 272000">
            <input
              name="contextWindow"
              type="number"
              min="1"
              step="1"
              placeholder="272000"
              autocomplete="off"
              value={contextWindow ?? (reported ? String(reported) : '')}
              onInput={event => setContextWindow(event.currentTarget.value)}
            />
          </Field>
        </div>
      </details>
    </>
  );
}
/** An alias in a dialog: a short name for a model and effort; a built-in's name replaces it, or turns it off. */
function AliasDialog({
  shape,
  editing,
  onSave,
  onClose,
}: {
  shape: ModelsShape;
  /** The name being changed; none adds one. */
  editing?: string;
  onSave: (act: () => Promise<Config>) => Promise<boolean>;
  onClose: () => void;
}) {
  const entry = editing ? shape.models[editing] : undefined;
  const [name, setName] = useState(editing ?? '');
  const [spec, setSpec] = useState(typeof entry === 'string' ? entry : entry === false ? '' : 'sol');
  const [busy, setBusy] = useState(false);
  const builtin = shape.builtin[name.trim()];
  const shown = name.trim() || 'name';

  return (
    <Modal
      title={editing ? `Edit ${editing}` : 'Add alias'}
      dismiss
      busy={busy}
      onSubmit={async event => {
        event.preventDefault();
        const alias = name.trim();
        if (!alias) return;
        setBusy(true);
        const saved = await onSave(() =>
          spec ? client.models.alias(alias, spec) : client.models.disable(alias),
        );
        setBusy(false);
        if (saved) onClose();
      }}
      onClose={onClose}
      actions={
        <Button type="submit" loading={busy}>
          Save
        </Button>
      }
    >
      <Field label="Name" hint={builtin ? `replaces the built-in, ${builtin}` : 'used as --model'}>
        <input
          name="name"
          value={name}
          onInput={event => setName(event.currentTarget.value)}
          placeholder="fast"
          autocomplete="off"
          spellcheck={false}
          pattern="[a-z0-9][a-z0-9\-]*"
          readOnly={Boolean(editing)}
          required
        />
      </Field>
      <Field label="Model" group>
        <ModelPick shape={shape} value={spec} onChange={setSpec} empty={builtin ? { label: 'Off', sub: "can't be picked or fallen back to" } : undefined} />
      </Field>
      <p class="muted mono">
        {spec ? `${shown} = ${spec}` : `${shown} can't be picked or fallen back to`}
      </p>
    </Modal>
  );
}

/** One chain entry: its model and effort, each one click, and its ⋯ menu; it drags to a new place. */
function ChainItem({
  shape,
  spec,
  index,
  count,
  runsOn,
  onChange,
  onMove,
  onRemove,
  onDrop,
  onAdd,
}: {
  shape: ModelsShape;
  spec: string;
  index: number;
  count: number;
  runsOn?: string;
  onChange: (spec: string) => void;
  onMove: (to: number) => void;
  onRemove: () => void;
  onDrop: (from: number) => void;
  onAdd: () => void;
}) {
  const skipped = runsOn?.includes('no credential');
  return (
    <span
      class="chain-item chain-chip"
      draggable
      onDragStart={event => event.dataTransfer?.setData('text/plain', String(index))}
      onDragOver={event => event.preventDefault()}
      onDrop={event => {
        event.preventDefault();
        onDrop(Number(event.dataTransfer?.getData('text/plain')));
      }}
    >
      <ModelPick shape={shape} value={spec} onChange={onChange} onAdd={onAdd} compact />
      <Menu button="icon" class="chain-more" label={`${spec} actions`} summary={<Icon d={iDots} />}>
        <MenuHead
          icon={<span class="chain-n">{index + 1}</span>}
          title={index ? spec : `${spec}, the default`}
          sub={runsOn ?? ''}
        />
        {index > 0 ? <MenuItem icon={iFirst} title="Make default" onClick={() => onMove(0)} /> : null}
        {index > 0 ? <MenuItem icon={iLeft} title="Move earlier" onClick={() => onMove(index - 1)} /> : null}
        {index < count - 1 ? (
          <MenuItem icon={iRight} title="Move later" onClick={() => onMove(index + 1)} />
        ) : null}
        {count > 1 ? <MenuItem icon={iTrash} title="Remove from chain" danger onClick={onRemove} /> : null}
      </Menu>
      {skipped ? <i class="chain-dot" title={runsOn} /> : null}
    </span>
  );
}

/** What a name runs, as its row says it. */
function target(shape: ModelsShape, name: string): string {
  const entry = shape.models[name];
  if (entry === false) return shape.builtin[name] ?? '';
  if (typeof entry === 'object' && entry)
    return `${entry.model} · ${URL.canParse(entry.baseUrl) ? new URL(entry.baseUrl).host : entry.baseUrl}`;

  return String(entry ?? '');
}

/** The chain tasks try in order and the review model, each a model and effort; then the workspace's own names: aliases, custom models and built-ins turned off. */
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
  const adding = useAddDialog('Add model', ['base-url', 'model', 'env-key', 'context-window']);
  const [aliasing, setAliasing] = useState<string | true>();
  const action = useAction();
  const settings = useConfig(config.config);
  const send = (act: () => Promise<Config>, toast?: string) =>
    action.run(
      'send',
      async () => {
        await act();
        setModels(await client.models.list());
      },
      { toast },
    );
  // A chain or review change reads the models again for where each runs.
  const save = async (patch: Parameters<typeof settings.patch>[0]) => {
    if (await settings.patch(patch)) setModels(await client.models.list());
  };
  const chain = settings.value.chain ?? config.effective.chain ?? [];
  const review = settings.value.reviewModel ?? config.effective.reviewModel ?? '';
  const move = (from: number, to: number) => {
    if (from === to || Number.isNaN(from)) return;
    const next = [...chain];
    next.splice(to, 0, ...next.splice(from, 1));
    void save({ chain: next });
  };
  const { options, headings } = modelChoices(models);
  const unused = options.filter(
    ([name]) => !chain.some(spec => splitSpec(spec, models).model === name),
  );
  const own = Object.keys(models.models);
  // Built-ins the workspace left as they are, listed after its own names.
  const builtins = Object.keys(models.builtin).filter(name => !(name in models.models));
  const org = useOrg();
  const skipped = chain.filter(spec => models.runsOn?.[spec]?.includes('no credential'));

  return (
    <>
      <Card look="filled" title="Chain">
        <p class="body muted">Tasks try these in order; drag a model to move it.</p>
        {skipped.length ? (
          <Notice tone="warning" slim>
            <Icon d={iAlert} />
            <span class="grow">
              {skipped.join(', ')} {skipped.length > 1 ? 'have' : 'has'} no credential, so tasks
              skip {skipped.length > 1 ? 'them' : 'it'}.
            </span>
            <LinkButton
              variant="outline"
              size="sm"
              href="/dash/[org]/settings/[tab]"
              params={{ org, tab: 'credentials' }}
            >
              Add credential
            </LinkButton>
          </Notice>
        ) : null}
        <div class="chain">
          {chain.map((spec, index) => (
            <Fragment key={`${index}:${spec}`}>
              {index ? <span class="chain-arrow" aria-hidden="true">→</span> : null}
              <ChainItem
                shape={models}
                spec={spec}
                index={index}
                count={chain.length}
                runsOn={models.runsOn?.[spec]}
                onChange={next => save({ chain: chain.map((each, at) => (at === index ? next : each)) })}
                onMove={to => move(index, to)}
                onRemove={() => save({ chain: chain.filter((_, at) => at !== index) })}
                onDrop={from => move(from, index)}
                onAdd={adding.show}
              />
            </Fragment>
          ))}
          {admin ? (
            <Menu
              class="chain-add"
              label="Add to the chain"
              summary={
                <>
                  <Icon d={iPlus} />
                  Add
                </>
              }
              summaryClass="chain-add-btn"
            >
              {unused.map(([name]) => (
                <Fragment key={name}>
                  {headings[name] ? <MenuLabel>{headings[name]}</MenuLabel> : null}
                  <MenuItem
                    title={name}
                    end={<small class="muted">{target(models, name) || models.builtin[name]}</small>}
                    onClick={() => save({ chain: [...chain, name] })}
                  />
                </Fragment>
              ))}
              <MenuItem icon={iPlus} title="Add a model" onClick={adding.show} />
            </Menu>
          ) : null}
        </div>
      </Card>
      <Card look="filled" title="Review">
        <p class="body muted">coder review and the review tool run this model, then the chain.</p>
        <div class="chain" title={models.runsOn?.[review]}>
          <ModelPick
            shape={models}
            value={review}
            onChange={spec => save({ reviewModel: spec })}
            onAdd={adding.show}
            compact
          />
        </div>
      </Card>
      <List look="filled"
        title="Models"
        count={own.length + builtins.length}
        actions={
          admin ? (
            <>
              <Button size="sm" variant="secondary" leftIcon={iPlus} onClick={() => setAliasing(true)}>
                Add alias
              </Button>
              {adding.button}
            </>
          ) : undefined
        }
      >
        {own.map(name => {
          const entry = models.models[name];
          const off = entry === false || (typeof entry === 'object' && entry?.disabled);
          const replaces = typeof entry === 'string' && name in models.builtin;
          return (
            <Row
              key={name}
              title={name}
              actions={
                off ? <Badge>off</Badge> : replaces ? <Badge tone="acc">replaces built-in</Badge> : null
              }
              sub={target(models, name)}
              menu={
                admin ? (
                  <>
                    {typeof entry === 'string' || entry === false ? (
                      <MenuItem icon={iPencil} title="Edit" onClick={() => setAliasing(name)} />
                    ) : null}
                    {typeof entry === 'object' && entry ? (
                      <MenuItem
                        icon={off ? iCheck : iOff}
                        title={off ? 'Enable' : 'Disable'}
                        onClick={() => void send(() => client.models[off ? 'enable' : 'disable'](name))}
                      />
                    ) : null}
                  </>
                ) : undefined
              }
              remove={
                admin
                  ? {
                      title: replaces || off ? `Reset ${name}?` : `Remove ${name}?`,
                      body:
                        replaces || off
                          ? `${name} runs the built-in ${models.builtin[name]} again.`
                          : 'Tasks that ask for it stop running.',
                      label: replaces || off ? 'Reset' : 'Remove',
                      icon: replaces || off ? iUndo : iTrash,
                      link: name,
                      onRemove: () => send(() => client.models.remove(name)),
                    }
                  : undefined
              }
            />
          );
        })}
        {builtins.map(name => (
          <Row
            key={name}
            title={name}
            actions={<Badge>built-in</Badge>}
            sub={models.builtin[name]}
            menu={
              admin ? (
                <>
                  <MenuItem icon={iPencil} title="Override" onClick={() => setAliasing(name)} />
                  <MenuItem
                    icon={iOff}
                    title="Disable"
                    onClick={() => void send(() => client.models.disable(name))}
                  />
                </>
              ) : undefined
            }
          />
        ))}
      </List>
      {aliasing ? (
        <AliasDialog
          shape={models}
          editing={aliasing === true ? undefined : aliasing}
          onSave={act => send(act, 'Not saved')}
          onClose={() => setAliasing(undefined)}
        />
      ) : null}
      {adding.open ? (
        <AddModel
          credentials={credentials}
          admin={admin}
          onAdd={act => send(act, 'Not saved')}
          onClose={adding.close}
        />
      ) : null}
    </>
  );
}
