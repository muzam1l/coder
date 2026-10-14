'use client';

import './connections-list.css';

import { useEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { held } from '@/utils/paged';
import { Card, Empty, FoldCard, Loading } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { ErrorText, Field } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { Icon } from '@/comps/ui/icon';
import { iAlert } from '@/comps/ui/icons';
import { Link } from '@wular/pnext/link';
import { Segmented } from '@/comps/ui/segmented';
import { Select } from '@/comps/ui/select';
import { Search } from '@/comps/ui/toolbar';
import { BrandIcon } from '@/app/dash/[org]/agents/agent/agent-pills';
import { Row } from './list';
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
  platform: 'Sign in with OAuth, and tasks use the account through Coder’s own tools.',
  mcp: 'Search known servers, or paste a URL or command.',
};
const READ_ONLY: [string, string] = ['observe', 'Read only'];
const READ_WRITE: [string, string] = ['write', 'Read and write'];
const SCOPES: Array<[string, string]> = [
  ['me', 'Just me'],
  ['', 'Workspace'],
];

const STATUS: Record<ConnectionRow['status'], { tone?: 'ok' | 'warn'; label: string }> = {
  ok: { tone: 'ok', label: 'connected' },
  authorize: { tone: 'warn', label: 'not signed in' },
  reconnect: { tone: 'warn', label: 'reconnect needed' },
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
      <Select label="Scope" options={SCOPES} value={value} onChange={onChange} />
    </Field>
  );
}

/** Read only or read and write, as a dropdown like the scope beside it. */
function Access({
  value,
  onChange,
  write,
}: {
  value: string;
  onChange: (value: string) => void;
  /** Only read and write is possible. */
  write?: boolean;
}) {
  return (
    <Field label="Access" group>
      <Select
        label="Access"
        options={write ? [READ_WRITE] : [READ_ONLY, READ_WRITE]}
        value={value}
        onChange={onChange}
      />
    </Field>
  );
}

type AddProps = {
  local: boolean;
  admin: boolean;
  operator: boolean;
  onAdded: (row: ConnectionRow) => void;
  onError: (reason: string) => void;
};

/** The add forms' shared send: a sign-in answer goes to the platform, anything else joins the list. */
function useAdd({ local, admin, onAdded, onError }: Omit<AddProps, 'operator'>) {
  const [busy, setBusy] = useState(false);
  const [owner, setOwner] = useState(admin || local ? '' : 'me');
  const add = (body: ConnectionInput, onFail?: (reason: unknown) => void) => {
    setBusy(true);
    onError('');
    void client.connections.add({ ...body, ...(owner ? { owner: 'me' } : {}) }).then(
      ({ authorize, ...row }: Answer) => {
        if (authorize) return location.assign(authorize);
        onAdded(row);
      },
      reason => {
        setBusy(false);
        onError(reasonText(reason));
        onFail?.(reason);
      },
    );
  };
  const who = <Who local={local} admin={admin} value={owner} onChange={setOwner} />;
  return { busy, add, who };
}

/** A platform account: sign in there, then tasks use Coder's own tools for it. */
function AddPlatform({
  catalog,
  rows,
  ...props
}: AddProps & { catalog: IntegrationInfo[]; rows: ConnectionRow[] }) {
  const org = useOrg();
  const platforms = catalog.filter(info => info.personal);
  const [id, setId] = useState(platforms[0]?.id ?? '');
  const [access, setAccess] = useState('observe');
  const { busy, add, who } = useAdd(props);
  const info = platforms.find(entry => entry.id === id);
  const mine = rows.find(row => row.provider === id && row.mine);

  return (
    <form
      class="add-form"
      method="post"
      onSubmit={event => {
        event.preventDefault();
        if (info?.connectable)
          add({ name: info.name, provider: info.id, access: access as ConnectionInput['access'] });
      }}
    >
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
        {who}
      </div>
      {info && !info.connectable ? (
        <Notice tone="warning" slim>
          <Icon d={iAlert} />
          <span class="grow">
            This server has no shared {info.name} app yet.
            {props.operator ? null : ' Ask whoever runs this server to add one.'}
          </span>
          {props.operator ? (
            <Link class="btn outline sm" href="/dash/[org]/operator" params={{ org }}>
              Set it up
            </Link>
          ) : null}
        </Notice>
      ) : null}
      <div class="add-foot">
        <p class="muted grow">
          {!info
            ? 'No platform here offers sign-in yet.'
            : mine && info.connectable
              ? `Connected as ${mine.account ?? 'you'}.`
              : null}
        </p>
        <button class="btn" disabled={busy || !info?.connectable} aria-busy={busy}>
          {info ? <BrandIcon brand={info.brand} /> : null}
          Sign in to {info?.name ?? 'a platform'}
        </button>
      </div>
    </form>
  );
}

/** An MCP server: one Coder knows, a URL or a command; how it signs in, its access and who it is for. */
function AddMcp(props: AddProps) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; items?: Found[]; error?: string }>();
  const [picked, setPicked] = useState<Found>();
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  // A remote server's sign-in is found on Add; a key is asked for only when it needs one.
  const [keyed, setKeyed] = useState(false);
  const [access, setAccess] = useState('observe');
  const { busy, add, who } = useAdd(props);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const form = useRef<HTMLFormElement>(null);
  const url = !target.trim() || isUrl(target);
  const asksKey = !url || keyed || secretsOf(picked).length > 0;
  // A stdio server refuses Read only without a tool list.
  const level = url ? access : 'write';
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
        () => {},
      );
      return;
    }
    setFound({ q });
    void client.mcp
      .search(q.trim())
      .then(held(performance.now()))
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
      form.current
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
        access: level as ConnectionInput['access'],
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
          form.current?.querySelector<HTMLInputElement>('input[name=key]')?.focus(),
        );
      },
    );
  };

  return (
    <form
      ref={form}
      class="add-form"
      method="post"
      onSubmit={event => {
        event.preventDefault();
        submit(event.currentTarget);
      }}
    >
      <div
        class="registry"
        onKeyDown={event => {
          if (event.key === 'Enter') event.preventDefault();
          if (event.key === 'Escape') setFound(undefined);
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
                <button
                  type="button"
                  class="btn ghost sm"
                  // Keeps focus in the search, so swapping this note for the loader does not close the list.
                  onMouseDown={event => event.preventDefault()}
                  onClick={() => run(found.q)}
                >
                  Retry
                </button>
              </div>
            ) : !found.items ? (
              <div class="registry-note">
                <Loading label="Searching known servers" inline dots />
              </div>
            ) : found.items.length ? (
              found.items.map(server => (
                <button
                  key={server.name}
                  type="button"
                  class="pop-item rich"
                  onClick={() => pick(server)}
                >
                  <span class="grow">
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
                    <small>{server.description || server.name}</small>
                  </span>
                </button>
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
      <div class="add-grid">
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
      <div class="add-foot">
        <button class="btn" disabled={busy || blocked} aria-busy={busy}>
          Add connection
        </button>
      </div>
    </form>
  );
}

/** Adds a connection: a platform account, an API key, or an MCP server; each kind its own short form. */
function AddConnection({
  catalog,
  rows,
  local,
  admin,
  operator,
  empty,
  onAdded,
}: {
  catalog: IntegrationInfo[];
  rows: ConnectionRow[];
  /** No connection yet when the page loaded, so the form starts open. */
  empty: boolean;
  local: boolean;
  admin: boolean;
  operator: boolean;
  onAdded: (row: ConnectionRow) => void;
}) {
  const [kind, setKind] = useState(catalog.some(info => info.personal) ? 'platform' : 'mcp');
  const [error, setError] = useState('');
  const [round, setRound] = useState(0);
  const props: AddProps = {
    local,
    admin,
    operator,
    onError: setError,
    onAdded: row => {
      onAdded(row);
      setRound(round + 1);
    },
  };

  return (
    <FoldCard
      opened={empty}
      title="Add a connection"
      note="A platform account, or any MCP server"
      actions={<ErrorText value={error} />}
    >
      <div class="conn-add">
        <Segmented
          label="What to connect"
          options={KINDS}
          value={kind}
          onChange={next => {
            setKind(next);
            setError('');
          }}
        />
        <p class="muted">{HELP[kind]}</p>
      </div>
      {kind === 'platform' ? (
        <AddPlatform key={round} {...props} catalog={catalog} rows={rows} />
      ) : (
        <AddMcp key={round} {...props} />
      )}
    </FoldCard>
  );
}

/** A new key for a key connection that stopped working, in a row under the list. */
function NewKey({
  row,
  onSaved,
  onError,
  onClose,
}: {
  row: ConnectionRow;
  onSaved: (row: ConnectionRow) => void;
  onError: (reason: string) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
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
        setBusy(true);
        onError('');
        void client.connections.update(row.id, { key }).then(onSaved, reason => {
          setBusy(false);
          onError(reasonText(reason));
        });
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
      <button class="btn" disabled={busy} aria-busy={busy}>
        Save key
      </button>
      <button type="button" class="btn ghost" disabled={busy} onClick={onClose}>
        Cancel
      </button>
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
  const [keying, setKeying] = useState<ConnectionRow>();
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  const put = (row: ConnectionRow) =>
    setRows(now =>
      now.some(each => each.id === row.id)
        ? now.map(each => (each.id === row.id ? row : each))
        : [...now, row],
    );

  const reconnect = (row: ConnectionRow) => {
    if (row.auth === 'key') return setKeying(row);
    setBusy(row.id);
    setError('');
    void client.connections.authorize(row.id).then(
      ({ url }) => location.assign(url),
      reason => {
        setBusy('');
        setError(reasonText(reason));
      },
    );
  };

  return (
    <>
      <AddConnection
        catalog={catalog}
        rows={rows}
        local={local}
        admin={admin}
        operator={operator}
        empty={!first.some(row => row.provider !== 'env')}
        onAdded={put}
      />
      <Card title="Connections" count={rows.length} actions={<ErrorText value={error} />}>
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
                        {row.provider === 'env' ? null : (
                          <Badge>{row.access === 'write' ? 'read and write' : 'read only'}</Badge>
                        )}
                        <Badge tone={STATUS[row.status].tone}>{STATUS[row.status].label}</Badge>
                      </span>
                    }
                    sub={<Reach row={row} catalog={catalog} />}
                    actions={
                      row.status === 'ok' ? null : (
                        <button
                          type="button"
                          class="btn outline sm"
                          disabled={busy === row.id}
                          aria-busy={busy === row.id}
                          onClick={() => reconnect(row)}
                        >
                          Reconnect
                        </button>
                      )
                    }
                    remove={{
                      title: `Remove ${row.name}?`,
                      body: 'Tasks stop using it, and its key or sign-in is deleted.',
                      onRemove: () =>
                        client.connections.remove(row.id).then(
                          () => setRows(now => now.filter(each => each.id !== row.id)),
                          reason => setError(reasonText(reason)),
                        ),
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty title="No connections yet">
            Add one above so tasks can use another service, like an issue tracker or a database.
          </Empty>
        )}
        {keying ? (
          <NewKey
            row={keying}
            onError={setError}
            onSaved={row => {
              put(row);
              setKeying(undefined);
            }}
            onClose={() => setKeying(undefined)}
          />
        ) : null}
      </Card>
    </>
  );
}
