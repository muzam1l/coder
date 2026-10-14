'use client';

import { useState } from 'preact/hooks';
import { useRouter } from '@wular/pnext/navigation/client';

import { toastError } from '@/comps/frame/task-toasts';
import { reasonText } from '@/utils/format';

type Options = {
  /** The failure toast's title. */
  toast?: string;
  /** The page renders again from the server after success. */
  refresh?: boolean;
  /** Success leaves the page or closes this form, so `pending` stays. */
  leaves?: boolean;
};

const FAILED = 'Something went wrong';

/** A failure no action ran, as the same toast. */
export const toastFailure = (reason: unknown) => toastError(FAILED, reasonText(reason));

/** Runs an action: `pending` names the one in flight, a failure shows as a toast, and the answer says whether it worked. */
export function useAction(defaults: Options = {}) {
  const nav = useRouter();
  const [pending, setPending] = useState<string>();

  const run = async (name: string, work: () => Promise<unknown>, options: Options = {}) => {
    const { toast = FAILED, refresh, leaves } = { ...defaults, ...options };
    setPending(name);
    try {
      await work();
    } catch (reason) {
      setPending(undefined);
      toastError(toast, reasonText(reason));
      return false;
    }

    if (!leaves) setPending(undefined);
    if (refresh) nav.refresh();
    return true;
  };

  return { pending, run };
}
