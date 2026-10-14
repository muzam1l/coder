'use client';

import { toChildArray, type ComponentChildren } from 'preact';

import { iAlert, iCheck } from '@/comps/ui/icons';
import { Modal } from '@/comps/ui/modal';

/** A flow's outcome, open on load, with its next steps as `children`; closing drops it from the address. */
export function OutcomeDialog({
  ok,
  title,
  text,
  issues,
  cancel = 'Close',
  children,
}: {
  ok: boolean;
  title: string;
  text: string;
  /** Where a failure is reported. */
  issues?: string;
  cancel?: string;
  children?: ComponentChildren;
}) {
  const steps = toChildArray(children);
  const report =
    !ok && issues ? (
      <a
        class="btn outline"
        href={`${issues}?${new URLSearchParams({ title, body: text })}`}
        target="_blank"
        rel="noreferrer"
      >
        Report issue
      </a>
    ) : null;

  return (
    <Modal
      class="outcome-dialog"
      tone={ok ? 'success' : 'error'}
      title={title}
      icon={ok ? iCheck : iAlert}
      cancel={cancel}
      actions={
        report || steps.length ? (
          <>
            {report}
            {steps}
          </>
        ) : undefined
      }
      onClose={() => history.replaceState(history.state, '', location.pathname)}
    >
      <p role="status">{text}</p>
    </Modal>
  );
}
