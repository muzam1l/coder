'use client';

import './modal.css';
import { toChildArray, type ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';

import { iX } from './icons';
import { Icon } from './icon';

/** A modal with a title, a body and its actions after a cancel button; Escape, Cancel or a backdrop click closes it, never while busy. */
export function Modal({
  open = true,
  class: className,
  title,
  icon,
  dismiss,
  busy,
  cancel = 'Cancel',
  focus = 'cancel',
  actions,
  onSubmit,
  onClose,
  children,
}: {
  /** Shown on mount unless controlled. */
  open?: boolean;
  class?: string;
  title: ComponentChildren;
  /** Marks the title, for an outcome. */
  icon?: string;
  /** A close button in the header, for a form. */
  dismiss?: boolean;
  busy?: boolean;
  cancel?: string;
  /** Where focus lands when it opens; an action marks itself `autofocus`. */
  focus?: 'cancel' | 'actions';
  actions?: ComponentChildren;
  /** Without one, the form only closes the dialog. */
  onSubmit?: (event: SubmitEvent) => void;
  /** After the dialog closed, however it did. */
  onClose: () => void;
  children?: ComponentChildren;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const el = dialog.current!;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  const close = () => !busy && dialog.current!.close();
  // Alone, the cancel button is the one action.
  const alone = toChildArray(actions).length === 0;

  return (
    <dialog
      ref={dialog}
      class={className ? `modal ${className}` : 'modal'}
      aria-labelledby={id}
      onClose={onClose}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onClick={event => event.target === event.currentTarget && close()}
    >
      <form method={onSubmit ? undefined : 'dialog'} onSubmit={onSubmit}>
        <header>
          {icon ? <Icon d={icon} /> : null}
          <h2 id={id}>{title}</h2>
          {dismiss ? (
            <button type="button" class="icon-btn" aria-label="Close" onClick={close}>
              <Icon d={iX} />
            </button>
          ) : null}
        </header>
        {children}
        <div class="actions">
          <button
            type="button"
            class={alone ? 'btn' : 'btn ghost'}
            disabled={busy}
            autofocus={focus === 'cancel'}
            onClick={close}
          >
            {cancel}
          </button>
          {actions}
        </div>
      </form>
    </dialog>
  );
}
