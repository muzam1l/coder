'use client';

import './confirm.css';
import type { ComponentChildren } from 'preact';

import { iTrash } from './icons';
import { Icon } from './icon';
import { Modal } from './modal';

/** A modal question before a destructive step. */
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
  return (
    <Modal
      open={open}
      class="confirm"
      title={title}
      busy={busy}
      onSubmit={event => {
        event.preventDefault();
        onConfirm();
      }}
      onClose={onClose}
      actions={
        <button class="btn destructive" aria-busy={busy}>
          <Icon d={iTrash} />
          {confirmLabel}
        </button>
      }
    >
      {body ? <p>{body}</p> : null}
    </Modal>
  );
}
