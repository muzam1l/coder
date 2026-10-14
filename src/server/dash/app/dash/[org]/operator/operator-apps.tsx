'use client';

import '@/app/dash/[org]/agents/[slug]/(tabs)/platforms/page.css';

import { useEffect, useId, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { toastFailure } from '@/utils/action';
import { ClientError } from '@coder/client';
import type { OperatorAppRow, OperatorApps as Apps } from '@coder/client/types';
import { Badge } from '@/comps/ui/badge';
import { Field } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { iX } from '@/comps/ui/icons';
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
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const [busy, setBusy] = useState(false);
  useEffect(() => dialog.current!.showModal(), []);
  const close = () => !busy && dialog.current!.close();

  const submit = (form: FormData) => {
    const value = (key: string) => String(form.get(key) ?? '').trim() || undefined;
    setBusy(true);
    void client.operator
      .setUp(row.integration, { name: value('name'), owner: value('owner') })
      .then(({ url }) => {
        location.href = url;
      })
      .catch(reason => {
        // Operator mode ended; the page asks to sign in again.
        if (reason instanceof ClientError && reason.status === 401) return location.reload();
        setBusy(false);
        toastFailure(reason);
      });
  };

  return (
    <dialog
      ref={dialog}
      class="create-dialog"
      aria-labelledby={id}
      onClose={onClose}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onClick={event => event.target === event.currentTarget && close()}
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          submit(new FormData(event.currentTarget));
        }}
      >
        <header>
          <h2 id={id}>Set up shared {row.name} app</h2>
          <button type="button" class="icon-btn" aria-label="Close" onClick={close}>
            <Icon d={iX} />
          </button>
        </header>
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
        <div class="actions">
          <button type="button" class="btn ghost" disabled={busy} onClick={close}>
            Cancel
          </button>
          <button class="btn" disabled={busy || unreachable} aria-busy={busy}>
            Continue on {row.name}
          </button>
        </div>
      </form>
    </dialog>
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
                <button type="button" class="btn secondary sm" onClick={() => setOpen(row)}>
                  Set up
                </button>
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
