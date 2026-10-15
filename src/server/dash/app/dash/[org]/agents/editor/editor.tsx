'use client';

import './editor.css';
// The preview is the same card the agents list draws.
import '@/app/dash/[org]/agents/(list)/page.css';

import { useEffect, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { iDown, iPlus, iShuffle, iUpload } from '@/comps/ui/icons';
import { useRouter } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import { Link } from '@wular/pnext/link';
import type {
  AgentDefinition,
  AgentRow,
  Config,
  IntegrationInfo,
  ModelsShape,
} from '@coder/client/types';
import { BrandIcon, DisabledBadge, PlatformLine } from '@/app/dash/[org]/agents/agent/agent-pills';
import { Hero } from '@/app/dash/[org]/agents/agent/hero';
import { Back, PageHead } from '@/comps/frame/page-head';
import { HEADS } from '@/comps/frame/heads';
import { initial } from '@/utils/format';
import { Field } from '@/comps/ui/field';
import { showToast, toastError } from '@/comps/frame/task-toasts';
import { Badge, Chip, Chips } from '@/comps/ui/badge';
import { Button, LinkButton } from '@/comps/ui/button';
import { Icon } from '@/comps/ui/icon';
import { Select } from '@/comps/ui/select';
import { Segmented } from '@/comps/ui/segmented';
import { Search } from '@/comps/ui/toolbar';
import { ImportPicker } from './import-picker';
import { markdown } from '@/app/dash/[org]/agents/agent/instructions';
import {
  ENGINE_NAMES,
  defaultLabel,
  modelHeadings,
  modelOptions,
  modelValue,
  splitModel,
} from '@/app/dash/[org]/settings/model-options';
import { suggestName } from './names';

const PERMISSIONS: Array<[string, string]> = [
  ['read-only', 'Read only'],
  ['workspace-write', 'Edit files'],
  ['auto', 'Auto'],
];
const PERMISSION_HINTS: Record<string, string> = {
  'read-only': 'reads the repository and changes nothing',
  'workspace-write': 'edits files inside the repository',
  auto: 'edits files, reaches the network, and asks when it needs more',
};
const EFFORTS: Array<[string, string]> = [
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
const PRESETS = ['observe', 'comment', 'write'];
const ACCESS: Record<string, [string, string]> = {
  observe: ['Observe', 'reads the platform only'],
  comment: ['Comment', 'also replies and reacts'],
  write: ['Write', 'also changes code there, like opening pull requests'],
};
const TEMPLATES: Array<[Template, string, string]> = [
  ['blank', 'Blank', 'start from nothing'],
  ['helper', 'Slack helper', 'answers questions in chat'],
  ['reviewer', 'GitHub reviewer', 'reviews pull requests'],
];
/** A search over platforms shows once the catalog is longer than this. */
const SEARCH_FROM = 6;
const REVIEWER =
  'Review each pull request for bugs, risky changes and missing tests.\nComment on the lines that matter and keep it short.\nWhen mentioned, answer questions about the code and cite file paths.';
const HELPER =
  "Answer the team's questions in the thread.\nRead the code before you answer, cite file paths, and say when you are unsure.\nIf asked to change code, describe the change and stop.";

export type Template = 'import' | 'reviewer' | 'helper' | 'blank';

const eventNames = (events: unknown): string[] =>
  Array.isArray(events)
    ? events.map(String)
    : events && typeof events === 'object'
      ? Object.keys(events)
      : [];

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

interface Draft {
  name: string;
  id: string;
  description: string;
  platforms: string[];
  events: Record<string, string[]>;
  match: Record<string, Record<string, string>>;
  tools: Record<string, string | string[] | undefined>;
  permissions: string;
  systemPrompt: string;
  engine: string;
  model: string;
  effort: string;
}

function draftOf(
  agent: AgentRow | undefined,
  suggested: string,
  catalog: IntegrationInfo[],
): Draft {
  const definition = agent?.definition;
  const draft: Draft = {
    name: agent?.name ?? suggested,
    id: agent?.id ?? slug(suggested),
    description: agent?.description ?? definition?.description ?? '',
    platforms: [],
    events: {},
    match: {},
    tools: {},
    permissions: definition?.permissions ?? 'read-only',
    systemPrompt: agent?.systemPrompt ?? '',
    engine: definition?.engine ?? '',
    model: definition?.model ?? '',
    effort: definition?.effort ?? '',
  };
  // A platform this server does not offer is left out, so publishing drops it.
  for (const [id, entry] of Object.entries(definition?.integrations ?? {})) {
    if (!catalog.some(info => info.id === id)) continue;
    draft.platforms.push(id);
    draft.events[id] = eventNames(entry.events);
    draft.match[id] = {};
    if (entry.events && !Array.isArray(entry.events))
      for (const [name, options] of Object.entries(entry.events))
        if (options && typeof options === 'object' && 'match' in options)
          draft.match[id]![name] = String((options as { match: unknown }).match);
    draft.tools[id] = entry.tools as Draft['tools'][string];
  }
  return draft;
}

/** Every event a platform offers except the noisy ones (messages, comments), which the user opts into with a filter. */
const defaultEvents = (info: IntegrationInfo | undefined) =>
  Object.entries(info?.events ?? {})
    .filter(([, spec]) => !spec.noisy)
    .map(([name]) => name);

/** What a template sets: where it listens, what wakes it, and its instructions. The name stays. */
function fromTemplate(template: Template, catalog: IntegrationInfo[]): Partial<Draft> {
  const listen = (pick: (info: IntegrationInfo) => boolean) => {
    const platforms = catalog.filter(pick).map(info => info.id);

    return {
      platforms,
      events: Object.fromEntries(
        platforms.map(id => [id, defaultEvents(catalog.find(info => info.id === id))]),
      ),
      tools: Object.fromEntries(platforms.map(id => [id, 'comment'])),
      match: {},
    };
  };
  if (template === 'reviewer')
    return {
      ...listen(info => 'pull_request' in info.events),
      description: 'Reviews pull requests and answers questions about the code.',
      systemPrompt: REVIEWER,
    };
  if (template === 'helper')
    return {
      ...listen(info => info.id === 'slack'),
      description: "Answers the team's questions in chat.",
      systemPrompt: HELPER,
    };
  return { platforms: [], events: {}, tools: {}, match: {}, description: '', systemPrompt: '' };
}

/** One platform's events: a plain list unless an event carries options, which are kept. */
function eventsFor(
  previous: NonNullable<AgentDefinition['integrations']>[string] | undefined,
  names: string[],
  match: Record<string, string>,
) {
  const before = previous?.events && !Array.isArray(previous.events) ? previous.events : {};
  const built = Object.fromEntries(
    names.map(name => {
      const kept = before[name];
      const text = match[name]?.trim();
      const options =
        kept && typeof kept === 'object' ? { ...(kept as Record<string, unknown>) } : {};
      if (text) options.match = text;
      else delete options.match;
      if (Object.keys(options).length) return [name, options];
      return [name, kept === undefined || typeof kept === 'object' ? true : kept];
    }),
  );
  return Object.values(built).every(value => value === true) ? names : built;
}

const sameTools = (a: string[] = [], b: string[] = []) =>
  a.length === b.length && a.every(tool => b.includes(tool));

/** A platform's access presets that each grant more than the one before; a single one means it has no levels. */
function levelsOf(info?: IntegrationInfo) {
  if (!info) return [];
  const kept = PRESETS.filter(
    (preset, at) => !at || !sameTools(info.presets[preset], info.presets[PRESETS[at - 1]!]),
  );
  return kept.length > 1 ? kept : [];
}

/** The level a preset grants among `levels`: the highest one at or below it. */
const levelOf = (levels: string[], preset: string) =>
  levels.filter(level => PRESETS.indexOf(level) <= PRESETS.indexOf(preset)).at(-1) ?? '';

/** The workspace's run settings for whatever the agent leaves unset. */
export interface RunDefaults {
  engine: string;
  engines: NonNullable<Config['engines']>;
  builtin: ModelsShape['builtin'];
}

/** Make a dashboard agent on one page, from a template or a repository, or edit one. Saving publishes a version. */
export function AgentEditor({
  catalog,
  agent,
  suggested = '',
  section,
  models,
  defaults = { engine: '', engines: {}, builtin: {} },
  template: first,
  connected = false,
  connectLabel = 'Connect',
  tunnel = false,
  port = '',
}: {
  catalog: IntegrationInfo[];
  agent?: AgentRow;
  suggested?: string;
  section?: string;
  /** Model names per engine, for the model picker. */
  models: Record<string, string[]>;
  defaults?: RunDefaults;
  template?: Template;
  /** A platform that reaches repositories is installed here. */
  connected?: boolean;
  connectLabel?: string;
  /** Platforms cannot reach this server yet, so connecting starts with a tunnel. */
  tunnel?: boolean;
  port?: string;
}) {
  const nav = useRouter();
  const org = useOrg();
  const creating = !agent;
  const [template, setTemplate] = useState<Template>(first ?? 'blank');
  const [draft, setDraft] = useState(() => ({
    ...draftOf(agent, suggested, catalog),
    ...(creating ? fromTemplate(first ?? 'blank', catalog) : {}),
  }));
  const [idTouched, setIdTouched] = useState(false);
  const [writing, setWriting] = useState('write');
  const [query, setQuery] = useState('');
  const action = useAction({
    toast: creating ? 'Agent not created' : 'Not published',
    leaves: true,
  });
  const busy = Boolean(action.pending);
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft(current => ({ ...current, [key]: value }));
  const access = (id: string, tools = draft.tools[id]) =>
    Array.isArray(tools) ? 'custom' : (tools ?? 'observe');
  const shared = draft.platforms.length ? access(draft.platforms[0]!) : 'comment';
  const uniform = draft.platforms.every(id => access(id) === shared);

  const leveled = draft.platforms
    .map(id => [id, levelsOf(catalog.find(entry => entry.id === id))] as const)
    .filter(([, kept]) => kept.length);
  const levels = PRESETS.filter(preset => leveled.some(([, kept]) => kept.includes(preset)));
  const picked = new Set(leveled.map(([id]) => access(id)));
  const level = picked.size === 1 ? levelOf(levels, [...picked][0]!) : '';

  const aliasOf = (engine: string, model?: string) =>
    Object.entries(defaults.builtin[engine] ?? {}).find(([, target]) => target === model)?.[0] ??
    model;
  const engine = draft.engine || defaults.engine;
  const base = defaults.engines[engine] ?? {};
  const fallback = [
    ENGINE_NAMES[defaults.engine] ?? defaults.engine,
    aliasOf(defaults.engine, defaults.engines[defaults.engine]?.model),
  ]
    .filter(Boolean)
    .join(' · ');
  const permission = PERMISSIONS.find(([key]) => key === draft.permissions);
  const repoAccess = permission?.[1].toLowerCase();
  const run = creating
    ? 'you can change these later in its settings'
    : (draft.engine || draft.model || draft.effort
        ? [
            ENGINE_NAMES[engine] ?? engine,
            draft.model || aliasOf(engine, base.model),
            draft.effort || base.effort,
            repoAccess,
          ]
        : ['Default models', repoAccess]
      )
        .filter(Boolean)
        .join(' · ');

  useEffect(() => {
    if (!section) return;
    const target = document.getElementById(`agent-${section}`);
    target?.scrollIntoView({ block: 'start' });
    target?.querySelector<HTMLElement>('input, textarea, button')?.focus({ preventScroll: true });
  }, []);

  const pickTemplate = (next: Template) => {
    setTemplate(next);
    if (next !== 'import') setDraft(current => ({ ...current, ...fromTemplate(next, catalog) }));
  };
  const rename = (name: string) =>
    setDraft(current => ({
      ...current,
      name,
      ...(creating && !idTouched ? { id: slug(name) } : {}),
    }));
  const togglePlatform = (id: string, on: boolean) =>
    setDraft(current => {
      const names = Object.keys(catalog.find(entry => entry.id === id)?.events ?? {});
      return {
        ...current,
        platforms: on
          ? catalog
              .map(entry => entry.id)
              .filter(key => key === id || current.platforms.includes(key))
          : current.platforms.filter(key => key !== id),
        events:
          on && !current.events[id]?.length
            ? { ...current.events, [id]: defaultEvents(catalog.find(entry => entry.id === id)) }
            : current.events,
        tools:
          on && !current.tools[id]
            ? { ...current.tools, [id]: uniform && shared !== 'custom' ? shared : 'comment' }
            : current.tools,
      };
    });
  const toggleEvent = (id: string, event: string, on: boolean) =>
    setDraft(current => {
      const list = current.events[id] ?? [];
      const match = on
        ? current.match
        : { ...current.match, [id]: { ...current.match[id], [event]: '' } };

      return {
        ...current,
        events: {
          ...current.events,
          [id]: on ? [...new Set([...list, event])] : list.filter(name => name !== event),
        },
        match,
      };
    });
  const setMatch = (id: string, event: string, text: string) =>
    setDraft(current => ({
      ...current,
      match: { ...current.match, [id]: { ...current.match[id], [event]: text } },
    }));

  const submit = async () => {
    const silent = draft.platforms.find(id => !draft.events[id]?.length);
    if (silent)
      return toastError(
        'Not published',
        `Pick at least one event on ${silent}, or turn ${silent} off.`,
      );
    const integrations: NonNullable<AgentDefinition['integrations']> = {};
    for (const id of draft.platforms)
      integrations[id] = {
        events: eventsFor(
          agent?.definition?.integrations?.[id],
          draft.events[id] ?? [],
          draft.match[id] ?? {},
        ),
        tools: draft.tools[id],
      };
    const definition: AgentDefinition = {
      ...agent?.definition,
      integrations,
      permissions: draft.permissions,
    };
    for (const key of ['name', 'description', 'engine', 'model', 'effort'] as const) {
      const value = draft[key].trim();
      if (value) (definition as Record<string, unknown>)[key] = value;
      else delete (definition as Record<string, unknown>)[key];
    }
    const id = creating ? draft.id : agent.id;
    const name = draft.name.trim();
    await action.run('publish', async () => {
      const files = agent?.files;
      const { apps = [] } = await client.agents.put(id, {
        definition,
        ...(files ? { files } : {}),
        systemPrompt: draft.systemPrompt,
        ...(name ? { name } : {}),
        ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
      });
      for (const app of apps) {
        const platform = catalog.find(info => info.id === app.integration)?.name ?? app.integration;
        if (app.updated)
          showToast(`${platform} app updated`, `${app.name} now matches the agent.`, 'success');
        if (app.error) toastError(`${platform} app not updated`, app.error);
      }
      // Apps that need changes on their platform open there, one dialog each.
      const update = apps.filter(app => app.drift).map(app => app.id);
      if (update.length)
        nav.push('/dash/[org]/agents/[slug]/platforms', {
          params: { org, slug: id },
          search: { update: update.join(',') },
        });
      else if (creating && draft.platforms.length)
        nav.push('/dash/[org]/agents/[slug]/platforms', { params: { org, slug: id } });
      else nav.push('/dash/[org]/agents/[slug]', { params: { org, slug: id } });
    });
  };

  const actions = (
    <>
      {creating ? (
        <Button
          variant="outline"
          aria-pressed={template === 'import'}
          onClick={() => pickTemplate('import')}
        >
          Import from repo
        </Button>
      ) : null}
      {creating ? null : (
        <LinkButton
          variant="ghost"
          href="/dash/[org]/agents/[slug]"
          params={{ org, slug: agent.id }}
        >
          Cancel
        </LinkButton>
      )}
      <Button
        type="submit"
        leftIcon={creating ? iPlus : iUpload}
        disabled={!draft.name.trim() || template === 'import'}
        loading={busy}
      >
        {creating ? 'Create agent' : 'Publish new version'}
      </Button>
    </>
  );
  const head = creating ? (
    <PageHead
      {...HEADS.newAgent}
      back={<Back href="/dash/[org]/agents" params={{ org }} label="Agents" />}
      actions={actions}
    />
  ) : (
    <Hero
      agent={agent}
      back={
        <Back
          href="/dash/[org]/agents/[slug]"
          params={{ org, slug: agent.id }}
          label={agent.name}
        />
      }
      actions={actions}
    />
  );

  const templates = creating ? (
    <div class="templates" role="radiogroup" aria-label="Start from">
      {TEMPLATES.map(([key, label, hint]) => (
        <button
          key={key}
          type="button"
          role="radio"
          aria-checked={template === key}
          class="tile"
          onClick={() => pickTemplate(key)}
        >
          <b>{label}</b>
          <small>{hint}</small>
        </button>
      ))}
    </div>
  ) : null;

  if (template === 'import' && creating)
    return (
      <div class="agent-new">
        {head}
        {templates}
        <ImportPicker
          connected={connected}
          connectLabel={connectLabel}
          tunnel={tunnel}
          port={port}
        />
      </div>
    );

  const needle = query.trim().toLowerCase();
  const matches = catalog.filter(info =>
    `${info.id} ${info.description}`.toLowerCase().includes(needle),
  );
  // Featured and picked platforms first.
  const upFront = (info: (typeof catalog)[number]) =>
    !!info.featured || draft.platforms.includes(info.id);
  const shown = [...matches.filter(upFront), ...matches.filter(info => !upFront(info))];
  return (
    <form
      class="agent-new"
      onSubmit={event => {
        event.preventDefault();
        void submit();
      }}
    >
      {head}
      {templates}
      <div class="agent-form">
        <div class="agent-main">
          <section id="agent-name" class="form-part">
            <h2>Name and description</h2>
            <div class="fields">
              <Field label="Name" hint="its handle on every platform">
                <span class="with-btn">
                  <input
                    name="name"
                    required
                    value={draft.name}
                    onInput={event => rename(event.currentTarget.value)}
                  />
                  {creating ? (
                    <Button
                      variant="outline"
                      leftIcon={iShuffle}
                      title="Suggest another name"
                      onClick={() => rename(suggestName())}
                    >
                      Suggest
                    </Button>
                  ) : null}
                </span>
              </Field>
              {creating ? (
                <Field label="Id" hint="the folder and command name">
                  <input
                    class="mono"
                    name="id"
                    required
                    pattern="[a-z0-9][a-z0-9_\-]*"
                    autocomplete="off"
                    value={draft.id}
                    onInput={event => {
                      setIdTouched(true);
                      set('id', event.currentTarget.value);
                    }}
                  />
                </Field>
              ) : (
                <div class="field">
                  <span>
                    Id <small>fixed once created</small>
                  </span>
                  <p class="fixed mono">{agent.id}</p>
                </div>
              )}
            </div>
            <Field label="Description" hint="optional, shown in lists and added to the prompt">
              <input
                name="description"
                maxLength={240}
                placeholder="Answers engineering questions about acme/app."
                value={draft.description}
                onInput={event => set('description', event.currentTarget.value)}
              />
            </Field>
          </section>

          <section id="agent-instructions" class="form-part">
            <div class="part-head">
              <h2>Instructions</h2>
              <Segmented
                label="Instructions view"
                options={[
                  ['write', 'Write'],
                  ['preview', 'Preview'],
                ]}
                value={writing}
                onChange={setWriting}
              />
            </div>
            {writing === 'write' ? (
              <textarea
                name="systemPrompt"
                rows={10}
                aria-label="Instructions"
                placeholder={
                  'Markdown. The system prompt every task starts from.\nYou answer questions about acme/app from its source. Cite file paths.'
                }
                value={draft.systemPrompt}
                onInput={event => set('systemPrompt', event.currentTarget.value)}
              />
            ) : (
              <div class="body md md-preview">
                {draft.systemPrompt.trim() ? (
                  markdown(draft.systemPrompt)
                ) : (
                  <p class="muted">Nothing written yet.</p>
                )}
              </div>
            )}
          </section>

          <section id="agent-platforms" class="form-part">
            <div
              class="part-head"
              onKeyDown={event => event.key === 'Enter' && event.preventDefault()}
            >
              <h2>Handles</h2>
              {catalog.length > SEARCH_FROM ? (
                <Search value={query} label="Search platforms" onInput={setQuery} />
              ) : null}
            </div>
            <p class="muted">
              Each platform becomes the agent's handle there: its own app, set up on the next page,
              where <span class="semi">@mentions</span> and events start tasks. The dashboard, the
              CLI and the SDK can always start it.
            </p>
            <p class="muted">
              <b>Connections</b> are separate and shared by all agents: add as many as tasks need,
              like an API key, an MCP server or a member's own account, in{' '}
              <Link
                class="link"
                href="/dash/[org]/settings/[tab]"
                params={{ org, tab: 'connections' }}
              >
                Settings
              </Link>
              .
            </p>
            <ul class="listen">
              {shown.map(info => {
                const on = draft.platforms.includes(info.id);
                const ticked = draft.events[info.id] ?? [];
                const events = Object.entries(info.events);
                return (
                  <li key={info.id} class={on ? 'on' : undefined}>
                    <label class="listen-row">
                      <span class="pf-mark" aria-hidden="true">
                        <BrandIcon brand={info.brand} />
                      </span>
                      <span class="grow">
                        <b>{info.name}</b>
                        <small title={info.description}>{info.description}</small>
                      </span>
                      <input
                        type="checkbox"
                        role="switch"
                        class="switch"
                        name="platform"
                        value={info.id}
                        checked={on}
                        onChange={event => togglePlatform(info.id, event.currentTarget.checked)}
                      />
                    </label>
                    {on ? (
                      <div class="events">
                        <Chips label={`What wakes it on ${info.id}`}>
                          {events.map(([event, spec]) => {
                            const pressed = ticked.includes(event);
                            return (
                              <Chip
                                key={event}
                                aria-pressed={pressed}
                                title={spec.description}
                                onClick={() => toggleEvent(info.id, event, !pressed)}
                              >
                                {event.replace(/_/g, ' ')}
                              </Chip>
                            );
                          })}
                        </Chips>
                        {events
                          .filter(([event, spec]) => spec.noisy && ticked.includes(event))
                          .map(([event]) => (
                            <label key={event} class="match">
                              <span>{event.replace(/_/g, ' ')}</span>
                              <input
                                class="mono"
                                name={`match:${info.id}:${event}`}
                                placeholder="only when the text matches, like ^help\b"
                                aria-label={`Text filter for ${event} on ${info.id}`}
                                value={draft.match[info.id]?.[event] ?? ''}
                                onInput={e => setMatch(info.id, event, e.currentTarget.value)}
                              />
                            </label>
                          ))}
                      </div>
                    ) : null}
                  </li>
                );
              })}
              {shown.length ? null : <li class="listen-none muted">No platform matches.</li>}
            </ul>
            {levels.length ? (
              <Field
                label="Platform access"
                hint={ACCESS[level]?.[1] ?? 'differs between platforms'}
                group
              >
                <Segmented
                  label="Platform access"
                  options={levels.map(preset => [preset, ACCESS[preset]![0]])}
                  value={level}
                  onChange={preset =>
                    set('tools', Object.fromEntries(draft.platforms.map(id => [id, preset])))
                  }
                />
              </Field>
            ) : null}
          </section>

          <details id="agent-run" class="form-part run" open={section === 'run'}>
            <summary>
              <h2>Run settings</h2>
              <span class="grow muted">{run}</span>
              <Icon d={iDown} />
            </summary>
            <div class="run-body">
              <div class="fields">
                <Field label="Engine and model" hint="what runs each task" group>
                  <Select
                    label="Model"
                    value={modelValue(draft.engine, draft.model)}
                    options={modelOptions(models, defaultLabel(fallback))}
                    headings={modelHeadings(models)}
                    action={{
                      label: 'Add models',
                      icon: iPlus,
                      onPick: () =>
                        nav.push('/dash/[org]/settings/[tab]', { params: { org, tab: 'models' } }),
                    }}
                    onChange={value => setDraft(current => ({ ...current, ...splitModel(value) }))}
                  />
                </Field>
                <Field label="Effort" hint="how hard the model thinks" group>
                  <Segmented
                    label="Effort"
                    options={[['', defaultLabel(base.effort)], ...EFFORTS]}
                    value={draft.effort}
                    onChange={value => set('effort', value)}
                  />
                </Field>
              </div>
              <Field label="Repository access" hint={PERMISSION_HINTS[draft.permissions]} group>
                <Segmented
                  label="Repository access"
                  options={PERMISSIONS}
                  value={draft.permissions}
                  onChange={value => set('permissions', value)}
                />
              </Field>
            </div>
          </details>
        </div>

        <aside class="agent-side" aria-label="Preview">
          <span class="side-label">Preview</span>
          <div class="agent-card preview">
            <div class="bc-head">
              <span class="mark">{initial(draft.name)}</span>
              <div class="grow">
                <h3>{draft.name.trim() || 'Unnamed agent'}</h3>
                <span class="pills">
                  <Badge>dashboard</Badge>
                  {agent?.local ? null : <Badge>v{creating ? 1 : agent.currentVersion + 1}</Badge>}
                  {agent?.settings?.disabled ? <DisabledBadge /> : null}
                </span>
              </div>
            </div>
            <div class="lead-clamp">
              <span>{draft.description.trim() || 'No description yet.'}</span>
            </div>
            {draft.platforms.length ? (
              <PlatformLine
                platforms={draft.platforms.map(id => ({ id, state: 'none' as const }))}
                catalog={catalog}
              />
            ) : (
              <span class="pfs muted">No handles yet</span>
            )}
          </div>
        </aside>
      </div>
    </form>
  );
}
