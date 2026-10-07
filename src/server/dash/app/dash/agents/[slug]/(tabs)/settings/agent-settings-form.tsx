'use client';

import './agent-settings-form.css';

import { useLayoutEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import type { AgentRow, AgentSettings } from '@coder/client/types';
import { reasonText } from '@/utils/format';
import { ErrorText, Field } from '@/comps/ui/field';
import { Chips } from '@/comps/ui/badge';
import { Select, type Option } from '@/comps/ui/select';
import { Search } from '@/comps/ui/toolbar';
import {
  ENGINE_NAMES,
  defaultLabel,
  modelHeadings,
  modelOptions,
  modelValue,
  splitModel,
} from '@/app/dash/settings/model-options';
import type { Defaults } from '@/app/dash/tasks/composer';

const EFFORTS = ['low', 'medium', 'high'];
const PERMISSIONS = ['read-only', 'workspace-write', 'auto'];
const PRESETS = ['observe', 'comment', 'write'];

const eventNames = (events: unknown): string[] =>
  Array.isArray(events)
    ? events.map(String)
    : events && typeof events === 'object'
      ? Object.keys(events)
      : [];

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
  options: string[];
  blank: string;
}) {
  const list = value && !options.includes(value) ? [...options, value] : options;
  return (
    <Field label={label} hint={hint} group>
      <Select
        name={name}
        label={label}
        defaultValue={value ?? ''}
        options={[['', blank], ...list.map((option): Option => [option, option])]}
      />
    </Field>
  );
}

/** How this agent runs here: engine settings, then one tab per platform to narrow access and events. One Save. */
export function AgentSettingsForm({
  agent,
  models,
  defaults,
  runners,
}: {
  agent: AgentRow;
  models: Record<string, string[]>;
  defaults: Defaults;
  runners: Option[];
}) {
  const [panel, setPanel] = useState(0);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<number[]>();
  const form = useRef<HTMLFormElement>(null);
  const settings = agent.settings ?? {};
  const [model, setModel] = useState(modelValue(settings.engine, settings.model));
  const declared = agent.definition?.integrations ?? {};
  const platforms = Object.keys(declared).sort();
  const own = agent.definition;
  const engine = own?.engine ?? defaults.engine;

  // Filters every panel's fields by label and current value, and moves to a panel that has a match.
  useLayoutEffect(() => {
    const needle = query.trim().toLowerCase();
    const found: number[] = [];
    form.current!.querySelectorAll('.vpanel').forEach((section, index) => {
      let any = false;
      section.querySelectorAll<HTMLElement>('.field').forEach(field => {
        const values = [...field.querySelectorAll('input')].map(input => input.value).join(' ');
        const match = !needle || `${field.textContent} ${values}`.toLowerCase().includes(needle);
        field.hidden = !match;
        any ||= match;
      });
      if (any) found.push(index);
    });
    setHits(needle ? found : undefined);
    if (needle && found.length && !found.includes(panel)) setPanel(found[0]!);
  }, [query]);

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
    for (const id of platforms) {
      const current = settings.integrations?.[id] ?? {};
      const entry: NonNullable<AgentSettings['integrations']>[string] = {};
      if (Array.isArray(current.allowedTools)) entry.allowedTools = current.allowedTools;
      else if (text(`tools:${id}`)) entry.allowedTools = text(`tools:${id}`);
      const names = eventNames(declared[id]?.triggers);
      const picked = values.getAll(`event:${id}`).map(String);
      if (names.length && picked.length < names.length) entry.allowedEvents = picked;
      if (Object.keys(entry).length) (next.integrations ??= {})[id] = entry;
    }
    setBusy(true);
    setError('');
    setSaved('');
    try {
      await client.agents.settings(agent.id, next);
      setSaved('Saved. New tasks use these settings.');
    } catch (reason) {
      setError(reasonText(reason));
    }
    setBusy(false);
  };

  return (
    <form ref={form} class="vsettings card frame" onSubmit={submit}>
      <nav class="tabs vertical" aria-label="Settings sections">
        <p class="tabs-label">Runtime</p>
        <button
          type="button"
          aria-current={panel === 0 ? 'true' : undefined}
          class={hits && !hits.includes(0) ? 'miss' : undefined}
          onClick={() => setPanel(0)}
        >
          How it runs
        </button>
        {platforms.length ? <p class="tabs-label">Platforms</p> : null}
        {platforms.map((id, index) => (
          <button
            key={id}
            type="button"
            aria-current={panel === index + 1 ? 'true' : undefined}
            class={hits && !hits.includes(index + 1) ? 'miss' : undefined}
            onClick={() => setPanel(index + 1)}
          >
            {id}
          </button>
        ))}
      </nav>
      <div class="vbody">
        <div class="vsearch">
          <Search value={query} label="Search settings" onInput={setQuery} />
          {hits && !hits.length ? <span class="muted">No setting matches.</span> : null}
        </div>
        <section class="vpanel" hidden={panel !== 0}>
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
          </div>
        </section>
        {platforms.map((id, index) => {
          const current = settings.integrations?.[id] ?? {};
          const names = eventNames(declared[id]?.triggers);
          const allowed = current.allowedEvents;
          const tools = declared[id]?.tools;
          return (
            <section key={id} class="vpanel" hidden={panel !== index + 1}>
              <h2>{id}</h2>
              <p class="muted">
                Narrow what the agent does here. Only the events its definition declares can be
                picked.
              </p>
              {Array.isArray(current.allowedTools) ? (
                <div class="field">
                  <span>Platform access</span>
                  <Chips values={current.allowedTools} />
                </div>
              ) : (
                <Choice
                  name={`tools:${id}`}
                  label="Platform access"
                  hint="observe reads, comment also replies, write also pushes and merges"
                  value={
                    typeof current.allowedTools === 'string' ? current.allowedTools : undefined
                  }
                  options={PRESETS}
                  blank={defaultLabel(
                    typeof tools === 'string' ? tools : tools ? 'custom' : 'observe',
                  )}
                />
              )}
              {names.length ? (
                <div class="field">
                  <span>
                    Events <small>all declared events unless you narrow it</small>
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
            </section>
          );
        })}
        <div class="form-actions save">
          <button class="btn" disabled={busy}>
            Save
          </button>
          <ErrorText value={error} />
          {saved ? (
            <span class="flash" role="status">
              {saved}
            </span>
          ) : null}
        </div>
      </div>
    </form>
  );
}
