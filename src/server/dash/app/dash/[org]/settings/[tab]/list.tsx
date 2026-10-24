'use client';

import './list.css';

import type { ComponentChildren } from 'preact';
import { useRef, useState } from 'preact/hooks';
import { useSearchParams } from '@wular/pnext/navigation/client';

import { client } from '@/utils/client';
import { toastFailure } from '@/utils/action';
import type { Config, ConfigPatch } from '@coder/client/types';
import { mergePatch } from '@coder/core/types';

import { iDots, iPlus } from '@/comps/ui/icons';
import { Button } from '@/comps/ui/button';
import { Card, type CardLook } from '@/comps/ui/card';
import { Icon } from '@/comps/ui/icon';
import { Menu } from '@/comps/ui/menu';
import { MenuItem } from '@/comps/ui/menu-items';
import { ConfirmDialog } from '@/comps/ui/confirm';

/** Config edits shown at once and sent as merge patches; the newest answer wins and a failure rolls back. */
export function useConfig(first: Config) {
  const [value, setValue] = useState(first);
  const sent = useRef(0);
  const saved = useRef(first);
  const patch = (body: ConfigPatch) => {
    const seq = ++sent.current;
    setValue(now => mergePatch(now, body));
    return client.config.patch(body).then(
      answer => {
        saved.current = answer;
        if (seq === sent.current) setValue(answer);
        return answer;
      },
      reason => {
        if (seq === sent.current) {
          setValue(saved.current);
          toastFailure(reason);
        }
        return undefined;
      },
    );
  };
  return { value, patch };
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
      <Button type="submit">Add</Button>
    </form>
  );
}

type Removal = {
  title: string;
  body?: string;
  label?: string;
  /** Its menu item's icon, for a menu whose other items have icons too. */
  icon?: string;
  /** What a chat's delete link names in `?delete=`, which opens this dialog. */
  link?: string;
  onRemove: () => Promise<unknown>;
};

/** A ghost-danger item for a row's ⋯ menu, and the shared dialog that asks before it removes; the dialog sits outside the menu. */
export function useRemove(removal?: Removal) {
  const asked = useSearchParams().get('delete');
  const [open, setOpen] = useState(Boolean(removal?.link && removal.link === asked));
  const [busy, setBusy] = useState(false);
  if (!removal) return {};
  const { title, body, label = 'Remove', icon, onRemove } = removal;
  // A dialog a delete link opened leaves the address without it once it closes.
  const close = () => {
    setOpen(false);
    if (removal.link && removal.link === asked) {
      const url = new URL(location.href);
      url.searchParams.delete('delete');
      history.replaceState(history.state, '', url);
    }
  };
  return {
    item: <MenuItem icon={icon} title={label} danger onClick={() => setOpen(true)} />,
    dialog: open ? (
      <ConfirmDialog
        open
        title={title}
        body={body}
        confirmLabel={label}
        busy={busy}
        onClose={close}
        onConfirm={() => {
          setBusy(true);
          void onRemove().finally(() => {
            setBusy(false);
            close();
          });
        }}
      />
    ) : null,
  };
}

/** A list's add dialog and the + Add button that opens it; a chat's `?add=` link opens it filled in, and closing it drops the link's params. */
export function useAddDialog(label: string, params: string[]) {
  const [open, setOpen] = useState(useSearchParams().has('add'));
  const close = () => {
    setOpen(false);
    const url = new URL(location.href);
    for (const name of ['add', ...params]) url.searchParams.delete(name);
    history.replaceState(history.state, '', url);
  };
  return {
    open,
    show: () => setOpen(true),
    close,
    button: (
      <Button size="sm" leftIcon={iPlus} onClick={() => setOpen(true)}>
        {label}
      </Button>
    ),
  };
}

export const replaceTitle = (name: string, scope: string) =>
  scope === 'workspace' ? `Replace ${name} for the workspace?` : `Replace the personal ${name}?`;

/** The dialog that asks before a save replaces the key saved for a variable in that scope. */
export function useReplace() {
  const [asking, setAsking] = useState<{ title: string; run: () => void }>();
  return {
    ask: (title: string, run: () => void) => setAsking({ title, run }),
    dialog: asking ? (
      <ConfirmDialog
        open
        title={asking.title}
        body="Tasks use the new one from now on."
        confirmLabel="Replace"
        onClose={() => setAsking(undefined)}
        onConfirm={() => {
          setAsking(undefined);
          asking.run();
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
  alignMenu,
  remove,
  muted,
}: {
  title: string;
  badges?: ComponentChildren;
  sub?: ComponentChildren;
  actions?: ComponentChildren;
  menu?: ComponentChildren;
  /** Show the ⋯ menu even when empty, so rows in one list line up. */
  alignMenu?: boolean;
  remove?: Removal;
  /** A row of something past, like an ended install. */
  muted?: boolean;
}) {
  const removing = useRemove(remove);
  return (
    <tr class={muted ? 'muted' : undefined}>
      <td>
        <span class="row-title">
          <b>{title}</b>
          {badges}
        </span>
        {sub ? <span class="sub mono">{sub}</span> : null}
      </td>
      <td class="acts">
        {actions}
        {menu || removing.item || alignMenu ? (
          <Menu button="icon" label="Actions" summary={<Icon d={iDots} />}>
            {menu}
            {removing.item}
            {menu || removing.item ? null : <p class="menu-none">No options</p>}
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
  actions,
  help,
  children,
  add,
  look,
}: {
  title: string;
  count: number;
  actions?: ComponentChildren;
  /** One line on what the list does, above it. */
  help?: ComponentChildren;
  children: ComponentChildren;
  add?: ComponentChildren;
  look?: CardLook;
}) {
  return (
    <Card title={title} count={count} actions={actions} look={look}>
      {help ? <p class="body muted">{help}</p> : null}
      <div class="table-scroll">
        <table class="rows settings">
          <tbody>{children}</tbody>
        </table>
      </div>
      {add}
    </Card>
  );
}
