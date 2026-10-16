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
import { Chips } from '@/comps/ui/badge';
import { Select, type Option } from '@/comps/ui/select';
import { Search } from '@/comps/ui/toolbar';
import {
  EFFORTS,
  ENGINE_NAMES,
  PERMISSIONS,
  defaultLabel,
  modelHeadings,
  modelOptions,
  modelValue,
  splitModel,
} from '@/app/dash/[org]/settings/model-options';
import type { Defaults } from '@/app/dash/[org]/tasks/composer';

const PRESETS = ['observe', 'comment', 'write'].map((preset): Option => [preset, preset]);

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

/** How this agent runs here: engine settings, every platform's access and events on one panel, and deleting it. One Save. */
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
  const engine = own?.engine ?? defaults.engine;
  const deletable = agent.source !== 'builtin';

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
    const next: AgentSettings = {};
    for (const key of ['effort', 'permissions', 'runner'] as const)
      if (text(key)) next[key] = text(key);
    const picked = splitModel(model);
    if (picked.engine) next.engine = picked.engine;
    if (picked.model) next.model = picked.model;
    if (narrowed) next.connections = values.getAll('connection').map(String);
    for (const id of platforms) {
      const current = settings.integrations?.[id] ?? {};
      const entry: NonNullable<AgentSettings['integrations']>[string] = {};
      if (Array.isArray(current.allowedTools)) entry.allowedTools = current.allowedTools;
      else if (text(`tools:${id}`)) entry.allowedTools = text(`tools:${id}`);
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
                options={[
                  ...modelOptions(
                    models,
                    defaultLabel(
                      [
                        ENGINE_NAMES[engine] ?? engine,
                        own?.model ?? defaults.engines[engine]?.model,
                      ]
                        .filter(Boolean)
                        .join(' · '),
                    ),
                  ),
                  ...(!settings.engine && settings.model
                    ? [[modelValue(undefined, settings.model), settings.model] as Option]
                    : []),
                ]}
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
                own?.effort ?? defaults.engines[splitModel(model).engine ?? engine]?.effort,
              )}
            />
            <Choice
              name="permissions"
              label="Permissions"
              hint="what the runner may change in the checkout"
              value={settings.permissions}
              options={PERMISSIONS}
              blank={defaultLabel(own?.permissions ?? 'read-only')}
            />
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
              Overrides for this workspace: turn events off or lower access.{' '}
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
              const tools = declared[id]?.tools;
              const info = catalog.find(entry => entry.id === id);
              return (
                <div key={id} class="vplatform">
                  <h3>
                    {info ? <BrandIcon brand={info.brand} /> : null}
                    {info?.name ?? id}
                  </h3>
                  {Array.isArray(current.allowedTools) ? (
                    <div class="field">
                      <span>Platform access</span>
                      <Chips values={current.allowedTools} />
                    </div>
                  ) : (
                    <Choice
                      name={`tools:${id}`}
                      label="Platform access"
                      hint={`observe reads, comment also replies, write also pushes and merges; at most ${typeof tools === 'string' ? tools : tools ? 'its tools' : 'observe'}, as the definition grants`}
                      value={
                        typeof current.allowedTools === 'string' ? current.allowedTools : undefined
                      }
                      options={
                        typeof tools === 'string'
                          ? PRESETS.slice(0, PRESETS.findIndex(([key]) => key === tools) + 1)
                          : tools
                            ? PRESETS
                            : PRESETS.slice(0, 1)
                      }
                      blank={defaultLabel(
                        typeof tools === 'string' ? tools : tools ? 'custom' : 'observe',
                      )}
                    />
                  )}
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
