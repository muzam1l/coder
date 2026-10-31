'use client';

import './connections-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';
import { useSearchParams } from '@wular/pnext/navigation/client';

import { client } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { Card, Empty } from '@/comps/ui/card';
import { Button } from '@/comps/ui/button';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuItem } from '@/comps/ui/menu-items';
import { iAgent, iDots, iLock, iPlus, iUsers } from '@/comps/ui/icons';
import { BrandIcon } from '@/app/dash/[org]/agents/agent/agent-pills';
import { useAddDialog, useRemove } from './list';
import { AddConnection, returning, useAdd, type Pick } from './connection-add';
import { PlatformStep } from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-step';
import type { Step as StepData } from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-state';
import { Modal } from '@/comps/ui/modal';
import { SecretInput } from '@/comps/ui/field';

/** The built-in agents, each with its step on every platform it uses. */
export type Builtins = Array<{ id: string; name: string; steps: Record<string, StepData> }>;
import { useOrg } from '@/comps/nav/org';
import type { ConnectionRow, IntegrationInfo } from '@coder/client/types';

/** One service: a platform from the catalog, or an MCP server by name, with every connection to it. */
type Service = {
  key: string;
  name: string;
  info?: IntegrationInfo;
  /** Where an MCP server lives: its host or command. */
  where?: string;
  rows: ConnectionRow[];
};

const hostOf = (row: ConnectionRow) =>
  row.url ? (URL.canParse(row.url) ? new URL(row.url).host : row.url) : row.command;

/** Connections grouped by service: a platform's app installs and member sign-ins, or an MCP server's workspace and personal entries. */
function services(rows: ConnectionRow[], catalog: IntegrationInfo[]): Service[] {
  const out = new Map<string, Service>();
  for (const info of catalog.filter(entry => entry.personal))
    out.set(info.id, { key: info.id, name: info.name, info, rows: [] });
  for (const row of rows) {
    const info = catalog.find(entry => entry.id === row.provider);
    const key = info ? info.id : `mcp:${row.name.replace(/-user$/, '')}`;
    const service = out.get(key) ?? {
      key,
      name: info?.name ?? row.name.replace(/-user$/, ''),
      info,
      where: info ? undefined : hostOf(row),
      rows: [],
    };
    service.rows.push(row);
    out.set(key, service);
  }

  return [...out.values()];
}

/** A connection's state as a dot and its name, with Reconnect when its sign-in stopped working. */
function State({
  row,
  label,
  onReconnect,
  busy,
}: {
  row: ConnectionRow;
  label?: string;
  onReconnect?: () => void;
  busy?: boolean;
}) {
  const broken = row.status === 'needs-auth';
  return (
    <>
      <i class={broken ? 'conn-dot warn' : row.status === 'disabled' ? 'conn-dot off' : 'conn-dot'} />
      <span class="conn-name">{broken ? 'needs sign-in' : (label ?? row.account ?? row.name)}</span>
      {row.access === 'read-only' ? (
        <span class="dim" title="Read-only">
          <Icon d={iLock} />
        </span>
      ) : null}
      {broken && onReconnect ? (
        <Button variant="ghost" size="sm" loading={busy} onClick={onReconnect}>
          Reconnect
        </Button>
      ) : null}
    </>
  );
}

/** A connection's ⋯ menu: sign in again, and remove after asking. */
function RowMenu({ row, onReconnect, onRemoved }: { row: ConnectionRow; onReconnect: () => void; onRemoved: () => void }) {
  const removing = useRemove({
    title: `Remove ${row.name}?`,
    body: 'Tasks stop using it, and its key or sign-in is deleted.',
    link: row.name,
    onRemove: () => client.connections.remove(row.id).then(onRemoved, toastFailure),
  });
  return (
    <>
      <Menu button="icon" label={`${row.name} actions`} summary={<Icon d={iDots} />}>
        <MenuItem title={row.auth === 'key' ? 'New key' : 'Sign in again'} onClick={onReconnect} />
        {removing.item}
      </Menu>
      {removing.dialog}
    </>
  );
}

/** Every service tasks reach, each with its workspace side and the viewer's own, plus how many other members connected theirs. */
export function ConnectionsList({
  first,
  catalog,
  local,
  admin,
  operator,
  viewer,
  agents,
  builtins,
}: {
  first: ConnectionRow[];
  catalog: IntegrationInfo[];
  local: boolean;
  admin: boolean;
  operator: boolean;
  /** The signed-in member's name, for the personal column. */
  viewer?: string;
  /** The workspace's agents and the platforms each uses, for installing an app. */
  agents: Array<{ id: string; name: string; platforms: string[]; builtin?: boolean }>;
  /** The built-in agents and each one's step on every platform it uses. */
  builtins: Builtins;
}) {
  const [rows, setRows] = useState(first.filter(row => row.provider !== 'env'));
  // A chat's reconnect link opens the new key row of a key connection; its connect link marks a platform's row.
  const search = useSearchParams();
  const reconnecting = search.get('reconnect');
  const connecting = search.get('connect');
  const [keying, setKeying] = useState(
    rows.find(row => row.name === reconnecting && row.auth === 'key'),
  );
  const adding = useAddDialog('Add connection', ['url', 'access', 'tools', 'scope']);
  const [start, setStart] = useState<{ pick: Pick; scope: 'workspace' | 'personal' }>();
  const action = useAction({ leaves: true });
  const org = useOrg();
  const put = (row: ConnectionRow) =>
    setRows(now =>
      now.some(each => each.id === row.id)
        ? now.map(each => (each.id === row.id ? row : each))
        : [...now, row],
    );
  const drop = (row: ConnectionRow) => setRows(now => now.filter(each => each.id !== row.id));
  const { add } = useAdd(put);

  const reconnect = (row: ConnectionRow) => {
    if (row.auth === 'key') return setKeying(row);
    void action.run(row.id, async () =>
      location.assign(returning((await client.connections.authorize(row.id)).url)),
    );
  };
  const list = services(rows, catalog);
  const close = () => {
    setStart(undefined);
    adding.close();
  };

  // Shared apps serve every built-in agent; the first one's step stands for them.
  const builtin = builtins[0];
  const [perAgent, setPerAgent] = useState<IntegrationInfo>();

  // A built-in agent's next step on a platform, the same component its Platforms tab renders.
  const Step = ({
    step,
    info,
    agent = builtin!.id,
    quiet,
  }: {
    step: StepData;
    info: IntegrationInfo;
    agent?: string;
    quiet?: boolean;
  }) => (
    <PlatformStep
      step={step}
      info={info}
      org={org}
      agent={agent}
      builtin
      operator={operator}
      unreachable={catalog.some(entry => entry.unreachable)}
      quiet={quiet}
    />
  );

  // Where an app is installed, as a dot and its accounts.
  const Installed = ({ accounts, title }: { accounts: Array<string | undefined>; title?: string }) => (
    <>
      <i class="conn-dot" />
      <span class="conn-name" title={title}>
        {[...new Set(accounts.filter(Boolean))].join(', ') || 'installed'}
      </span>
      <span class="grow" />
    </>
  );

  // A platform whose apps are each agent's own, like Slack: who has one installed, and the dialog that sets them up.
  const PerAgent = ({ info }: { info: IntegrationInfo }) => {
    const live = builtins.flatMap(agent =>
      (agent.steps[info.id]?.live ?? []).map(entry => ({ agent: agent.name, account: entry.account })),
    );
    return live.length ? (
      <>
        <Installed
          accounts={live.map(entry => entry.account)}
          title={live.map(entry => `${entry.agent} in ${entry.account ?? info.name}`).join(', ')}
        />
        <Button size="sm" variant="ghost" onClick={() => setPerAgent(info)}>
          Manage
        </Button>
      </>
    ) : (
      <Button size="sm" onClick={() => setPerAgent(info)}>
        Set up {info.name}
      </Button>
    );
  };

  const workspace = (service: Service) => {
    const apps = service.rows.filter(row => row.agent);
    const own = service.rows.find(row => !row.owner && !row.agent);
    if (service.info?.builtinApp === 'own' && builtins.some(agent => agent.steps[service.info!.id]))
      return (
        <div class="conn-cell">
          <PerAgent info={service.info} />
        </div>
      );
    if (service.info) {
      const info = service.info;
      const step = builtin?.steps[info.id];
      // Other agents' own apps installed here; the built-in agent's are in its step.
      const others = [...new Set(apps.map(row => row.agent!))].filter(id => id !== builtin?.id);
      const nameOf = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;
      return (
        <div class="conn-cell">
          {step?.live.length ? <Installed accounts={step.live.map(entry => entry.account)} /> : null}
          {others.length ? (
            <span
              class="conn-others"
              title={`Their own ${info.name} apps: ${others.map(nameOf).join(', ')}`}
            >
              <Icon d={iAgent} />
              {others.length}
            </span>
          ) : null}
          {step ? <Step step={step} info={info} quiet /> : null}
          {step || others.length ? null : <span class="dim">—</span>}
        </div>
      );
    }
    if (own)
      return (
        <div class="conn-cell">
          <State row={own} label={own.name} busy={action.pending === own.id} onReconnect={admin ? () => reconnect(own) : undefined} />
          <span class="grow" />
          {admin ? <RowMenu row={own} onReconnect={() => reconnect(own)} onRemoved={() => drop(own)} /> : null}
        </div>
      );

    const template = service.rows[0];
    return admin && template ? (
      <Button
        variant="ghost"
        size="sm"
        leftIcon={iPlus}
        onClick={() =>
          setStart({ pick: { kind: 'mcp', target: template.url ?? template.command, name: service.name }, scope: 'workspace' })
        }
      >
        Connect
      </Button>
    ) : (
      <span class="dim">—</span>
    );
  };

  const personal = (service: Service) => {
    const mine = service.rows.find(row => row.asker);
    const others = service.rows.filter(row => row.owner && !row.asker);
    const template = service.rows[0];
    const count = others.length ? (
      <span class="conn-others" title={others.map(row => row.owner?.name ?? 'A member').join(', ')}>
        <Icon d={iUsers} />
        {others.length}
      </span>
    ) : null;
    return (
      <div class="conn-cell">
        {mine ? (
          <>
            <State row={mine} busy={action.pending === mine.id} onReconnect={() => reconnect(mine)} />
            <span class="grow" />
            {count}
            <RowMenu row={mine} onReconnect={() => reconnect(mine)} onRemoved={() => drop(mine)} />
          </>
        ) : service.info && !service.info.connectable ? (
          <>
            <span class="dim grow">—</span>
            {count}
          </>
        ) : (
          <>
            <Button
              variant="ghost"
              size="sm"
              leftIcon={iPlus}
              autoFocus={service.key === connecting}
              onClick={() =>
                service.info
                  ? add({ name: service.info.name, provider: service.info.id })
                  : setStart({
                      pick: { kind: 'mcp', target: template?.url ?? template?.command, name: service.name },
                      scope: 'personal',
                    })
              }
            >
              Connect
            </Button>
            <span class="grow" />
            {count}
          </>
        )}
      </div>
    );
  };

  const groups = (
    [
      ['Platforms', list.filter(service => service.info)],
      ['MCP servers', list.filter(service => !service.info)],
    ] as const
  ).filter(([, services]) => services.length);

  return (
    <>
      <Card look="filled" title="Connections" actions={adding.button}>
        {list.length ? (
          <>
            <div class="table-scroll">
              <table class="conns">
                <colgroup>
                  <col class="conns-svc" />
                  <col />
                  {local ? null : <col />}
                </colgroup>
                <thead>
                  <tr>
                    <th>Service</th>
                    <th>Workspace</th>
                    {local ? null : <th>{viewer ? `Personal · ${viewer}` : 'Personal'}</th>}
                  </tr>
                </thead>
                {groups.map(([label, services]) => (
                  <tbody key={label}>
                    <tr class="conns-group">
                      <th colSpan={local ? 2 : 3}>{label}</th>
                    </tr>
                    {services.map(service => (
                      <tr
                        key={service.key}
                        class={service.key === connecting ? 'conns-marked' : undefined}
                      >
                        <td>
                          <span class="conn-svc" title={service.where}>
                            {service.info ? <BrandIcon brand={service.info.brand} /> : <span class="conn-mark">{service.name[0]}</span>}
                            <b>{service.name}</b>
                          </span>
                        </td>
                        {service.info &&
                        !service.info.connectable &&
                        !service.rows.length &&
                        !builtins.some(agent => agent.steps[service.info!.id]?.live.length) ? (
                          // No app here yet: one step serves both sides, so one cell holds it.
                          <td colSpan={local ? 1 : 2}>
                            <div class="conn-cell">
                              {service.info.builtinApp === 'own' &&
                              builtins.some(agent => agent.steps[service.info!.id]) ? (
                                <PerAgent info={service.info} />
                              ) : builtin?.steps[service.info.id] ? (
                                <Step step={builtin.steps[service.info.id]!} info={service.info} />
                              ) : (
                                <span class="dim">—</span>
                              )}
                            </div>
                          </td>
                        ) : (
                          <>
                            <td>{workspace(service)}</td>
                            {local ? null : <td>{personal(service)}</td>}
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
            {local ? null : <p class="conns-hint">Personal accounts run only on their owner's turns.</p>}
          </>
        ) : (
          <Empty title="No connections yet">
            Add one so tasks can use another service, like an issue tracker or a database.
          </Empty>
        )}
        {keying ? (
          <NewKey
            row={keying}
            onSaved={row => {
              put(row);
              setKeying(undefined);
            }}
            onClose={() => setKeying(undefined)}
          />
        ) : null}
      </Card>
      {perAgent ? (
        <Modal title={`${perAgent.name} apps`} dismiss onClose={() => setPerAgent(undefined)}>
          <p class="muted">
            Each agent has its own {perAgent.name} app, so each answers as its own @name in{' '}
            {perAgent.name}. Set one up for every built-in agent that should work there.
          </p>
          <div class="agent-apps">
            {builtins
              .filter(agent => agent.steps[perAgent.id])
              .map(agent => (
                <div key={agent.id} class="agent-app">
                  <b>{agent.name}</b>
                  <Step step={agent.steps[perAgent.id]!} info={perAgent} agent={agent.id} />
                </div>
              ))}
          </div>
          <p class="muted">Other agents set theirs up on their own Platforms tab.</p>
        </Modal>
      ) : null}
      {adding.open || start ? (
        <AddConnection
          catalog={catalog}
          rows={rows}
          local={local}
          admin={admin}
          operator={operator}
          builtin={builtin}
          start={start}
          onAdded={row => {
            put(row);
            close();
          }}
          onClose={close}
        />
      ) : null}
    </>
  );
}

/** A new key for a key connection that stopped working, in a row under the list. */
function NewKey({
  row,
  onSaved,
  onClose,
}: {
  row: ConnectionRow;
  onSaved: (row: ConnectionRow) => void;
  onClose: () => void;
}) {
  const action = useAction({ leaves: true });
  const busy = Boolean(action.pending);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  return (
    <form
      class="add-row conn-key"
      method="post"
      onSubmit={event => {
        event.preventDefault();
        const key = String(new FormData(event.currentTarget).get('key') ?? '').trim();
        if (!key) return;
        void action.run('save', async () =>
          onSaved(await client.connections.update(row.id, { key })),
        );
      }}
    >
      <SecretInput
        name="key"
        aria-label={`New key for ${row.name}`}
        placeholder={`New key for ${row.name}, then Enter`}
        inputRef={input}
        required
      />
      <Button type="submit" loading={busy}>
        Save key
      </Button>
      <Button variant="ghost" disabled={busy} onClick={onClose}>
        Cancel
      </Button>
    </form>
  );
}
