'use client';

import { useRef, useState } from 'preact/hooks';
import { useSearchParams } from '@wular/pnext/navigation/client';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { Loading } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { Field } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { MenuItem } from '@/comps/ui/menu-items';
import { Icon } from '@/comps/ui/icon';
import { iLeft, iPlus } from '@/comps/ui/icons';
import { Button, IconButton } from '@/comps/ui/button';
import { Segmented } from '@/comps/ui/segmented';
import { Select } from '@/comps/ui/select';
import { Search } from '@/comps/ui/toolbar';
import { Modal } from '@/comps/ui/modal';
import { BrandIcon } from '@/app/dash/[org]/agents/agent/agent-pills';
import { PlatformStep } from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-step';
import type { Step } from '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/platform-state';
import { ACCESS } from '@/app/dash/[org]/settings/model-options';
import { useOrg } from '@/comps/nav/org';
import type {
  ConnectionInput,
  ConnectionRow,
  Found,
  IntegrationInfo,
  McpEntry,
  RegistryInput,
} from '@coder/client/types';

type Answer = ConnectionRow & { authorize?: string };
export type Builtin = { id: string; steps: Record<string, Step> };
type Scope = 'workspace' | 'personal';

/** What the dialog connects: a platform's account, or an MCP server from the registry or typed in. */
export type Pick =
  | { kind: 'platform'; info: IntegrationInfo }
  | { kind: 'mcp'; server?: Found; target?: string; name?: string };

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

const SCOPE_OPTIONS: Array<[Scope, string]> = [
  ['workspace', 'Workspace'],
  ['personal', 'Personal'],
];

/** A platform sign-in started here comes back here, with its outcome as a toast. */
export function returning(url: string) {
  const target = new URL(url, location.origin);
  if (target.origin === location.origin && target.pathname.startsWith('/connect/'))
    target.searchParams.set('return', location.pathname);

  return target.href;
}

/** A sign-in answer goes to the platform; anything else joins the list. */
export function useAdd(onAdded: (row: ConnectionRow) => void) {
  const action = useAction({ leaves: true });
  const add = (body: ConnectionInput, onFail?: (reason: unknown) => void) =>
    void action.run('add', async () => {
      const { authorize, ...row }: Answer = await client.connections.add(body).catch(reason => {
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

  return { busy: Boolean(action.pending), add, signIn };
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

/** One search over the catalog's platforms and the MCP registry; a pasted URL or command is a server of its own. */
function Find({
  platforms,
  onPick,
}: {
  platforms: IntegrationInfo[];
  onPick: (pick: Pick) => void;
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; items?: Found[]; error?: string }>();
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const typed = query.trim();
  const target = isUrl(typed) || /\s/.test(typed);

  const run = (q: string) => {
    setFound(now => (now?.q === q ? now : { q }));
    void client.mcp
      .search(q)
      .then(items => setFound(now => (now?.q === q ? { q, items } : now)))
      .catch(reason => setFound(now => (now?.q === q ? { q, error: reasonText(reason) } : now)));
  };
  const search = (q: string) => {
    setQuery(q);
    clearTimeout(timer.current);
    // Servers come only from a typed search, so the dialog opens at its size and stays there.
    if (!q.trim() || isUrl(q) || /\s/.test(q.trim())) return setFound(undefined);
    // The list shows it is searching from the first key, not after the pause.
    setFound({ q: q.trim() });
    timer.current = setTimeout(() => run(q.trim()), 250);
  };
  const shown = platforms.filter(info => info.name.toLowerCase().includes(typed.toLowerCase()));

  return (
    <div class="conn-find">
      <Search value={query} label="Search platforms and MCP servers, or paste an MCP server URL" onInput={search} autofocus />
      <div class="conn-hits" role="listbox" aria-label="Services" aria-busy={Boolean(found && !found.items)}>
        {target ? (
          <MenuItem
            icon={iPlus}
            title="Use as an MCP server"
            sub={<span class="mono">{typed}</span>}
            onClick={() => onPick({ kind: 'mcp', target: typed })}
          />
        ) : null}
        {target
          ? null
          : shown.map(info => (
              <MenuItem
                key={info.id}
                icon={<BrandIcon brand={info.brand} />}
                title={info.name}
                end={<small class="dim">platform</small>}
                onClick={() => onPick({ kind: 'platform', info })}
              />
            ))}
        {target ? null : found?.error ? (
          <p class="registry-note err" role="alert">
            {found.error}
          </p>
        ) : !found ? null : !found.items ? (
          <p class="registry-note">
            <Loading label="Searching MCP servers" inline dots />
          </p>
        ) : found.items.length ? (
          <>
            {found.items.map(server => (
              <MenuItem
                key={server.name}
                title={
                  <>
                    {server.title}
                    {server.verified ? <Badge tone="ok">by {domainOf(server.name)}</Badge> : null}
                  </>
                }
                sub={server.description || server.name}
                end={<small class="dim">MCP</small>}
                onClick={() => onPick({ kind: 'mcp', server })}
              />
            ))}
          </>
        ) : typed && !shown.length ? (
          <p class="registry-note">Nothing matches. Paste the server's URL or command.</p>
        ) : null}
      </div>
    </div>
  );
}

/** A platform: its workspace side is the built-in agent's app, as its Platforms tab shows it; its personal side a member's sign-in through that app. */
function usePlatform({
  info,
  rows,
  scope,
  operator,
  builtin,
  onAdded,
}: {
  info: IntegrationInfo;
  rows: ConnectionRow[];
  scope: Scope;
  operator: boolean;
  builtin?: Builtin;
  onAdded: (row: ConnectionRow) => void;
}) {
  const org = useOrg();
  const { busy, add, signIn } = useAdd(onAdded);
  const mine = rows.find(row => row.provider === info.id && row.asker);
  const step = builtin?.steps[info.id];
  // The same next step the Platforms tab shows: set up, create, install or manage the app.
  const next = step ? (
    <div class="conn-step">
      <PlatformStep
        step={step}
        info={info}
        org={org}
        agent={builtin!.id}
        builtin
        operator={operator}
      />
    </div>
  ) : null;

  if (scope === 'workspace')
    return {
      busy,
      status: null,
      hint: "The agent's app. Every turn.",
      notice: next ? null : <p class="muted">No agent here uses {info.name}.</p>,
      submit: () => undefined,
      // The step is the dialog's action, so it sits where the action buttons do.
      actions: next,
    };

  return {
    busy,
    status: !info.connectable ? null : mine ? (
      <Badge tone={mine.status === 'needs-auth' ? 'warn' : 'ok'}>
        {mine.status === 'needs-auth' ? 'needs sign-in' : (mine.account ?? 'connected')}
      </Badge>
    ) : (
      <Badge>not connected</Badge>
    ),
    hint: 'The member’s own account. Their turns only.',
    notice: null,
    submit: () => {
      if (!info.connectable) return;
      if (mine) return signIn(mine.id);
      add({ name: info.name, provider: info.id });
    },
    // A sign-in goes through the app, so without one the app's own step comes first.
    actions: info.connectable ? (
      <Button type="submit" loading={busy}>
        <BrandIcon brand={info.brand} />
        {mine ? 'Sign in again' : `Sign in to ${info.name}`}
      </Button>
    ) : (
      next
    ),
  };
}

/** An MCP server's form: its name and target, what the registry asks for, and a key when it takes one. */
function useMcp({
  server,
  target: typed,
  name: asked,
  scope,
  onAdded,
}: {
  server?: Found;
  target?: string;
  name?: string;
  scope: Scope;
  onAdded: (row: ConnectionRow) => void;
}) {
  const query = useSearchParams();
  const [name, setName] = useState(asked ?? server?.title ?? query.get('add') ?? '');
  const [target, setTarget] = useState(server ? targetOf(server) : (typed ?? ''));
  // A remote server's sign-in is found on Add; a key is asked for only when it needs one.
  const [keyed, setKeyed] = useState(false);
  const [access, setAccess] = useState(query.get('access') ?? 'auto');
  const { busy, add } = useAdd(onAdded);
  const fields = useRef<HTMLDivElement>(null);
  const url = !target.trim() || isUrl(target);
  const secrets = secretsOf(server);
  const asksKey = !url || keyed || secrets.length > 0;
  // A stdio server refuses Read-only without a tool list.
  const level = url ? access : 'auto';
  const secret = secrets.find(input => input.required) ?? secrets[0];
  const rest = secrets.filter(input => input !== secret);
  const blocked = rest.some(input => input.required);
  const plain = [
    ...(server?.argumentInputs ?? []),
    ...(server?.env ?? []),
    ...(server?.headers ?? []),
  ].some(input => !input.secret);

  const submit = (box: HTMLFormElement) => {
    const values = [...new FormData(box)].map(
      ([key, value]) => [key, String(value).trim()] as const,
    );
    const get = (key: string) => values.find(([field]) => field === key)?.[1] ?? '';
    const group = (prefix: string) =>
      Object.fromEntries(
        values
          .filter(([key, value]) => key.startsWith(prefix) && value)
          .map(([key, value]) => [key.slice(prefix.length), value]),
      );
    const destination = target.trim();
    if (!name.trim() || !destination || blocked) return;

    const original = server?.command ? targetOf(server) : undefined;
    const parts =
      server && destination === original
        ? [server.command!, ...(server.args ?? [])]
        : shellWords(destination);
    const [command, ...args] = parts.map(part =>
      part.replace(/\{([^}]+)\}/g, (token, label) => {
        const input = server?.argumentInputs?.find(
          each => each.name === label || each.label === label,
        );
        return input ? get(`arg:${input.name}`) : token;
      }),
    );
    const env = group('env:');
    const headers = group('header:');
    const endpoint: McpEntry = url
      ? {
          url: destination,
          ...(server?.url === destination ? { type: server.type } : {}),
          ...(Object.keys(headers).length ? { headers } : {}),
        }
      : {
          command,
          ...(args.length ? { args } : {}),
          ...(Object.keys(env).length ? { env } : {}),
        };
    if (server?.description) endpoint.description = server.description;

    const key = get('key');
    add(
      {
        name: name.trim(),
        provider: 'mcp',
        ...(scope === 'personal' ? { scope: 'personal' } : {}),
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
      {server?.description ? <p class="muted">{server.description}</p> : null}
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
          <Inputs kind="arg" list={server?.argumentInputs ?? []} />
          <Inputs kind="env" list={(server?.env ?? []).filter(input => !input.secret)} />
          <Inputs kind="header" list={(server?.headers ?? []).filter(input => !input.secret)} />
        </div>
      ) : null}
      {rest.length ? (
        <p class="muted" role="note">
          {blocked
            ? `This server needs ${names(secrets.filter(input => input.required))}, and a connection holds one key. Add it in the server's own config instead.`
            : `A connection holds one key, sent as ${secret!.name}. Add ${names(rest)} in the server's own config when needed.`}
        </p>
      ) : null}
      {asksKey ? (
        <div class="add-grid">
          <Field label="API key" hint={url ? undefined : 'optional'}>
            <input
              key={server?.name}
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
      <details class="add-more">
        <summary>More options</summary>
        <div class="add-grid">
          <Field label="Access" hint="read-only keeps only its read-only tools" group>
            <Select
              label="Access"
              options={url ? ACCESS : ACCESS.filter(([each]) => each === 'auto')}
              value={level}
              onChange={setAccess}
            />
          </Field>
        </div>
      </details>
    </div>
  );

  return {
    busy,
    body,
    submit,
    actions: (
      <Button type="submit" disabled={blocked} loading={busy}>
        Add connection
      </Button>
    ),
  };
}

/** The picked service: who it acts as, its state there, and the one action that connects it. */
function Connect({
  pick,
  rows,
  local,
  admin,
  operator,
  builtin,
  scope: first,
  onBack,
  onAdded,
  onClose,
}: {
  pick: Pick;
  rows: ConnectionRow[];
  local: boolean;
  admin: boolean;
  operator: boolean;
  builtin?: Builtin;
  scope?: Scope;
  onBack?: () => void;
  onAdded: (row: ConnectionRow) => void;
  onClose: () => void;
}) {
  const platform = pick.kind === 'platform';
  // Members add only their own; an admin adding an MCP server starts with the workspace's.
  const [scope, setScope] = useState<Scope>(
    local ? 'workspace' : (first ?? (platform || !admin ? 'personal' : 'workspace')),
  );
  const platformForm = platform
    ? usePlatform({ info: pick.info, rows, scope, operator, builtin, onAdded })
    : undefined;
  const mcpForm = platform ? undefined : useMcp({ ...pick, scope, onAdded });
  const form = (platformForm ?? mcpForm)!;
  const title = platform ? pick.info.name : (pick.server?.title ?? 'MCP server');

  return (
    <Modal
      class="add-modal"
      title={
        <span class="conn-title">
          {onBack ? <IconButton label="Back" onClick={onBack}><Icon d={iLeft} /></IconButton> : null}
          {platform ? <BrandIcon brand={pick.info.brand} /> : null}
          {title}
        </span>
      }
      dismiss
      busy={form.busy}
      onSubmit={event => {
        event.preventDefault();
        form.submit(event.currentTarget as HTMLFormElement);
      }}
      onClose={onClose}
      actions={form.actions}
    >
      {local ? null : (
        <div class="conn-scope">
          <Field label="Acts as" group>
            {platform || admin ? (
              <Segmented label="Acts as" options={SCOPE_OPTIONS} value={scope} onChange={next => setScope(next as Scope)} />
            ) : (
              <p class="muted">Personal. Admins add workspace servers.</p>
            )}
          </Field>
          {platformForm ? (
            <p class="conn-state">
              {platformForm.status}
              <span class="muted">{platformForm.hint}</span>
            </p>
          ) : (
            <p class="muted">
              {scope === 'workspace' ? 'An admin’s account. Every turn.' : 'The member’s own account. Their turns only.'}
            </p>
          )}
        </div>
      )}
      {platformForm?.notice ?? null}
      {mcpForm?.body ?? null}
    </Modal>
  );
}

/** Adds a connection: find a platform or an MCP server, then pick who it acts as; `start` skips the search. */
export function AddConnection({
  catalog,
  rows,
  local,
  admin,
  operator,
  builtin,
  start,
  onAdded,
  onClose,
}: {
  catalog: IntegrationInfo[];
  rows: ConnectionRow[];
  local: boolean;
  admin: boolean;
  operator: boolean;
  /** The built-in agent and its step on each platform, as its Platforms tab shows them. */
  builtin?: Builtin;
  start?: { pick: Pick; scope?: Scope };
  onAdded: (row: ConnectionRow) => void;
  onClose: () => void;
}) {
  const asked = useSearchParams();
  const linked = asked.get('add');
  const info = catalog.find(entry => entry.id === linked);
  // A chat's link opens the picked service at once.
  const [pick, setPick] = useState<Pick | undefined>(
    start?.pick ??
      (info
        ? { kind: 'platform', info }
        : asked.has('url')
          ? { kind: 'mcp', target: asked.get('url') ?? '', name: linked ?? undefined }
          : undefined),
  );
  const scope = (start?.scope ?? asked.get('scope') ?? undefined) as Scope | undefined;
  const platforms = catalog.filter(entry => entry.personal || rows.some(row => row.agent && row.provider === entry.id));

  if (pick)
    return (
      <Connect
        key={pick.kind === 'platform' ? pick.info.id : (pick.server?.name ?? pick.target)}
        pick={pick}
        rows={rows}
        local={local}
        admin={admin}
        operator={operator}
        builtin={builtin}
        scope={scope}
        onBack={start ? undefined : () => setPick(undefined)}
        onAdded={onAdded}
        onClose={onClose}
      />
    );

  return (
    <Modal class="add-modal" title="Add a connection" dismiss onClose={onClose}>
      <Find platforms={platforms} onPick={setPick} />
    </Modal>
  );
}

