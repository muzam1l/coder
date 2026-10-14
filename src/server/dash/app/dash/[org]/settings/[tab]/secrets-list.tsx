'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { Card } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { ErrorText } from '@/comps/ui/field';
import { Badge } from '@/comps/ui/badge';
import { Select } from '@/comps/ui/select';
import { Row } from './list';
import type { ConnectionRow } from '@coder/client/types';

const SCOPES: Array<[string, string]> = [
  ['me', 'Just me'],
  ['', 'Workspace'],
];

/** Secrets tasks read as environment variables; Enter adds one, and a broken one takes a new value in place. */
export function TaskSecrets({
  first,
  local,
  admin,
}: {
  first: ConnectionRow[];
  local: boolean;
  admin: boolean;
}) {
  const [rows, setRows] = useState(first);
  const [adding, setAdding] = useState(false);
  const [scope, setScope] = useState(admin || local ? '' : 'me');
  const [renewing, setRenewing] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const failed = (reason: unknown) => {
    setBusy(false);
    setError(reasonText(reason));
  };
  const open = adding || !rows.length;
  const put = (row: ConnectionRow) =>
    setRows(now =>
      now.some(each => each.id === row.id)
        ? now.map(each => (each.id === row.id ? row : each))
        : [...now, row],
    );

  return (
    <Card
      title="Task secrets"
      count={rows.length || undefined}
      actions={
        <>
          <ErrorText value={error} />
          {!open ? (
            <button type="button" class="btn ghost sm" onClick={() => setAdding(true)}>
              Add
            </button>
          ) : null}
        </>
      }
    >
      <div class="cred-engine">
        <p class="muted cred-note">
          Tasks read these as environment variables, like a test API key or a deploy token.
        </p>
        {rows.length ? (
          <table class="rows creds">
            <tbody>
              {rows.map(row => (
                <Row
                  key={row.id}
                  title={row.env ?? row.name}
                  badges={
                    <>
                      <Badge>{row.owner ? (row.mine ? 'personal' : 'member') : 'workspace'}</Badge>
                      {row.status === 'ok' ? null : <Badge tone="warn">needs a new value</Badge>}
                    </>
                  }
                  actions={
                    renewing === row.id ? (
                      <form
                        class="cred-add"
                        method="post"
                        onSubmit={event => {
                          event.preventDefault();
                          const key = String(new FormData(event.currentTarget).get('key') ?? '');
                          if (!key.trim()) return;
                          setBusy(true);
                          setError('');
                          void client.connections.update(row.id, { key: key.trim() }).then(next => {
                            put(next);
                            setRenewing('');
                            setBusy(false);
                          }, failed);
                        }}
                      >
                        <input
                          name="key"
                          type="password"
                          aria-label={`New value for ${row.env ?? row.name}`}
                          placeholder="New value, then Enter"
                          autocomplete="off"
                          aria-busy={busy}
                          ref={input => input?.focus()}
                        />
                        <button hidden />
                      </form>
                    ) : (
                      <button
                        type="button"
                        class="btn ghost sm"
                        onClick={() => setRenewing(row.id)}
                      >
                        {row.status === 'ok' ? 'Replace' : 'Reconnect'}
                      </button>
                    )
                  }
                  remove={{
                    title: `Remove ${row.env ?? row.name}?`,
                    body: 'Tasks stop getting it, and its value is deleted.',
                    onRemove: () =>
                      client.connections
                        .remove(row.id)
                        .then(() => setRows(now => now.filter(each => each.id !== row.id)), failed),
                  }}
                />
              ))}
            </tbody>
          </table>
        ) : null}
        {open ? (
          <div class="cred-new">
            <form
              class="cred-add"
              method="post"
              onSubmit={event => {
                event.preventDefault();
                const box = event.currentTarget;
                const values = new FormData(box);
                const env = String(values.get('env') ?? '').trim();
                const key = String(values.get('key') ?? '').trim();
                if (!env || !key) return;
                setBusy(true);
                setError('');
                void client.connections
                  .add({
                    name: env,
                    provider: 'env',
                    key,
                    keyIn: { env },
                    ...(scope ? { owner: 'me' as const } : {}),
                  })
                  .then(row => {
                    put(row);
                    box.reset();
                    setBusy(false);
                    setAdding(false);
                  }, failed);
              }}
            >
              <input
                name="env"
                class="mono cred-var"
                aria-label="Secret variable"
                placeholder="STRIPE_SECRET_KEY"
                pattern="[A-Za-z_][A-Za-z0-9_]*"
                autocomplete="off"
                spellcheck={false}
                required
              />
              <input
                name="key"
                type="password"
                aria-label="Secret value"
                placeholder="Value, then Enter"
                autocomplete="off"
                aria-busy={busy}
                required
              />
              {admin && !local ? (
                <Select
                  label="Who can use this secret"
                  options={SCOPES}
                  value={scope}
                  onChange={setScope}
                />
              ) : null}
              <button hidden />
            </form>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
