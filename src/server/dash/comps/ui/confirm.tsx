'use client';

import type { ComponentChildren } from 'preact';

import { Button } from './button';
import { iTrash } from './icons';
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
        <Button type="submit" danger leftIcon={iTrash} loading={busy}>
          {confirmLabel}
        </Button>
      }
    >
      {body ? <p>{body}</p> : null}
    </Modal>
  );
}
