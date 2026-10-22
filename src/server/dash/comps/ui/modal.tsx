'use client';

import './modal.css';
import { toChildArray, type ComponentChildren } from 'preact';
import { useEffect, useId, useRef } from 'preact/hooks';

import { Button, IconButton } from './button';
import { iX } from './icons';
import { Icon } from './icon';

/** A dialog's tone: a bar on top and the title's icon in its color. */
type Tone = 'neutral' | 'success' | 'warning' | 'error';

/** A modal with a title, a body and its actions after a cancel button; Escape, Cancel or a backdrop click closes it, never while busy. */
export function Modal({
  open = true,
  class: className,
  tone,
  title,
  icon,
  dismiss,
  busy,
  cancel = 'Cancel',
  cancelDanger,
  focus = 'cancel',
  actions,
  onSubmit,
  onClose,
  children,
}: {
  /** Shown on mount unless controlled. */
  open?: boolean;
  class?: string;
  tone?: Tone;
  title: ComponentChildren;
  /** Marks the title, for an outcome. */
  icon?: string;
  /** A close button in the header, for a form. */
  dismiss?: boolean;
  busy?: boolean;
  cancel?: string;
  /** A red cancel button beside other actions, when cancelling stops work in progress. */
  cancelDanger?: boolean;
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
      class={['modal', className, tone && `tone ${tone}`].filter(Boolean).join(' ')}
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
          {dismiss ? <IconButton icon={iX} label="Close" onClick={close} /> : null}
        </header>
        {children}
        <div class="actions">
          <Button
            variant={alone ? 'primary' : 'ghost'}
            danger={!alone && cancelDanger}
            disabled={busy}
            autofocus={focus === 'cancel'}
            onClick={close}
          >
            {cancel}
          </Button>
          {actions}
        </div>
      </form>
    </dialog>
  );
}
