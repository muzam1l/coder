'use client';

import './runners-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { client, poll } from '@/utils/client';
import {
  iCheck,
  iCopy,
  iDots,
  iDown,
  iGit,
  iMonitor,
  iPlug,
  iPlus,
  iSpark,
  iTerminal,
} from '@/comps/ui/icons';
import { Card, Loading } from '@/comps/ui/card';
import { Badge } from '@/comps/ui/badge';
import { ErrorText, Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { Select } from '@/comps/ui/select';
import { formatDuration, reasonText } from '@/utils/format';
import { sortedRunners } from '@/app/dash/tasks/composer-data';
import { useRemove } from './list';
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
const SCOPES: Array<[string, string]> = [
  ['personal', 'Just me'],
  ['workspace', 'Workspace'],
];
const ADMIN_ROLES = new Set(['owner', 'admin']);

const ago = (at: number) =>
  Date.now() - at < 60_000
    ? 'just now'
    : `${formatDuration(Date.now() - at).replace(/\.\d/, '')} ago`;

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
  return (
    <span class={`sub runner-status${runner.online ? ' ok' : ''}`}>
      <i class="dot" />
      {runner.online
        ? 'Online'
        : runner.lastSeen
          ? `Last seen ${ago(runner.lastSeen)}`
          : 'Not seen yet'}
    </span>
  );
}

function RunnerItem({
  runner,
  manage,
  onChange,
  onError,
}: {
  runner: RunnerRow;
  manage: boolean;
  onChange: (act: () => Promise<unknown>) => Promise<boolean>;
  onError: (message: string) => void;
}) {
  const [making, setMaking] = useState(false);
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
          onRemove: () => onChange(() => client.runners.remove(runner.id)),
        }
      : undefined,
  );
  const test = () => {
    setTested('testing');
    client.runners.test(runner.id).then(setTested, reason => {
      setTested(undefined);
      onError(reasonText(reason));
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
          <Badge>{runner.scope}</Badge>
          {runner.default ? <Badge tone="acc">default</Badge> : null}
        </span>
        <Status runner={runner} tested={tested} />
      </td>
      <td class="acts">
        {runner.default || !manage ? null : (
          <button
            type="button"
            class="btn secondary sm"
            disabled={making}
            aria-busy={making}
            onClick={() => {
              setMaking(true);
              void onChange(() => client.runners.update(runner.id, { default: true })).finally(() =>
                setMaking(false),
              );
            }}
          >
            Make default
          </button>
        )}
        <Menu summaryClass="icon-btn" label="Actions" summary={<Icon d={iDots} />}>
          <MenuItem title="Test" onClick={test} />
          {manage && !builtIn ? (
            <MenuItem title="Rename" onClick={() => setRenaming(true)} />
          ) : null}
          {removing.item}
        </Menu>
        {removing.dialog}
      </td>
    </tr>
  );
}

/** One command to copy. */
function Command({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div class="runner-cmd">
      <code>{value}</code>
      <button
        type="button"
        class={copied ? 'icon-btn copied' : 'icon-btn'}
        aria-label={copied ? 'Copied' : 'Copy command'}
        title={copied ? 'Copied' : 'Copy command'}
        onClick={() => void navigator.clipboard.writeText(value).then(() => setCopied(true))}
      >
        <Icon d={copied ? iCheck : iCopy} />
      </button>
    </div>
  );
}

/** A pairing in progress: what to run on the other computer, step by step, and a wait until it connects. */
function Pairing({ pairing, onCancel }: { pairing: RunnerPairing; onCancel: () => void }) {
  return (
    <div class="runner-pair">
      <details class="runner-step">
        <summary>Install the Coder CLI on that computer, if it is not there yet</summary>
        <Command value="npm install -g @wular/coder" />
      </details>
      <div class="runner-step">
        <p>Run this there. The token works once and expires in 15 minutes.</p>
        <Command value={pairing.command} />
      </div>
      <details class="runner-step">
        <summary>Behind a firewall? This server has to reach that computer over HTTPS</summary>
        <p>
          Open a tunnel on that computer first, then add its address to the command above as{' '}
          <code>--runner-url</code>.
        </p>
        <Command value="cloudflared tunnel --url http://localhost:4100" />
      </details>
      <div class="runner-wait">
        <Loading label="Waiting for that computer to connect" inline dots />
        <button type="button" class="btn secondary-danger sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Add a runner: pick a kind, then fill its fields or pair a machine. */
function AddRunner({
  catalog,
  admin,
  personal,
  known,
  onAdded,
}: {
  catalog: RunnerSpec[];
  admin: boolean;
  /** A signed-in user can own a runner; a local server without one only has workspace runners. */
  personal: boolean;
  known: string[];
  onAdded: (rows: Runners) => void;
}) {
  const [kind, setKind] = useState<RunnerKind>();
  const [scope, setScope] = useState(personal ? 'personal' : 'workspace');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState<RunnerPairing>();
  const spec = catalog.find(each => each.kind === kind);

  // A paired machine shows up in the list once it calls home.
  useEffect(() => {
    if (!pairing) return;
    const until = Math.min(pairing.expiresAt, Date.now() + 15 * 60_000);
    // A list read from a pairing already gone never ends the next one.
    let current = true;
    const stop = poll(async () => {
      if (Date.now() > until) return cancel();
      const rows = await client.runners.list();
      if (!current || !rows.items.some(row => !known.includes(row.id))) return;
      onAdded(rows);
      cancel();
    }, 2000);
    return () => {
      current = false;
      stop();
    };
  }, [pairing]);

  const cancel = () => {
    setPairing(undefined);
    setKind(undefined);
  };

  // Picking another kind drops a pairing still waiting.
  const pick = (next: RunnerSpec) => {
    setError('');
    setPairing(undefined);
    setKind(next.kind);
    if (next.connect !== 'pair') return;
    setBusy(true);
    client.runners
      .pair({ scope: scope as RunnerRow['scope'] })
      .then(setPairing, reason => {
        setKind(undefined);
        setError(reasonText(reason));
      })
      .finally(() => setBusy(false));
  };

  const add = async (event: SubmitEvent) => {
    event.preventDefault();
    if (!spec || busy) return;
    const values = Object.fromEntries(
      [...new FormData(event.currentTarget as HTMLFormElement)].map(([key, value]) => [
        key,
        String(value).trim(),
      ]),
    );
    const { name, ...config } = values;
    setBusy(true);
    setError('');
    try {
      await client.runners.add({
        kind: spec.kind,
        name: name || spec.name,
        scope: scope as RunnerRow['scope'],
        config: Object.fromEntries(Object.entries(config).filter(([, value]) => value)),
      });
      onAdded(await client.runners.list());
      setKind(undefined);
    } catch (reason) {
      setError(reasonText(reason));
    }
    setBusy(false);
  };

  return (
    <form class="runner-add" method="post" onSubmit={add}>
      <div class="runner-pick">
        <Menu
          summaryClass="btn secondary"
          label="Runner kind"
          align="left"
          wide
          summary={
            <>
              <Icon d={spec ? KIND_ICONS[spec.kind] : iPlus} />
              {spec ? spec.name : 'Add a runner'}
              <Icon d={iDown} />
            </>
          }
        >
          {catalog
            .filter(each => each.available)
            .map(each => (
              <button
                key={each.kind}
                type="button"
                role="menuitemradio"
                aria-checked={each.kind === kind}
                class="pop-item rich"
                onClick={() => pick(each)}
              >
                <Icon d={KIND_ICONS[each.kind] ?? iPlug} />
                <span class="grow">
                  {each.name}
                  <small>{each.available ? each.description : each.reason}</small>
                </span>
                <Icon d={iCheck} />
              </button>
            ))}
        </Menu>
        {spec?.connect === 'fields' ? (
          <>
            {spec.help ? <p class="muted runner-help">{spec.help}</p> : null}
            <div class="add-grid">
              <Field label="Name" hint="shown in the list">
                <input name="name" placeholder={spec.name} autocomplete="off" />
              </Field>
              {spec.fields.map(field => (
                <Field
                  key={`${spec.kind}:${field.key}`}
                  label={field.label}
                  hint={field.hint ?? (field.optional ? 'optional' : undefined)}
                >
                  <input
                    name={field.key}
                    type={field.secret ? 'password' : 'text'}
                    placeholder={field.placeholder}
                    required={!field.optional}
                    autocomplete="off"
                  />
                </Field>
              ))}
            </div>
          </>
        ) : null}
        {spec?.connect === 'fields' ? (
          <div class="runner-foot">
            <ErrorText value={error} />
            {personal ? (
              <Select
                label="Who can use this runner"
                options={SCOPES}
                value={admin ? scope : 'personal'}
                onChange={setScope}
                disabled={!admin}
              />
            ) : null}
            <button class="btn" aria-busy={busy} disabled={busy}>
              Add runner
            </button>
          </div>
        ) : (
          <>
            {spec && personal ? (
              <Select
                label="Who can use this runner"
                options={SCOPES}
                value={admin ? scope : 'personal'}
                onChange={setScope}
                disabled={!admin || Boolean(pairing)}
              />
            ) : null}
            {busy && !pairing ? <Loading label="Pairing" inline /> : null}
            <ErrorText value={error} />
          </>
        )}
      </div>
      {pairing ? <Pairing pairing={pairing} onCancel={cancel} /> : null}
    </form>
  );
}

/** Where tasks run: every runner by name, the default first, and how to add one. */
export function RunnersList({ first, me }: { first: Runners; me: Me }) {
  const [rows, setRows] = useState(first);
  const [error, setError] = useState('');
  const admin = !me.user || ADMIN_ROLES.has(me.organization?.role ?? '');
  const items = sortedRunners(rows.items);

  // Online dots stay fresh while the tab is open.
  useEffect(() => poll(() => client.runners.list().then(setRows), 30_000), []);

  const change = async (act: () => Promise<unknown>) => {
    setError('');
    try {
      await act();
      setRows(await client.runners.list());
      return true;
    } catch (reason) {
      setError(reasonText(reason));
      return false;
    }
  };

  return (
    <Card title="Runners" count={items.length} actions={<ErrorText value={error} />}>
      <div class="table-scroll">
        <table class="rows settings">
          <tbody>
            {items.map(runner => (
              <RunnerItem
                key={runner.id}
                runner={runner}
                manage={runner.scope === 'personal' || admin}
                onChange={change}
                onError={setError}
              />
            ))}
          </tbody>
        </table>
      </div>
      <AddRunner
        catalog={rows.catalog}
        admin={admin}
        personal={Boolean(me.user)}
        known={items.map(row => row.id)}
        onAdded={setRows}
      />
    </Card>
  );
}
