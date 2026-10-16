'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { toastFailure, useAction } from '@/utils/action';
import { Card } from '@/comps/ui/card';
import { Badge } from '@/comps/ui/badge';
import { iPlus } from '@/comps/ui/icons';
import { Button, IconButton } from '@/comps/ui/button';
import { Select } from '@/comps/ui/select';
import { Row } from './list';
import type { ConnectionRow } from '@coder/client/types';
import { CONNECTION_SCOPES } from '@/app/dash/[org]/settings/model-options';

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
  const action = useAction();
  const busy = Boolean(action.pending);

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
        open ? null : (
          <IconButton icon={iPlus} label="Add a task secret" onClick={() => setAdding(true)} />
        )
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
                          void action.run('renew', async () => {
                            put(await client.connections.update(row.id, { key: key.trim() }));
                            setRenewing('');
                          });
                        }}
                      >
                        <input
                          name="key"
                          type="password"
                          aria-label={`New value for ${row.env ?? row.name}`}
                          placeholder="New value"
                          autocomplete="off"
                          aria-busy={busy}
                          ref={input => input?.focus()}
                        />
                        <Button type="submit" loading={busy}>
                          Save
                        </Button>
                      </form>
                    ) : (
                      <Button variant="ghost" size="sm" onClick={() => setRenewing(row.id)}>
                        {row.status === 'ok' ? 'Replace' : 'Reconnect'}
                      </Button>
                    )
                  }
                  remove={{
                    title: `Remove ${row.env ?? row.name}?`,
                    body: 'Tasks stop getting it, and its value is deleted.',
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
                void action.run('add', async () => {
                  put(
                    await client.connections.add({
                      name: env,
                      provider: 'env',
                      key,
                      keyIn: { env },
                      ...(scope ? { owner: 'me' as const } : {}),
                    }),
                  );
                  box.reset();
                  setAdding(false);
                });
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
                placeholder="Value"
                autocomplete="off"
                aria-busy={busy}
                required
              />
              {admin && !local ? (
                <Select
                  label="Who can use this secret"
                  options={CONNECTION_SCOPES}
                  value={scope}
                  onChange={setScope}
                />
              ) : null}
              <Button type="submit" loading={busy}>
                Add
              </Button>
            </form>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
