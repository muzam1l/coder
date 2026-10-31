'use client';

import './runners-list.css';

import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import {
  iActivity,
  iDots,
  iDown,
  iFirst,
  iGit,
  iMonitor,
  iPencil,
  iPlug,
  iPlus,
  iSpark,
  iTerminal,
  iTrash,
} from '@/comps/ui/icons';
import { Card, Loading } from '@/comps/ui/card';
import { Badge } from '@/comps/ui/badge';
import { Button } from '@/comps/ui/button';
import { CopyButton, CopyLine } from '@/comps/ui/copy';
import { Field, SecretInput } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuItem } from '@/comps/ui/menu-items';
import { Modal } from '@/comps/ui/modal';
import { Combo } from '@/comps/ui/combo';
import { Select } from '@/comps/ui/select';
import { ago, formatDuration } from '@/utils/format';
import { isAdmin } from '@/api/types';
import { sortedRunners } from '@/app/dash/[org]/tasks/composer-data';
import { useRunnerEvents } from '@/comps/frame/task-toasts';
import { useAddDialog, useRemove } from './list';
import { SCOPES } from '@/app/dash/[org]/settings/model-options';
import { useSearchParams } from '@wular/pnext/navigation/client';
import type { Me, RunnerKind, RunnerPairing, RunnerRow, RunnerSpec } from '@coder/client/types';

type Runners = { items: RunnerRow[]; catalog: RunnerSpec[] };
type Tested = { ok: boolean; detail: string; ms: number } | 'testing';

const KIND_ICONS: Record<RunnerKind, string> = {
  local: iMonitor,
  'local-docker': iTerminal,
  'vercel-sandbox': iSpark,
  'github-actions': iGit,
  http: iPlug,
};
const BUILT_IN = new Set(['default', 'local']);
const MACHINES = new Set<RunnerKind>(['local', 'http']);

function Status({ runner, tested }: { runner: RunnerRow; tested?: Tested }) {
  if (tested === 'testing')
    return (
      <span class="sub runner-status">
        <i class="dot" />
        Testing…
      </span>
    );
  if (tested)
    return (
      <span class={`sub runner-status ${tested.ok ? 'ok' : 'bad'}`}>
        <i class="dot" />
        {tested.ok ? `Reached in ${formatDuration(tested.ms)}` : tested.detail}
      </span>
    );
  // A machine calls home; the other kinds start per task, so their last passed check is what counts.
  if (!MACHINES.has(runner.kind) && !BUILT_IN.has(runner.id))
    return (
      <span class={`sub runner-status${runner.lastSeen ? ' ok' : ''}`}>
        <i class="dot" />
        {runner.lastSeen ? `Checked ${ago(runner.lastSeen)}` : 'Not checked yet'}
      </span>
    );
  return (
    <span class={`sub runner-status${runner.online ? ' ok' : ''}`}>
      <i class="dot" />
      {runner.online ? 'Online' : runner.lastSeen ? `Last seen ${ago(runner.lastSeen)}` : 'Offline'}
    </span>
  );
}

function RunnerItem({
  runner,
  manage,
  onChange,
}: {
  runner: RunnerRow;
  manage: boolean;
  onChange: (act: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [renaming, setRenaming] = useState(false);
  const [tested, setTested] = useState<Tested>();
  const rename = useRef<HTMLInputElement>(null);
  useEffect(() => rename.current?.select(), [renaming]);
  const builtIn = BUILT_IN.has(runner.id);
  const removing = useRemove(
    manage && !builtIn
      ? {
          title: `Remove ${runner.name}?`,
          body: 'Its tasks go to another runner.',
          link: runner.id,
          icon: iTrash,
          onRemove: () => onChange(() => client.runners.remove(runner.id)),
        }
      : undefined,
  );
  const test = () => {
    setTested('testing');
    client.runners.test(runner.id).then(setTested, reason => {
      setTested(undefined);
      toastFailure(reason);
    });
  };
  return (
    <tr>
      <td>
        <span class="row-title">
          <b class="runner-name">
            <Icon d={KIND_ICONS[runner.kind] ?? iPlug} />
            {renaming ? (
              <input
                class="runner-rename"
                aria-label="Runner name"
                defaultValue={runner.name}
                ref={rename}
                onKeyDown={event => {
                  const name = event.currentTarget.value.trim();
                  if (event.key === 'Escape') setRenaming(false);
                  if (event.key === 'Enter' && name)
                    void onChange(() => client.runners.update(runner.id, { name })).then(() =>
                      setRenaming(false),
                    );
                }}
                onBlur={() => setRenaming(false)}
              />
            ) : (
              runner.name
            )}
          </b>
          <span class="runner-badges">
            <Badge>{runner.scope}</Badge>
            {runner.default ? <Badge tone="acc">default</Badge> : null}
          </span>
        </span>
        <Status runner={runner} tested={tested} />
      </td>
      <td class="acts">
        {builtIn ? null : (
          <span class="row-acts">
            <Menu button="icon" label="Actions" summary={<Icon d={iDots} />}>
              {runner.default || !manage ? null : (
                <MenuItem
                  icon={iFirst}
                  title="Make default"
                  onClick={() =>
                    void onChange(() => client.runners.update(runner.id, { default: true }))
                  }
                />
              )}
              <MenuItem icon={iActivity} title="Test" onClick={test} />
              {manage ? (
                <MenuItem icon={iPencil} title="Rename" onClick={() => setRenaming(true)} />
              ) : null}
              {removing.item}
            </Menu>
          </span>
        )}
        {removing.dialog}
      </td>
    </tr>
  );
}

const TUNNELS = [
  {
    name: 'cloudflared',
    command: 'cloudflared tunnel --url http://localhost:4100',
    address: 'https://….trycloudflare.com',
  },
  { name: 'ngrok', command: 'ngrok http 4100', address: 'https://….ngrok-free.app' },
  { name: 'Tailscale Funnel', command: 'tailscale funnel 4100', address: 'https://….ts.net' },
];

/** A pairing in progress: install, open a tunnel, run the command with its address, then wait until the machine connects. */
function Pairing({ pairing, onCancel }: { pairing?: RunnerPairing; onCancel: () => void }) {
  const [tool, setTool] = useState(TUNNELS[0]!);
  const [tunnel, setTunnel] = useState('');
  // Only a bare https origin enters the shell command, so nothing typed can run there.
  const address = /^https:\/\/[\w.-]+(:\d+)?\/?$/.test(tunnel.trim()) ? tunnel.trim() : '';

  return (
    <div class="runner-pair">
      <details class="runner-step">
        <summary>Install the Coder CLI on that computer, if it is not there yet</summary>
        <CopyLine value="npm install -g @wular/coder" />
      </details>
      <div class="runner-step">
        <div class="runner-step-head">
          <p>Open a tunnel to its port 4100, so this server can reach it over HTTPS.</p>
          <Select
            label="Tunnel"
            options={TUNNELS.map(({ name }): [string, string] => [name, name])}
            value={tool.name}
            onChange={name => setTool(TUNNELS.find(each => each.name === name)!)}
          />
        </div>
        <CopyLine value={tool.command} />
      </div>
      <div class="runner-step">
        <Field
          label="Tunnel address"
          hint={
            tunnel.trim() && !address
              ? 'an https:// address, like the tunnel printed'
              : 'the HTTPS address the tunnel printed'
          }
          required
        >
          <input
            type="url"
            placeholder={tool.address}
            autocomplete="off"
            value={tunnel}
            onInput={event => setTunnel(event.currentTarget.value)}
          />
        </Field>
      </div>
      <div class="runner-step">
        <p>Run this there. The token works once and expires in 15 minutes.</p>
        {pairing ? (
          <CopyLine
            value={pairing.command.replace('<tunnel address>', address || '<tunnel address>')}
          />
        ) : (
          <div class="copy-line">
            <Loading label="Creating a one-time token" inline dots />
          </div>
        )}
      </div>
      <div class="runner-wait">
        <Loading label="Waiting for that computer to connect" inline dots />
        <Button variant="secondary" danger size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

/** A kind set up by fields: required ones in the first rows, optional ones folded; listed ones offer what the filled fields reach, like a token's teams. */
function FieldsForm({
  spec,
  name,
  who,
}: {
  spec: RunnerSpec;
  name?: string;
  /** Who can use the runner, beside the required fields. */
  who?: ComponentChildren;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [listed, setListed] = useState<{
    options?: Record<string, string[]>;
    loading?: boolean;
    failed?: boolean;
  }>({});
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const round = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  const required = spec.fields.filter(field => !field.optional);
  const listedFields = spec.fields.filter(field => field.optional && field.listed);
  const folded = spec.fields.filter(field => field.optional && !field.listed);

  // The listed fields refresh once the required typed fields are filled, after 250 ms of quiet, like the models probe.
  const refresh = (next: Record<string, string>, wait = 250) => {
    clearTimeout(timer.current);
    const ask = ++round.current;
    if (spec.fields.some(field => !field.optional && !field.listed && !next[field.key]))
      return setListed({});
    setListed(now => ({ ...now, loading: true }));
    timer.current = setTimeout(() => {
      const config = Object.fromEntries(Object.entries(next).filter(([, each]) => each));
      client.runners.options({ kind: spec.kind, config }).then(
        options => ask === round.current && setListed({ options }),
        reason => {
          if (ask !== round.current) return;
          console.error('Runner options failed', reason);
          setListed({ failed: true });
        },
      );
    }, wait);
  };

  // Only what feeds a list refreshes it: a required typed field, like a token, or a listed one before the last, like a team.
  const feeds = (key: string) => {
    const keys = spec.fields.filter(field => field.listed).map(field => field.key);
    const field = spec.fields.find(each => each.key === key);
    return field?.listed
      ? keys.indexOf(key) < keys.length - 1
      : Boolean(keys.length && !field?.optional);
  };
  const change = (key: string, value: string) => {
    const next = { ...values, [key]: value.trim() };
    setValues(next);
    if (feeds(key)) refresh(next);
  };

  const fieldInput = (field: RunnerSpec['fields'][number]) =>
    field.listed ? (
      <Field
        key={field.key}
        label={field.label}
        required={!field.optional}
        hint={
          listed.loading ? (
            <Loading label="Listing" inline dots />
          ) : listed.failed ? (
            'could not list them, type one'
          ) : (
            field.hint
          )
        }
        group
      >
        <Combo
          label={field.label}
          name={field.key}
          options={listed.options?.[field.key] ?? []}
          placeholder={field.placeholder}
          value={values[field.key] ?? ''}
          onChange={value => change(field.key, value)}
          onOpen={() => {
            if (!listed.options && !listed.loading) refresh(values, 0);
          }}
        />
      </Field>
    ) : (
      <Field key={field.key} label={field.label} hint={field.hint} required={!field.optional}>
        {field.secret ? (
          <SecretInput
            name={field.key}
            placeholder={field.placeholder}
            required={!field.optional}
            onInput={event => change(field.key, event.currentTarget.value)}
          />
        ) : (
          <input
            name={field.key}
            placeholder={field.placeholder}
            required={!field.optional}
            autocomplete="off"
            onInput={event => change(field.key, event.currentTarget.value)}
          />
        )}
      </Field>
    );

  return (
    <>
      <div class="add-grid">
        {required.map(fieldInput)}
        {who}
      </div>
      {listedFields.length ? <div class="add-grid">{listedFields.map(fieldInput)}</div> : null}
      <details class="add-more">
        <summary>Advanced</summary>
        <div class="add-grid">
          <Field label="Name" hint="shown in the list">
            <input name="name" defaultValue={name} placeholder={spec.name} autocomplete="off" />
          </Field>
          {folded.map(fieldInput)}
        </div>
      </details>
    </>
  );
}

/** The dialog for one runner kind: its fields, or a pairing for a machine. */
function AddRunner({
  spec,
  admin,
  personal,
  known,
  onAdded,
  onClose,
}: {
  spec: RunnerSpec;
  admin: boolean;
  /** A signed-in user can own a runner; a local server without one only has workspace runners. */
  personal: boolean;
  known: string[];
  onAdded: (rows: Runners) => void;
  onClose: () => void;
}) {
  const asked = useSearchParams();
  const [scope, setScope] = useState(
    personal && (asked.get('scope') === 'personal' || !admin) ? 'personal' : 'workspace',
  );
  const action = useAction({ toast: 'Not added' });
  const busy = Boolean(action.pending);
  const [pairing, setPairing] = useState<RunnerPairing>();
  // A paired machine shows up in the list, through the events stream, once it calls home.
  const [before, setBefore] = useState(known);
  const joined = Boolean(pairing) && known.some(id => !before.includes(id));

  useEffect(() => {
    if (joined) onClose();
  }, [joined]);

  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(onClose, Math.min(pairing.expiresAt - Date.now(), 15 * 60_000));
    return () => clearTimeout(timer);
  }, [pairing]);

  // A machine pairs for one scope; another scope drops the pairing still waiting.
  const start = (pairScope: string) => {
    setBefore(known);
    void action
      .run('pair', async () =>
        setPairing(await client.runners.pair({ scope: pairScope as RunnerRow['scope'] })),
      )
      .then(ok => ok || onClose());
  };
  const changeScope = (next: string) => {
    setScope(next);
    if (spec.connect !== 'pair') return;
    setPairing(undefined);
    start(next);
  };

  useEffect(() => {
    if (spec.connect === 'pair') start(scope);
  }, []);

  const who = personal ? (
    <Field
      label="Who can use it"
      hint={
        !admin
          ? 'only admins add workspace runners'
          : spec.connect === 'pair'
            ? scope === 'workspace'
              ? "every member's tasks use its logins and files"
              : 'only your tasks run here'
            : scope === 'workspace'
              ? "every member's tasks can use it"
              : 'only your tasks'
      }
      group
    >
      <Select
        label="Who can use it"
        options={SCOPES}
        value={admin ? scope : 'personal'}
        onChange={changeScope}
        disabled={!admin || (busy && !pairing)}
      />
    </Field>
  ) : null;

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    if (busy) return;
    const values = Object.fromEntries(
      [...new FormData(event.currentTarget as HTMLFormElement)].map(([key, value]) => [
        key,
        String(value).trim(),
      ]),
    );
    const { name, ...config } = values;
    await action.run('add', async () => {
      await client.runners.add({
        kind: spec.kind,
        name: name || spec.name,
        scope: scope as RunnerRow['scope'],
        config: Object.fromEntries(Object.entries(config).filter(([, value]) => value)),
      });
      onAdded(await client.runners.list());
      onClose();
    });
  };

  return (
    <Modal
      class="add-modal"
      title={
        <span class="runner-title">
          <Icon d={KIND_ICONS[spec.kind] ?? iPlug} />
          {spec.name}
        </span>
      }
      dismiss
      busy={busy && spec.connect === 'fields'}
      onSubmit={spec.connect === 'fields' ? add : undefined}
      onClose={onClose}
      actions={
        spec.connect === 'fields' ? (
          <Button type="submit" leftIcon={iPlus} loading={busy}>
            Add runner
          </Button>
        ) : undefined
      }
    >
      <div class="add-form runner-form">
        {spec.help ? <p class="muted">{spec.help}</p> : null}
        {spec.command ? <CopyLine value={spec.command} /> : null}
        {spec.link ? (
          <div class="runner-link">
            <Button variant="secondary" href={spec.link} external>
              Open {new URL(spec.link).host}
            </Button>
            <CopyButton value={spec.link} label="Copy link" />
          </div>
        ) : null}
        {spec.connect === 'fields' ? (
          <FieldsForm spec={spec} name={asked.get('name') ?? undefined} who={who} />
        ) : (
          <>
            {who ? <div class="add-grid">{who}</div> : null}
            <Pairing pairing={pairing} onCancel={onClose} />
          </>
        )}
      </div>
    </Modal>
  );
}

/** Where tasks run: every runner by name, the default first, and how to add one. */
export function RunnersList({ first, me }: { first: Runners; me: Me }) {
  const [rows, setRows] = useState(first);
  const action = useAction();
  const admin = isAdmin(me);
  const items = sortedRunners(rows.items);
  const adding = useAddDialog('Add runner', ['name', 'scope']);
  // A chat's link opens that kind's dialog, filled in.
  const asked = useSearchParams().get('add');
  const [kind, setKind] = useState(
    rows.catalog.find(each => each.available && each.kind === asked)?.kind,
  );
  const spec = adding.open ? rows.catalog.find(each => each.kind === kind) : undefined;

  useRunnerEvents(({ items }) => setRows(current => ({ ...current, items })));

  const change = (act: () => Promise<unknown>) =>
    action.run('change', async () => {
      await act();
      setRows(await client.runners.list());
    });

  return (
    <Card
      look="filled"
      title="Runners"
      count={items.length}
      actions={
        <Menu
          button={{ size: 'sm' }}
          label="Add runner"
          wide
          summary={
            <>
              <Icon d={iPlus} />
              Add runner
              <Icon d={iDown} />
            </>
          }
        >
          {rows.catalog
            .filter(each => each.available)
            .map(each => (
              <MenuItem
                key={each.kind}
                icon={KIND_ICONS[each.kind] ?? iPlug}
                title={each.name}
                sub={each.description}
                onClick={() => {
                  setKind(each.kind);
                  adding.show();
                }}
              />
            ))}
        </Menu>
      }
    >
      <div class="table-scroll">
        <table class="rows settings">
          <tbody>
            {items.map(runner => (
              <RunnerItem
                key={runner.id}
                runner={runner}
                manage={runner.scope === 'personal' || admin}
                onChange={change}
              />
            ))}
          </tbody>
        </table>
      </div>
      {spec ? (
        <AddRunner
          key={spec.kind}
          spec={spec}
          admin={admin}
          personal={Boolean(me.user)}
          known={items.map(row => row.id)}
          onAdded={setRows}
          onClose={adding.close}
        />
      ) : null}
    </Card>
  );
}
