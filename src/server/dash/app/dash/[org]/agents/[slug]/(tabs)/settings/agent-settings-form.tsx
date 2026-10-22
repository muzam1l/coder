'use client';

import './agent-settings-form.css';

import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { useRouter } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import { Link } from '@wular/pnext/link';
import { editableAgent, eventNames } from '@/api/types';
import { ConfirmDialog } from '@/comps/ui/confirm';
import type { AgentRow, AgentSettings, ConnectionRow, IntegrationInfo } from '@coder/client/types';
import { BrandIcon } from '@/app/dash/[org]/agents/agent/agent-pills';
import { AgentToggle } from '@/app/dash/[org]/agents/agent/agent-toggle';
import { Field } from '@/comps/ui/field';
import { Button } from '@/comps/ui/button';
import { Select, type Option } from '@/comps/ui/select';
import { Search } from '@/comps/ui/toolbar';
import {
  ACCESS,
  EFFORTS,
  ENGINE_NAMES,
  defaultLabel,
  modelHeadings,
  modelOptions,
  modelValue,
  splitModel,
} from '@/app/dash/[org]/settings/model-options';
import type { Defaults } from '@/app/dash/[org]/tasks/composer';

function Choice({
  name,
  label,
  hint,
  value,
  options,
  blank,
}: {
  name: string;
  label: string;
  hint?: string;
  value?: string;
  options: Option[];
  blank: string;
}) {
  const list: Option[] =
    value && !options.some(([key]) => key === value) ? [...options, [value, value]] : options;
  return (
    <Field label={label} hint={hint} group>
      <Select
        name={name}
        label={label}
        defaultValue={value ?? ''}
        options={[['', blank], ...list]}
      />
    </Field>
  );
}

type Panel = 'run' | 'platforms' | 'manage';

/** How this agent runs here: engine settings and access, every platform's events on one panel, and deleting it. One Save. */
export function AgentSettingsForm({
  agent,
  catalog,
  models,
  defaults,
  runners,
  connections,
}: {
  agent: AgentRow;
  catalog: IntegrationInfo[];
  models: Record<string, string[]>;
  defaults: Defaults;
  runners: Option[];
  /** The workspace's connections, to narrow. */
  connections: ConnectionRow[];
}) {
  const nav = useRouter();
  const org = useOrg();
  const [panel, setPanel] = useState<Panel>('run');
  const action = useAction({ refresh: true });
  const removing = useAction({ leaves: true });
  const busy = Boolean(action.pending);
  const [saved, setSaved] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Panel[]>();
  const [deleting, setDeleting] = useState(false);
  const form = useRef<HTMLFormElement>(null);
  const settings = agent.settings ?? {};
  const [model, setModel] = useState(modelValue(settings.engine, settings.model));
  const [narrowed, setNarrowed] = useState(settings.connections ? 'some' : '');
  const declared = agent.definition?.integrations ?? {};
  const platforms = Object.keys(declared).sort();
  const own = agent.definition;
  const engine = own?.engine;
  const deletable = agent.source !== 'builtin';
  const modelChoices: Option[] = [
    ...modelOptions(
      models,
      defaultLabel(
        engine
          ? [ENGINE_NAMES[engine] ?? engine, own?.model ?? defaults.engines[engine]?.model]
              .filter(Boolean)
              .join(' · ')
          : 'first available engine',
      ),
    ),
    ...(!settings.engine && settings.model
      ? [[modelValue(undefined, settings.model), settings.model] as Option]
      : []),
  ];
  const unrunnable = Object.fromEntries(
    modelChoices.flatMap(([value]) => {
      const runs = splitModel(value).engine;
      const hint =
        runs === 'custom' ? 'needs its API key' : `needs a ${ENGINE_NAMES[runs]} credential`;
      return runs && (agent.unrunnable?.includes(runs) || agent.unrunnable?.includes(value))
        ? [[value, hint]]
        : [];
    }),
  );

  // Filters every panel's fields by label, current value and platform, and moves to a panel that has a match.
  useLayoutEffect(() => {
    const needle = query.trim().toLowerCase();
    const found: Panel[] = [];
    form.current!.querySelectorAll<HTMLElement>('.vpanel').forEach(section => {
      let any = false;
      section.querySelectorAll<HTMLElement>('.field').forEach(field => {
        const values = [...field.querySelectorAll('input')].map(input => input.value).join(' ');
        const platform = field.closest('.vplatform')?.querySelector('h3')?.textContent ?? '';
        const match =
          !needle || `${platform} ${field.textContent} ${values}`.toLowerCase().includes(needle);
        field.hidden = !match;
        any ||= match;
      });
      section.querySelectorAll<HTMLElement>('.vplatform').forEach(block => {
        block.hidden = !block.querySelector('.field:not([hidden])');
      });
      if (any) found.push(section.dataset.panel as Panel);
    });
    setHits(needle ? found : undefined);
    if (needle && found.length && !found.includes(panel)) setPanel(found[0]!);
  }, [query]);

  const remove = () =>
    void removing
      .run('delete', async () => {
        await client.agents.remove(agent.id);
        nav.push('/dash/[org]/agents', { params: { org } });
      })
      .then(ok => ok || setDeleting(false));

  const tab = (key: Panel, label: string) => (
    <button
      type="button"
      aria-current={panel === key ? 'true' : undefined}
      class={hits && !hits.includes(key) ? 'miss' : undefined}
      onClick={() => setPanel(key)}
    >
      {label}
    </button>
  );

  const submit = async (event: SubmitEvent) => {
    event.preventDefault();
    const values = new FormData(event.currentTarget as HTMLFormElement);
    const text = (key: string) => String(values.get(key) ?? '').trim();
    const next: Omit<AgentSettings, 'engine'> = {};
    for (const key of ['effort', 'runner'] as const) if (text(key)) next[key] = text(key);
    if (text('access') !== (own?.access ?? 'auto'))
      next.access = text('access') as AgentSettings['access'];
    const picked = splitModel(model);
    const selected =
      picked.model || defaults.engines[picked.engine]?.model ||
      (models[picked.engine]?.length === 1 ? models[picked.engine]?.[0] : undefined);
    if (picked.engine && !selected) return setSaved('Choose a model.');
    if (selected) next.model = picked.engine ? `${picked.engine}:${selected}` : selected;
    if (narrowed) next.connections = values.getAll('connection').map(String);
    for (const id of platforms) {
      const entry: NonNullable<AgentSettings['integrations']>[string] = {};
      const names = eventNames(declared[id]?.events);
      const picked = values.getAll(`event:${id}`).map(String);
      if (names.length && picked.length < names.length) entry.allowedEvents = picked;
      if (Object.keys(entry).length) (next.integrations ??= {})[id] = entry;
    }
    if (agent.settings?.disabled) next.disabled = true;
    setSaved('');
    if (await action.run('save', () => client.agents.settings(agent.id, next)))
      setSaved('Saved. New tasks use these settings.');
  };

  return (
    <form ref={form} class="vsettings card frame" onSubmit={submit}>
      <nav class="tabs vertical" aria-label="Settings sections">
        <p class="tabs-label">Runtime</p>
        {tab('run', 'How it runs')}
        {platforms.length ? tab('platforms', 'Platforms') : null}
        <p class="tabs-label">Agent</p>
        {tab('manage', 'Manage')}
      </nav>
      <div class="vbody">
        <div class="vsearch">
          <Search value={query} label="Search settings" onInput={setQuery} />
          {hits && !hits.length ? <span class="muted">No setting matches.</span> : null}
        </div>
        <section class="vpanel" data-panel="run" hidden={panel !== 'run'}>
          <h2>How it runs</h2>
          <p class="muted">Anything left on Default follows the agent's own definition.</p>
          <div class="fields">
            <Field label="Model" hint="picking a model picks its engine" group>
              <Select
                label="Model"
                value={model}
                options={modelChoices}
                unavailable={unrunnable}
                headings={modelHeadings(models)}
                onChange={setModel}
              />
            </Field>
            <Choice
              name="effort"
              label="Effort"
              value={settings.effort}
              options={EFFORTS}
              blank={defaultLabel(
                own?.effort ?? defaults.engines[(splitModel(model).engine ?? engine)!]?.effort,
              )}
            />
            <Field label="Access" hint="what its tasks, platforms and connections may do" group>
              <Select
                name="access"
                label="Access"
                defaultValue={settings.access ?? own?.access ?? 'auto'}
                options={
                  own?.access === 'read-only'
                    ? ACCESS.filter(([value]) => value === 'read-only')
                    : ACCESS
                }
              />
            </Field>
            {runners.length > 1 ? (
              <Field label="Runs on" group>
                <Select
                  name="runner"
                  label="Runs on"
                  defaultValue={settings.runner ?? ''}
                  options={runners}
                />
              </Field>
            ) : null}
            <Field label="Connections" hint="which workspace connections its tasks can use" group>
              <Select
                label="Connections"
                value={narrowed}
                options={[
                  ['', 'Every workspace connection'],
                  ['some', 'Only the ones picked'],
                ]}
                onChange={setNarrowed}
              />
            </Field>
            {narrowed ? (
              <div class="field picked">
                <span>
                  Picked connections <small>tasks can use only these</small>
                </span>
                {connections.length ? (
                  <div class="checks">
                    {connections.map(row => (
                      <label key={row.id} class="check">
                        <input
                          type="checkbox"
                          name="connection"
                          value={row.id}
                          defaultChecked={settings.connections?.includes(row.id)}
                        />
                        {row.name}
                      </label>
                    ))}
                  </div>
                ) : (
                  <span class="muted">
                    This workspace has no connections yet.{' '}
                    <Link
                      class="link"
                      href="/dash/[org]/settings/[tab]"
                      params={{ org, tab: 'connections' }}
                    >
                      Add one in Settings
                    </Link>
                  </span>
                )}
              </div>
            ) : null}
          </div>
        </section>
        {platforms.length ? (
          <section class="vpanel" data-panel="platforms" hidden={panel !== 'platforms'}>
            <h2>Platforms</h2>
            <p class="muted">
              Turn events off for this workspace.{' '}
              {editableAgent(agent) ? (
                <>
                  To add an event or a platform,{' '}
                  <Link
                    href="/dash/[org]/agents/[slug]/edit"
                    params={{ org, slug: agent.id }}
                    search={{ section: 'platforms' }}
                  >
                    edit {agent.name}
                  </Link>
                  .
                </>
              ) : agent.source === 'repo' ? (
                <>
                  {agent.name} comes from {agent.repo ?? 'a repository'}; add an event or a platform
                  in its{' '}
                  {agent.sourceUrl ? (
                    <a href={agent.sourceUrl} target="_blank" rel="noreferrer">
                      agent.json
                    </a>
                  ) : (
                    'agent.json'
                  )}{' '}
                  there.
                </>
              ) : (
                <>
                  {agent.name} is built in, so its events and platforms ship with Coder. To listen
                  anywhere else,{' '}
                  <Link href="/dash/[org]/agents/new" params={{ org }}>
                    create your own agent
                  </Link>
                  .
                </>
              )}
            </p>
            {platforms.map(id => {
              const current = settings.integrations?.[id] ?? {};
              const names = eventNames(declared[id]?.events);
              const allowed = current.allowedEvents;
              const info = catalog.find(entry => entry.id === id);
              return (
                <div key={id} class="vplatform">
                  <h3>
                    {info ? <BrandIcon brand={info.brand} /> : null}
                    {info?.name ?? id}
                  </h3>
                  {names.length ? (
                    <div class="field">
                      <span>
                        Events{' '}
                        <small>the definition's events; turn off any it should ignore here</small>
                      </span>
                      <div class="checks">
                        {names.map(name => (
                          <label key={name} class="check">
                            <input
                              type="checkbox"
                              name={`event:${id}`}
                              value={name}
                              defaultChecked={!allowed || allowed.includes(name)}
                            />
                            {name}
                          </label>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              );
            })}
          </section>
        ) : null}
        <section class="vpanel" data-panel="manage" hidden={panel !== 'manage'}>
          <h2>Manage</h2>
          <div class="field row-action">
            <span>
              Disable agent
              <small>
                stops its events and new tasks in this workspace; its apps and tasks stay
              </small>
            </span>
            <AgentToggle agent={agent} />
          </div>
          <div class="field row-action">
            <span>
              Delete agent
              <small>
                {deletable
                  ? 'removes it and every version; its tasks and platform apps stay'
                  : `${agent.name} is built in and cannot be deleted; disable it above instead`}
              </small>
            </span>
            <Button
              variant="secondary"
              danger
              disabled={!deletable}
              onClick={() => setDeleting(true)}
            >
              Delete agent
            </Button>
          </div>
        </section>

        {panel === 'manage' ? null : (
          <div class="form-actions save">
            {saved ? (
              <span class="flash" role="status">
                {saved}
              </span>
            ) : null}
            <Button type="submit" loading={busy}>
              Save
            </Button>
          </div>
        )}
      </div>
      {deleting ? (
        <ConfirmDialog
          open
          title={`Delete ${agent.name}?`}
          body="It stops answering on every platform. This cannot be undone."
          confirmLabel="Delete agent"
          busy={Boolean(removing.pending)}
          onClose={() => setDeleting(false)}
          onConfirm={remove}
        />
      ) : null}
    </form>
  );
}
