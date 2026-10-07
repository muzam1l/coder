'use client';

import './confirm.css';

import type { ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';

/** A modal question before a destructive step; Escape, Cancel or a backdrop click closes it. */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onClose,
  busy,
}: {
  open: boolean;
  title: ComponentChildren;
  body?: ComponentChildren;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();

  useEffect(() => {
    const el = dialog.current!;
    if (open && !el.open) el.showModal();
    else if (!open && el.open) el.close();
  }, [open]);

  const close = () => !busy && onClose();

  return (
    <dialog
      ref={dialog}
      class="confirm"
      aria-labelledby={id}
      onCancel={event => {
        event.preventDefault();
        close();
      }}
      onClick={event => event.target === event.currentTarget && close()}
    >
      <form
        onSubmit={event => {
          event.preventDefault();
          onConfirm();
        }}
      >
        <h2 id={id}>{title}</h2>
        {body ? <p>{body}</p> : null}
        <div class="actions">
          <button type="button" class="btn ghost" disabled={busy} onClick={close} autofocus>
            Cancel
          </button>
          <button class="btn destructive" aria-busy={busy}>
            {confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
  );
}
