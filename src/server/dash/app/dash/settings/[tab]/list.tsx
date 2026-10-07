'use client';

import './list.css';

import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import type { Config, ConfigPatch } from '@coder/client/types';

import { iDots } from '@/comps/ui/icons';
import { Card } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { ErrorText } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { ConfirmDialog } from '@/comps/ui/confirm';

/** RFC 7396: objects merge, null deletes, anything else replaces. */
function merged<T>(target: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const out: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else out[key] = merged(out[key], value);
  }
  return out as T;
}

/** Config edits shown at once and sent as merge patches; the newest answer wins and a failure rolls back. */
export function useConfig(first: Config) {
  const [value, setValue] = useState(first);
  const [error, setError] = useState('');
  const sent = useRef(0);
  const saved = useRef(first);
  const patch = (body: ConfigPatch) => {
    const seq = ++sent.current;
    setError('');
    setValue(now => merged(now, body));
    return client.config.patch(body).then(
      answer => {
        saved.current = answer;
        if (seq === sent.current) setValue(answer);
        return true;
      },
      reason => {
        if (seq === sent.current) {
          setValue(saved.current);
          setError(reasonText(reason));
        }
        return false;
      },
    );
  };
  return { value, error, patch };
}

export const EFFORTS = ['low', 'medium', 'high'];

export const PERMISSIONS = ['read-only', 'workspace-write', 'auto'];

/** A change sent to the server; its answer replaces what the list shows. */
export function useSend<T>(first: T) {
  const [value, setValue] = useState(first);
  const [error, setError] = useState('');
  const send = async <R,>(act: () => Promise<R>, apply?: (answer: R) => T) => {
    setError('');
    try {
      const answer = await act();
      if (apply) setValue(apply(answer));
      return true;
    } catch (reason) {
      setError(reasonText(reason));
      return false;
    }
  };
  return { value, setValue, error, setError, send };
}

/** The add row: its fields, and Enter in any of them adds. */
export function AddRow({
  fields,
  onAdd,
}: {
  fields: Array<[name: string, placeholder: string]>;
  onAdd: (values: Record<string, string>) => Promise<boolean>;
}) {
  return (
    <form
      class="add-row"
      method="post"
      onSubmit={async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = Object.fromEntries(
          [...new FormData(form)].map(([key, value]) => [key, String(value).trim()]),
        );
        if (Object.values(values).some(value => !value)) return;
        if (await onAdd(values)) form.reset();
      }}
    >
      {fields.map(([name, placeholder]) => (
        <input
          key={name}
          name={name}
          placeholder={placeholder}
          aria-label={placeholder}
          autocomplete="off"
        />
      ))}
      <button class="btn">Add</button>
    </form>
  );
}

export type Removal = {
  title: string;
  body?: string;
  label?: string;
  onRemove: () => Promise<unknown>;
};

/** A ghost-danger item for a row's ⋯ menu, and the shared dialog that asks before it removes; the dialog sits outside the menu. */
export function useRemove(removal?: Removal) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!removal) return {};
  const { title, body, label = 'Remove', onRemove } = removal;
  return {
    item: <MenuItem title={label} danger onClick={() => setOpen(true)} />,
    dialog: open ? (
      <ConfirmDialog
        open
        title={title}
        body={body}
        confirmLabel={label}
        busy={busy}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setBusy(true);
          void onRemove().finally(() => {
            setBusy(false);
            setOpen(false);
          });
        }}
      />
    ) : null,
  };
}

/** A settings row: its primary action as a button, the rest and Remove in the ⋯ menu. */
export function Row({
  title,
  badges,
  sub,
  actions,
  menu,
  remove,
}: {
  title: string;
  badges?: ComponentChildren;
  sub?: ComponentChildren;
  actions?: ComponentChildren;
  menu?: ComponentChildren;
  remove?: Removal;
}) {
  const removing = useRemove(remove);
  return (
    <tr>
      <td>
        <span class="row-title">
          <b>{title}</b>
          {badges}
        </span>
        {sub ? <span class="sub mono">{sub}</span> : null}
      </td>
      <td class="acts">
        {actions}
        {menu || removing.item ? (
          <Menu summaryClass="icon-btn" label="Actions" summary={<Icon d={iDots} />}>
            {menu}
            {removing.item}
          </Menu>
        ) : null}
        {removing.dialog}
      </td>
    </tr>
  );
}

export function List({
  title,
  count,
  error,
  children,
  add,
}: {
  title: string;
  count: number;
  error: string;
  children: ComponentChildren;
  add?: ComponentChildren;
}) {
  return (
    <Card title={title} count={count} actions={<ErrorText value={error} />}>
      <div class="table-scroll">
        <table class="rows settings">
          <tbody>{children}</tbody>
        </table>
      </div>
      {add}
    </Card>
  );
}
