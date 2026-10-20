'use client';

import '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/page.css';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { toastFailure } from '@/utils/action';
import { ClientError } from '@coder/client';
import type { OperatorAppRow, OperatorApps as Apps } from '@coder/client/types';
import { Badge } from '@/comps/ui/badge';
import { Field } from '@/comps/ui/field';
import { Button } from '@/comps/ui/button';
import { iOut } from '@/comps/ui/icons';
import { Modal } from '@/comps/ui/modal';
import { List, Row } from '@/app/dash/[org]/settings/[tab]/list';

/** The set-up form for one platform's shared app, as a dialog like an agent's Create app. */
function SetUpDialog({
  row,
  product,
  unreachable,
  onClose,
}: {
  row: OperatorAppRow;
  product: string;
  /** Platforms cannot reach this server, so the app cannot be created yet. */
  unreachable?: boolean;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);

  const submit = (event: SubmitEvent) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget as HTMLFormElement);
    const value = (key: string) => String(form.get(key) ?? '').trim() || undefined;
    setBusy(true);
    void client.operator
      .setUp(row.integration, { name: value('name'), owner: value('owner') })
      .then(({ url }) => {
        location.href = url;
      })
      .catch(reason => {
        // Operator mode ended; the page signs in again.
        if (reason instanceof ClientError && reason.status === 401)
          return location.assign(location.pathname);
        setBusy(false);
        toastFailure(reason);
      });
  };

  return (
    <Modal
      class="create-dialog"
      title={`Set up shared ${row.name} app`}
      dismiss
      busy={busy}
      onSubmit={submit}
      onClose={onClose}
      actions={
        <Button type="submit" rightIcon={iOut} disabled={unreachable} loading={busy}>
          Continue on {row.name}
        </Button>
      }
    >
      {unreachable ? (
        <p class="flash err">
          {row.name} cannot reach this server yet. Set a public address first: run the server with
          PUBLIC_URL set to an address {row.name} can reach.
        </p>
      ) : null}
      <p class="muted">
        One app on {row.name} serves the built-in agent in every workspace. People see its name on
        consent screens, as in {product} wants to connect.
      </p>
      <Field label="App name">
        <input name="name" defaultValue={product} autocomplete="off" required />
      </Field>
      {row.organizationApps ? (
        <Field
          label={`${row.name} organization`}
          hint="owns the app; leave empty to own it on your personal account"
        >
          <input name="owner" placeholder="your-org" autocomplete="off" />
        </Field>
      ) : null}
    </Modal>
  );
}

/** One shared app per platform for the built-in agent in every workspace; Set up opens its create dialog. */
export function OperatorApps({ first }: { first: Apps }) {
  const [open, setOpen] = useState<OperatorAppRow>();

  return (
    <>
      <List title="Built-in apps" count={first.platforms.length}>
        {first.platforms.map(row => (
          <Row
            key={row.integration}
            title={row.name}
            badges={row.app ? <Badge tone="ok">set up</Badge> : null}
            sub={
              row.app ? row.app.name : 'Not set up. Workspaces cannot add the built-in agent here.'
            }
            actions={
              row.app ? null : (
                <Button variant="secondary" size="sm" onClick={() => setOpen(row)}>
                  Set up
                </Button>
              )
            }
          />
        ))}
      </List>
      {open ? (
        <SetUpDialog
          row={open}
          product={first.name}
          unreachable={first.unreachable}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </>
  );
}
