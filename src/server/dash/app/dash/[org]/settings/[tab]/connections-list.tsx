'use client';

import './connections-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';
import { useSearchParams } from '@wular/pnext/navigation/client';

import { client } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { Card, Empty, Loading } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { Field } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { MenuItem } from '@/comps/ui/menu-items';
import { Icon } from '@/comps/ui/icon';
import { iAlert } from '@/comps/ui/icons';
import { Button, LinkButton } from '@/comps/ui/button';
import { Segmented } from '@/comps/ui/segmented';
import { Select } from '@/comps/ui/select';
import { Search } from '@/comps/ui/toolbar';
import { Modal } from '@/comps/ui/modal';
import { BrandIcon } from '@/app/dash/[org]/agents/agent/agent-pills';
import { Row, useAddDialog } from './list';
import { useOrg } from '@/comps/nav/org';
import type {
  ConnectionInput,
  ConnectionRow,
  Found,
  IntegrationInfo,
  McpEntry,
  RegistryInput,
} from '@coder/client/types';
import { Notice } from '@/comps/ui/notice';
import { ACCESS, CONNECTION_SCOPES } from '@/app/dash/[org]/settings/model-options';

type Answer = ConnectionRow & { authorize?: string };

/** Splits a typed command into words, keeping quoted paths whole. */
const shellWords = (text: string): string[] =>
  (text.match(/"[^"]*"|'[^']*'|(?:\{[^}]+\}|[^\s])+/g) ?? []).map(part =>
    part.replace(/^(["'])(.*)\1$/, '$2'),
  );

const isUrl = (text: string) => /^https?:\/\//.test(text.trim());

const targetOf = (server: Found) =>
  server.url ??
  [
    server.command,
    ...(server.args ?? []).map(arg =>
      arg.replace(
        /\{((?:runtime|package):[^}]+)\}/g,
        (_, name) =>
          `{${server.argumentInputs?.find(input => input.name === name)?.label ?? name}}`,
      ),
    ),
  ]
    .join(' ')
    .trim();

/** The domain a registry name's namespace stands for: `io.draw/mcp` is draw.io. */
const domainOf = (name: string) => name.split('/')[0]!.split('.').reverse().join('.');

/** The registry values that carry the server's keys. */
const secretsOf = (server?: Found) =>
  [...(server?.headers ?? []), ...(server?.env ?? [])].filter(input => input.secret);

const names = (list: RegistryInput[]) => list.map(input => input.name).join(', ');

const KINDS: Array<[string, string]> = [
  ['platform', 'Platform'],
  ['mcp', 'MCP server'],
];
const HELP: Record<string, string> = {
  platform:
    'Sign in with your own account, just for you. A task acts as you only after you approve it.',
  mcp: 'Search known servers, or paste a URL or command.',
};

const STATUS: Record<ConnectionRow['status'], { tone?: 'ok' | 'warn'; label: string }> = {
  ok: { tone: 'ok', label: 'connected' },
  authorize: { tone: 'warn', label: 'not signed in' },
  reconnect: { tone: 'warn', label: 'Needs reconnecting' },
};

/** What a connection reaches: the platform it signs in to, the variable its key is in, else its server's host or command. */
function Reach({ row, catalog }: { row: ConnectionRow; catalog: IntegrationInfo[] }) {
  const info = catalog.find(entry => entry.id === row.provider);
  const where = info
    ? info.name
    : row.env
      ? row.env
      : row.url
        ? URL.canParse(row.url)
          ? new URL(row.url).host
          : row.url
        : row.command;

  return (
    <span class="reach">
      {info ? <BrandIcon brand={info.brand} /> : null}
      {[where, row.account].filter(Boolean).join(' · ')}
    </span>
  );
}

/** Registry values the picked server needs, each its own field. */
function Inputs({ kind, list }: { kind: 'env' | 'header' | 'arg'; list: RegistryInput[] }) {
  return (
    <>
      {list.map(input => (
        <Field
          key={input.name}
          label={<span class="mono">{input.label ?? input.name}</span>}
          hint={input.description ?? (input.required ? 'required' : 'optional')}
        >
          <input
            name={`${kind}:${input.name}`}
            placeholder={input.placeholder}
            defaultValue={kind === 'arg' ? input.placeholder : undefined}
            autocomplete="off"
            required={input.required}
          />
        </Field>
      ))}
    </>
  );
}

/** Who a connection is for; a local server has no members, and a member's own is always theirs. */
function Who({
  local,
  admin,
  value,
  onChange,
}: {
  local: boolean;
  admin: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  if (local || !admin) return null;
  return (
    <Field label="Scope" group>
      <Select label="Scope" options={CONNECTION_SCOPES} value={value} onChange={onChange} />
    </Field>
  );
}

/** Auto (follows the task) or Read-only, as a dropdown like the scope beside it. */
function Access({
  value,
  onChange,
  write,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Read-only is not possible. */
  write?: boolean;
}) {
  return (
    <Field label="Access" group>
      <Select
        label="Access"
        options={write ? ACCESS.filter(([level]) => level === 'auto') : ACCESS}
        value={value}
        onChange={onChange}
      />
    </Field>
  );
}

/** A platform sign-in started here comes back here, with its outcome as a toast. */
function returning(url: string) {
  const target = new URL(url, location.origin);
  if (target.origin === location.origin && target.pathname.startsWith('/connect/'))
    target.searchParams.set('return', location.pathname);

  return target.href;
}

type AddProps = {
  local: boolean;
  admin: boolean;
  operator: boolean;
  onAdded: (row: ConnectionRow) => void;
};

/** The add forms' shared send: a sign-in answer goes to the platform, anything else joins the list; a `personal` form is always Just me. */
function useAdd({ local, admin, onAdded }: Omit<AddProps, 'operator'>, personal = false) {
  const action = useAction({ leaves: true });
  const mine = useSearchParams().has('me');
  const [owner, setOwner] = useState((admin || local) && !personal ? (mine ? 'me' : '') : 'me');
  const add = (body: ConnectionInput, onFail?: (reason: unknown) => void) =>
    void action.run('add', async () => {
      const { authorize, ...row }: Answer = await client.connections
        .add({ ...body, ...(owner ? { owner: 'me' } : {}) })
        .catch(reason => {
          onFail?.(reason);
          throw reason;
        });
      if (authorize) return location.assign(returning(authorize));
      onAdded(row);
    });
  // An account already connected in this scope signs in again on its own row.
  const signIn = (id: string) =>
    void action.run('add', async () =>
      location.assign(returning((await client.connections.authorize(id)).url)),
    );
  const who = personal ? null : (
    <Who local={local} admin={admin} value={owner} onChange={setOwner} />
  );
  return { busy: Boolean(action.pending), add, signIn, owner, who };
}

/** A platform account: sign in there, then tasks use Coder's own tools for it. */
function useAddPlatform({
  catalog,
  rows,
  ...props
}: AddProps & { catalog: IntegrationInfo[]; rows: ConnectionRow[] }) {
  const org = useOrg();
  const platforms = catalog.filter(info => info.personal);
  const asked = useSearchParams().get('add');
  const [id, setId] = useState(
    platforms.find(entry => entry.id === asked)?.id ?? platforms[0]?.id ?? '',
  );
  const [access, setAccess] = useState('auto');
  const { busy, add, signIn } = useAdd(props, true);
  const info = platforms.find(entry => entry.id === id);
  const mine = rows.find(row => row.provider === id && row.mine);
  const submit = () => {
    if (!info?.connectable) return;
    if (mine) return signIn(mine.id);
    add({
      name: info.name,
      provider: info.id,
      ...(access === 'auto' ? {} : { access: access as ConnectionInput['access'] }),
    });
  };
  const note = !info
    ? 'No platform here offers sign-in yet.'
    : mine && info.connectable
      ? `Connected as ${mine.account ?? 'you'}.`
      : null;

  const body = (
    <div class="add-form">
      <div class="add-grid">
        <Field label="Platform" group>
          <Select
            label="Platform"
            options={platforms.map((entry): [string, string] => [entry.id, entry.name])}
            icons={Object.fromEntries(
              platforms.map(entry => [entry.id, <BrandIcon brand={entry.brand} />]),
            )}
            value={id}
            onChange={setId}
          />
        </Field>
        <Access value={access} onChange={setAccess} />
      </div>
      {info && !info.connectable ? (
        <Notice tone="warning" slim>
          <Icon d={iAlert} />
          <span class="grow">
            This server has no shared {info.name} app yet.
            {props.operator ? null : ' Ask whoever runs this server to add one.'}
          </span>
          {props.operator ? (
            <LinkButton variant="outline" size="sm" href="/dash/[org]/operator" params={{ org }}>
              Set it up
            </LinkButton>
          ) : null}
        </Notice>
      ) : null}
      {note ? <p class="muted">{note}</p> : null}
    </div>
  );
  const actions = (
    <Button
      type="submit"
      variant={mine && info?.connectable ? 'secondary' : undefined}
      disabled={!info?.connectable}
      loading={busy}
    >
      {info ? <BrandIcon brand={info.brand} /> : null}
      {mine && info?.connectable ? 'Sign in again' : `Sign in to ${info?.name ?? 'a platform'}`}
    </Button>
  );
  return { busy, body, actions, submit };
}

/** An MCP server: one Coder knows, a URL or a command; how it signs in, its access and who it is for. */
function useAddMcp(props: AddProps) {
  // A chat's link fills the form in.
  const asked = useSearchParams();
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; items?: Found[]; error?: string }>();
  const [picked, setPicked] = useState<Found>();
  const [name, setName] = useState(asked.get('add') ?? '');
  const [target, setTarget] = useState(asked.get('url') ?? '');
  // A remote server's sign-in is found on Add; a key is asked for only when it needs one.
  const [keyed, setKeyed] = useState(false);
  const [access, setAccess] = useState(asked.get('access') ?? 'auto');
  const { busy, add, who } = useAdd(props);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const fields = useRef<HTMLDivElement>(null);
  const url = !target.trim() || isUrl(target);
  const asksKey = !url || keyed || secretsOf(picked).length > 0;
  // A stdio server refuses Read-only without a tool list.
  const level = url ? access : 'auto';
  const secrets = secretsOf(picked);
  const secret = secrets.find(input => input.required) ?? secrets[0];
  const rest = secrets.filter(input => input !== secret);
  const blocked = rest.some(input => input.required);
  const plain = [
    ...(picked?.argumentInputs ?? []),
    ...(picked?.env ?? []),
    ...(picked?.headers ?? []),
  ].some(input => !input.secret);

  const run = (q: string) => {
    // An empty search only offers the curated list; it never shows loading, nothing found or errors.
    if (!q.trim()) {
      void client.mcp.search('').then(
        items => items.length && setFound(now => now ?? { q, items }),
        reason => console.error('coder dashboard: known servers', reason),
      );
      return;
    }
    setFound({ q });
    void client.mcp
      .search(q.trim())
      .then(items => setFound(now => (now?.q === q ? { q, items } : now)))
      .catch(reason => setFound(now => (now?.q === q ? { q, error: reasonText(reason) } : now)));
  };
  const search = (q: string) => {
    setQuery(q);
    clearTimeout(timer.current);
    if (!q.trim() || isUrl(q) || /\s/.test(q.trim())) setFound(undefined);
    if (isUrl(q) || /\s/.test(q.trim())) return;
    timer.current = setTimeout(() => run(q), 250);
  };
  const pick = (server: Found) => {
    setPicked(server);
    setFound(undefined);
    setQuery(server.title);
    setName(server.title);
    setTarget(targetOf(server));
    setKeyed(false);
    requestAnimationFrame(() =>
      fields.current
        ?.querySelector<HTMLInputElement>(
          "input[name^='arg:'], input[name^='env:'], input[name^='header:'], input[name=key]",
        )
        ?.focus(),
    );
  };

  const submit = (box: HTMLFormElement) => {
    const values = [...new FormData(box)].map(
      ([key, value]) => [key, String(value).trim()] as const,
    );
    const get = (key: string) => values.find(([name]) => name === key)?.[1] ?? '';
    const group = (prefix: string) =>
      Object.fromEntries(
        values
          .filter(([key, value]) => key.startsWith(prefix) && value)
          .map(([key, value]) => [key.slice(prefix.length), value]),
      );
    const server = target.trim();
    if (!name.trim() || !server || blocked) return;

    const original = picked?.command ? targetOf(picked) : undefined;
    const parts =
      picked && server === original
        ? [picked.command!, ...(picked.args ?? [])]
        : shellWords(server);
    const [command, ...args] = parts.map(part =>
      part.replace(/\{([^}]+)\}/g, (token, name) => {
        const input = picked?.argumentInputs?.find(
          input => input.name === name || input.label === name,
        );
        return input ? get(`arg:${input.name}`) : token;
      }),
    );
    const env = group('env:');
    const headers = group('header:');
    const endpoint: McpEntry = url
      ? {
          url: server,
          ...(picked?.url === server ? { type: picked.type } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        }
      : {
          command,
          ...(args.length ? { args } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        };
    if (picked?.description) endpoint.description = picked.description;

    const key = get('key');
    add(
      {
        name: name.trim(),
        provider: 'mcp',
        ...(level === 'auto' ? {} : { access: level as ConnectionInput['access'] }),
        endpoint,
        ...(key
          ? { auth: 'key', key, keyIn: url ? { header: get('header') } : { env: get('env') } }
          : url
            ? {}
            : { auth: 'none' }),
      },
      reason => {
        if ((reason as { needs?: string }).needs !== 'key') return;
        setKeyed(true);
        requestAnimationFrame(() =>
          fields.current?.querySelector<HTMLInputElement>('input[name=key]')?.focus(),
        );
      },
    );
  };

  const body = (
    <div ref={fields} class="add-form">
      <div
        class="registry"
        onKeyDown={event => {
          if (event.key === 'Enter') event.preventDefault();
          if (event.key === 'Escape' && found) {
            // Closes the results, not the dialog.
            event.preventDefault();
            setFound(undefined);
          }
        }}
        onFocusIn={() => {
          if (!found && !isUrl(query)) run(query);
        }}
        onFocusOut={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node)) setFound(undefined);
        }}
      >
        <Search value={query} label="Search known MCP servers" onInput={search} />
        {found ? (
          <div class="registry-pop" aria-live="polite" aria-busy={!found.items && !found.error}>
            {found.error ? (
              <div class="registry-note err" role="alert">
                <span>{found.error}</span>
                <Button
                  variant="ghost"
                  size="sm"
                  // Keeps focus in the search, so swapping this note for the loader does not close the list.
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => run(found.q)}
                >
                  Retry
                </Button>
              </div>
            ) : !found.items ? (
              <div class="registry-note">
                <Loading label="Searching known servers" inline dots late />
              </div>
            ) : found.items.length ? (
              found.items.map(server => (
                <MenuItem
                  key={server.name}
                  onClick={() => pick(server)}
                  title={
                    <>
                      <b>{server.title}</b>
                      {server.verified ? (
                        <span
                          title={`The MCP registry checked that the publisher owns ${domainOf(server.name)}`}
                        >
                          <Badge tone="ok">by {domainOf(server.name)}</Badge>
                        </span>
                      ) : null}
                      {server.curated ? (
                        <span title="In GitHub's reviewed list of MCP servers">
                          <Badge>GitHub list</Badge>
                        </span>
                      ) : null}
                      <Badge>{server.type}</Badge>
                    </>
                  }
                  sub={server.description || server.name}
                />
              ))
            ) : (
              <p class="registry-note">No known server matches. Paste its URL or command below.</p>
            )}
          </div>
        ) : null}
      </div>
      {picked?.description ? <p class="muted registry-picked">{picked.description}</p> : null}
      <div class="add-grid">
        <Field label="Name">
          <input
            name="name"
            value={name}
            onInput={event => setName(event.currentTarget.value)}
            placeholder="Acme docs"
            autocomplete="off"
            required
          />
        </Field>
        <Field label="URL or command">
          <input
            name="target"
            class="mono"
            value={target}
            onInput={event => setTarget(event.currentTarget.value)}
            placeholder="https://mcp.acme.dev/mcp"
            autocomplete="off"
            spellcheck={false}
            required
          />
        </Field>
      </div>
      {plain ? (
        <div class="add-grid">
          <Inputs kind="arg" list={picked?.argumentInputs ?? []} />
          <Inputs kind="env" list={(picked?.env ?? []).filter(input => !input.secret)} />
          <Inputs kind="header" list={(picked?.headers ?? []).filter(input => !input.secret)} />
        </div>
      ) : null}
      {rest.length ? (
        <p class="muted" role="note">
          {blocked
            ? `This server needs ${names(secrets.filter(input => input.required))}, and a connection holds one key. Add it in the server's own config instead.`
            : `A connection holds one key, sent as ${secret!.name}. Add ${names(rest)} in the server's own config if you use them.`}
        </p>
      ) : null}
      <div class="add-grid conn-access">
        <Access value={level} onChange={setAccess} write={!url} />
        {who}
      </div>
      {asksKey ? (
        <div class="add-grid">
          <Field label="API key" hint={url ? undefined : 'optional'}>
            <input
              key={picked?.name}
              name="key"
              type="password"
              placeholder="acme_live_4f9a…"
              autocomplete="off"
              required={!!url}
            />
          </Field>
          {url ? (
            <Field label="Header">
              <input
                key={`header:${secret?.name}`}
                name="header"
                class="mono"
                defaultValue={secret?.name ?? 'Authorization'}
                placeholder="Authorization"
                autocomplete="off"
                required
              />
            </Field>
          ) : (
            <Field label="Environment variable">
              <input
                key={`env:${secret?.name}`}
                name="env"
                class="mono"
                defaultValue={secret?.name}
                placeholder="ACME_API_KEY"
                autocomplete="off"
              />
            </Field>
          )}
        </div>
      ) : null}
    </div>
  );
  const actions = (
    <Button type="submit" disabled={blocked} loading={busy}>
      Add connection
    </Button>
  );
  return { busy, body, actions, submit };
}

/** Adds a connection in a dialog: a platform account or an MCP server; each kind its own short form. */
function AddConnection({
  catalog,
  rows,
  local,
  admin,
  operator,
  onAdded,
  onClose,
}: {
  catalog: IntegrationInfo[];
  rows: ConnectionRow[];
  local: boolean;
  admin: boolean;
  operator: boolean;
  onAdded: (row: ConnectionRow) => void;
  onClose: () => void;
}) {
  const asked = useSearchParams();
  const platform = catalog.some(info => info.personal && info.id === asked.get('add'));
  const [kind, setKind] = useState(
    asked.has('url') || (asked.has('add') && !platform)
      ? 'mcp'
      : catalog.some(info => info.personal)
        ? 'platform'
        : 'mcp',
  );
  const props: AddProps = { local, admin, operator, onAdded };
  const platformForm = useAddPlatform({ ...props, catalog, rows });
  const mcpForm = useAddMcp(props);
  const form = kind === 'platform' ? platformForm : mcpForm;

  return (
    <Modal
      class="add-modal"
      title="Add a connection"
      dismiss
      busy={form.busy}
      onSubmit={event => {
        event.preventDefault();
        form.submit(event.currentTarget as HTMLFormElement);
      }}
      onClose={onClose}
      actions={form.actions}
    >
      <div class="conn-add">
        <Segmented label="What to connect" options={KINDS} value={kind} onChange={setKind} />
        <p class="muted">{HELP[kind]}</p>
      </div>
      {form.body}
    </Modal>
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
      <input
        name="key"
        type="password"
        aria-label={`New key for ${row.name}`}
        placeholder={`New key for ${row.name}, then Enter`}
        ref={input}
        autocomplete="off"
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

/** Every connection tasks can use, what each reaches, who it is for, its access and status. */
export function ConnectionsList({
  first,
  catalog,
  local,
  admin,
  operator,
}: {
  first: ConnectionRow[];
  catalog: IntegrationInfo[];
  local: boolean;
  admin: boolean;
  operator: boolean;
}) {
  const [rows, setRows] = useState(first.filter(row => row.provider !== 'env'));
  // A chat's reconnect link opens the new key row of a key connection.
  const reconnecting = useSearchParams().get('reconnect');
  const [keying, setKeying] = useState(
    rows.find(row => row.name === reconnecting && row.auth === 'key'),
  );
  const adding = useAddDialog(['url', 'access', 'tools', 'me']);
  const action = useAction({ leaves: true });

  const put = (row: ConnectionRow) =>
    setRows(now =>
      now.some(each => each.id === row.id)
        ? now.map(each => (each.id === row.id ? row : each))
        : [...now, row],
    );

  const reconnect = (row: ConnectionRow) => {
    if (row.auth === 'key') return setKeying(row);
    void action.run(row.id, async () =>
      location.assign(returning((await client.connections.authorize(row.id)).url)),
    );
  };

  return (
    <>
      <Card title="Connections" count={rows.length} actions={adding.button}>
        {rows.length ? (
          <div class="table-scroll">
            <table class="rows settings conns">
              <tbody>
                {rows.map(row => (
                  <Row
                    key={row.id}
                    title={row.name}
                    badges={
                      <span class="conn-badges">
                        <Badge>{row.owner ? (row.mine ? 'yours' : 'member') : 'workspace'}</Badge>
                        <Badge>{row.access === 'read-only' ? 'Read-only' : 'Auto'}</Badge>
                        <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                      </span>
                    }
                    sub={<Reach row={row} catalog={catalog} />}
                    actions={
                      row.status === 'ok' ? null : (
                        <Button
                          variant="outline"
                          size="sm"
                          loading={action.pending === row.id}
                          onClick={() => reconnect(row)}
                        >
                          Reconnect
                        </Button>
                      )
                    }
                    remove={{
                      title: `Remove ${row.name}?`,
                      body: 'Tasks stop using it, and its key or sign-in is deleted.',
                      link: row.name,
                      onRemove: () =>
                        client.connections
                          .remove(row.id)
                          .then(
                            () => setRows(now => now.filter(each => each.id !== row.id)),
                            toastFailure,
                          ),
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
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
      {adding.open ? (
        <AddConnection
          catalog={catalog}
          rows={rows}
          local={local}
          admin={admin}
          operator={operator}
          onAdded={row => {
            put(row);
            adding.close();
          }}
          onClose={adding.close}
        />
      ) : null}
    </>
  );
}
