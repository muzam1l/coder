'use client';

import './mcp-list.css';

import { useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { held } from '@/utils/paged';
import { Card } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { ErrorText, Field } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { Search } from '@/comps/ui/toolbar';
import { List, Row, useSend } from './list';
import type { Config, McpEntry, McpRows, Found, RegistryInput } from '@coder/client/types';

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
/** Name examples; the placeholder takes the first no server has. */
/** Splits a typed command into words, keeping quoted paths whole. */
const shellWords = (text: string): string[] =>
  (text.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(part => part.replace(/^(["'])(.*)\1$/, '$2'));

const EXAMPLES = ['docs', 'search', 'browser', 'files'];
const transport = (entry: McpEntry) => entry.type ?? (entry.url ? 'http' : 'stdio');

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
            type={input.secret ? 'password' : 'text'}
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

/** Search the official MCP registry or type a server in; a pick fills the form. Enter adds. */
function AddServer({
  onAdd,
  error,
  taken,
}: {
  onAdd: (body: { name: string } & McpEntry) => Promise<boolean>;
  error: string;
  taken: string[];
}) {
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<{ q: string; items?: Found[]; error?: string }>();
  const [picked, setPicked] = useState<Found>();
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const form = useRef<HTMLFormElement>(null);

  const run = (q: string) => {
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
    if (!q.trim()) return setFound(undefined);
    timer.current = setTimeout(() => run(q), 250);
  };
  const pick = (server: Found) => {
    setPicked(server);
    setFound(undefined);
    setQuery('');
    const fields = form.current!.elements;
    (fields.namedItem('name') as HTMLInputElement).value = slug(server.title);
    (fields.namedItem('target') as HTMLInputElement).value = targetOf(server);
    requestAnimationFrame(() => {
      const box = form.current;
      (
        box?.querySelector<HTMLInputElement>(
          "input[name^='arg:'], input[name^='env:'], input[name^='header:']",
        ) ?? box?.querySelector('button')
      )?.focus();
    });
  };

  return (
    <Card title="Add an MCP server" actions={<ErrorText value={error} />}>
      <div class="registry">
        <Search value={query} label="Search the MCP registry" onInput={search} />
        {found ? (
          <div
            class="registry-results scroll-box"
            aria-live="polite"
            aria-busy={!found.items && !found.error}
          >
            {found.error ? (
              <div class="registry-note err" role="alert">
                <span class="grow">{found.error}</span>
                <button type="button" class="btn ghost sm" onClick={() => run(found.q)}>
                  Retry
                </button>
              </div>
            ) : !found.items ? (
              <div role="status" aria-label="Searching the registry">
                {[0, 1, 2].map(n => (
                  <div key={n} class="skel">
                    <i />
                    <i />
                  </div>
                ))}
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
                    <b>{server.title}</b> <Badge>{server.type}</Badge>
                    <small>{server.description || server.name}</small>
                  </span>
                </button>
              ))
            ) : (
              <p class="registry-note">
                No server in the registry matches. Type its command or URL below.
              </p>
            )}
          </div>
        ) : null}
      </div>
      <form
        ref={form}
        class="add-form"
        method="post"
        onSubmit={async event => {
          event.preventDefault();
          const values = [...new FormData(event.currentTarget)].map(
            ([key, value]) => [key, String(value).trim()] as const,
          );
          const get = (key: string) => values.find(([name]) => name === key)?.[1] ?? '';
          const group = (prefix: string) =>
            Object.fromEntries(
              values
                .filter(([key, value]) => key.startsWith(prefix) && value)
                .map(([key, value]) => [key.slice(prefix.length), value]),
            );
          const name = get('name');
          const target = get('target');
          if (!name || !target) return;
          const original = picked?.command ? targetOf(picked) : undefined;
          const parts =
            picked && target === original
              ? [picked.command!, ...(picked.args ?? [])]
              : shellWords(target);
          const [command, ...args] = parts.map(part =>
            part.replace(/\{((?:runtime|package):[^}]+)\}/g, (_, name) => get(`arg:${name}`)),
          );
          const env = group('env:');
          const headers = group('header:');
          const entry = /^https?:\/\//.test(target)
            ? {
                url: target,
                ...(picked?.url === target ? { type: picked.type } : {}),
                ...(Object.keys(headers).length ? { headers } : {}),
              }
            : {
                command,
                ...(args.length ? { args } : {}),
                ...(Object.keys(env).length ? { env } : {}),
              };
          setBusy(true);
          const added = await onAdd({
            name,
            ...entry,
            ...(picked?.description ? { description: picked.description } : {}),
          });
          setBusy(false);
          if (added) {
            form.current?.reset();
            setPicked(undefined);
          }
        }}
      >
        <div class="add-grid">
          <Field label="Name">
            <input
              name="name"
              placeholder={EXAMPLES.find(name => !taken.includes(name))}
              autocomplete="off"
              pattern="[A-Za-z0-9][A-Za-z0-9_\-]*"
            />
          </Field>
          <Field label="Command or URL" hint={picked ? picked.description : undefined}>
            <input
              name="target"
              class="mono"
              placeholder="npx -y @acme/mcp or https://mcp.acme.dev"
              autocomplete="off"
            />
          </Field>
          <Inputs kind="arg" list={picked?.argumentInputs ?? []} />
          <Inputs kind="env" list={picked?.env ?? []} />
          <Inputs kind="header" list={picked?.headers ?? []} />
          <button class="btn" disabled={busy}>
            Add
          </button>
        </div>
      </form>
    </Card>
  );
}

/** MCP servers tasks may attach, with what each is and how it connects. */
export function McpList({ first }: { first: McpRows }) {
  const rows = useSend(first);
  const set = (answer: Config) => answer.mcp ?? {};
  const entries = Object.entries(rows.value);
  return (
    <>
      <AddServer
        error={rows.error}
        taken={entries.map(([name]) => name)}
        onAdd={body => rows.send(() => client.mcp.add(body), set)}
      />
      <List title="MCP servers" count={entries.length} error="">
        {entries.map(([name, entry]) => {
          const target = entry.url ?? [entry.command, ...(entry.args ?? [])].join(' ');
          return (
            <Row
              key={name}
              title={name}
              badges={<Badge>{transport(entry)}</Badge>}
              sub={
                entry.description ? (
                  <>
                    <span class="plain">{entry.description}</span>
                    <br />
                    {target}
                  </>
                ) : (
                  target
                )
              }
              remove={{
                title: `Remove ${name}?`,
                body: 'New tasks no longer attach it.',
                onRemove: () => rows.send(() => client.mcp.remove(name), set),
              }}
            />
          );
        })}
      </List>
    </>
  );
}
