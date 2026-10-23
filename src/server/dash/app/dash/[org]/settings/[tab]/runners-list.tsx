'use client';

import './runners-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { iDots, iDown, iGit, iMonitor, iPlug, iPlus, iSpark, iTerminal } from '@/comps/ui/icons';
import { Card, Loading } from '@/comps/ui/card';
import { Badge } from '@/comps/ui/badge';
import { Button } from '@/comps/ui/button';
import { CopyLine } from '@/comps/ui/copy';
import { Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuItem, MenuRadio } from '@/comps/ui/menu-items';
import { Select } from '@/comps/ui/select';
import { ago, formatDuration } from '@/utils/format';
import { isAdmin } from '@/api/types';
import { SCOPES } from '@/app/dash/[org]/settings/model-options';
import { sortedRunners } from '@/app/dash/[org]/tasks/composer-data';
import { useRunnerEvents } from '@/comps/frame/task-toasts';
import { useRemove } from './list';
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
}: {
  runner: RunnerRow;
  manage: boolean;
  onChange: (act: () => Promise<unknown>) => Promise<boolean>;
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
          link: runner.id,
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
        {runner.default || !manage ? null : (
          <Button
            variant="secondary"
            size="sm"
            loading={making}
            onClick={() => {
              setMaking(true);
              void onChange(() => client.runners.update(runner.id, { default: true })).finally(() =>
                setMaking(false),
              );
            }}
          >
            Make default
          </Button>
        )}
        <Menu button="icon" label="Actions" summary={<Icon d={iDots} />}>
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

/** A pairing in progress: what to run on the other computer, step by step, and a wait until it connects. */
function Pairing({ pairing, onCancel }: { pairing: RunnerPairing; onCancel: () => void }) {
  return (
    <div class="runner-pair">
      <details class="runner-step">
        <summary>Install the Coder CLI on that computer, if it is not there yet</summary>
        <CopyLine value="npm install -g @wular/coder" />
      </details>
      <div class="runner-step">
        <p>Run this there. The token works once and expires in 15 minutes.</p>
        <CopyLine value={pairing.command} />
      </div>
      <details class="runner-step">
        <summary>Behind a firewall? This server has to reach that computer over HTTPS</summary>
        <p>
          Open a tunnel on that computer first, then add its address to the command above as{' '}
          <code>--runner-url</code>.
        </p>
        <CopyLine value="cloudflared tunnel --url http://localhost:4100" />
      </details>
      <div class="runner-wait">
        <Loading label="Waiting for that computer to connect" inline dots />
        <Button variant="secondary" danger size="sm" onClick={onCancel}>
          Cancel
        </Button>
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
  // A chat's link picks a kind set up by fields and fills the form in.
  const asked = useSearchParams();
  const [picked, setKind] = useState(
    catalog.find(
      each => each.available && each.connect === 'fields' && each.kind === asked.get('add'),
    )?.kind,
  );
  const [scope, setScope] = useState(
    asked.get('scope') === 'workspace' && admin ? 'workspace' : personal ? 'personal' : 'workspace',
  );
  const action = useAction();
  const busy = Boolean(action.pending);
  const [paired, setPairing] = useState<RunnerPairing>();
  // A paired machine shows up in the list, through the events stream, once it calls home.
  const [before, setBefore] = useState(known);
  const joined = Boolean(paired) && known.some(id => !before.includes(id));
  const kind = joined ? undefined : picked;
  const pairing = joined ? undefined : paired;
  const spec = catalog.find(each => each.kind === kind);

  useEffect(() => {
    if (!pairing) return;
    const timer = setTimeout(cancel, Math.min(pairing.expiresAt - Date.now(), 15 * 60_000));
    return () => clearTimeout(timer);
  }, [pairing]);

  const cancel = () => {
    setPairing(undefined);
    setKind(undefined);
  };

  // Picking another kind drops a pairing still waiting.
  const pick = (next: RunnerSpec) => {
    setPairing(undefined);
    setKind(next.kind);
    if (next.connect !== 'pair') return;
    setBefore(known);
    void action
      .run('pair', async () =>
        setPairing(await client.runners.pair({ scope: scope as RunnerRow['scope'] })),
      )
      .then(ok => ok || setKind(undefined));
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
    await action.run('add', async () => {
      await client.runners.add({
        kind: spec.kind,
        name: name || spec.name,
        scope: scope as RunnerRow['scope'],
        config: Object.fromEntries(Object.entries(config).filter(([, value]) => value)),
      });
      onAdded(await client.runners.list());
      setKind(undefined);
    });
  };

  return (
    <form class="runner-add" method="post" onSubmit={add}>
      <div class="runner-pick">
        <Menu
          button={{ variant: 'secondary' }}
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
              <MenuRadio
                key={each.kind}
                on={each.kind === kind}
                onPick={() => pick(each)}
                icon={KIND_ICONS[each.kind] ?? iPlug}
                sub={each.available ? each.description : each.reason}
              >
                {each.name}
              </MenuRadio>
            ))}
        </Menu>
        {spec?.connect === 'fields' ? (
          <>
            {spec.help ? <p class="muted runner-help">{spec.help}</p> : null}
            <div class="add-grid">
              <Field label="Name" hint="shown in the list">
                <input
                  name="name"
                  defaultValue={asked.get('name') ?? undefined}
                  placeholder={spec.name}
                  autocomplete="off"
                />
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
            {personal ? (
              <Select
                label="Who can use this runner"
                options={SCOPES}
                value={admin ? scope : 'personal'}
                onChange={setScope}
                disabled={!admin}
              />
            ) : null}
            <Button type="submit" loading={busy}>
              Add runner
            </Button>
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
  const action = useAction();
  const admin = isAdmin(me);
  const items = sortedRunners(rows.items);

  useRunnerEvents(({ items }) => setRows(current => ({ ...current, items })));

  const change = (act: () => Promise<unknown>) =>
    action.run('change', async () => {
      await act();
      setRows(await client.runners.list());
    });

  return (
    <Card look="filled" title="Runners" count={items.length}>
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
