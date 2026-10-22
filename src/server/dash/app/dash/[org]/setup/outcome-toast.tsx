'use client';

import { useEffect } from 'preact/hooks';

import { showToast, toastError } from '@/comps/frame/task-toasts';

/** Keys a sign-in's outcome brings back in the address. */
const OUTCOME_KEYS = ['status', 'platform', 'account', 'app', 'appId', 'error', 'outcome'];

/** A sign-in that came back to this page: its outcome as a toast, then the address without it. */
export function OutcomeToast({ ok, title, text }: { ok: boolean; title: string; text: string }) {
  useEffect(() => {
    if (ok) showToast(title, text, 'success');
    else toastError(title, text);
    const url = new URL(location.href);
    for (const key of OUTCOME_KEYS) url.searchParams.delete(key);
    history.replaceState(history.state, '', url);
  }, []);

  return null;
}
