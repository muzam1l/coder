'use client';

import { iAlert } from '@/comps/ui/icons';
import { Modal } from '@/comps/ui/modal';

/** Opened from a link of a workspace this account is not in: says so, and offers signing in as another account. */
export function ForeignLink({ link }: { link: string }) {
  const again = `/api/auth/sign-in?${new URLSearchParams({ return: link, prompt: 'login' })}`;

  return (
    <Modal
      class="outcome-dialog"
      tone="warning"
      title="Not in this workspace"
      icon={iAlert}
      cancel="Stay here"
      actions={
        <a class="btn" href={again}>
          Sign in with another account
        </a>
      }
      onClose={() => history.replaceState(history.state, '', location.pathname)}
    >
      <p role="status">The link you followed does not belong to this workspace.</p>
    </Modal>
  );
}
