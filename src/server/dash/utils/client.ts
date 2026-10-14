'use client';

import { useEffect, useRef } from 'preact/hooks';

import { ServerClient } from '@coder/client';

export const client = new ServerClient(
  '',
  { cookie: true },
  {
    // The page's organization, so a tab open in another one never changes what this one acts on.
    fetch(input, init) {
      const org = /^\/dash\/([^/]+)/.exec(globalThis.location?.pathname ?? '')?.[1];
      if (!org) return fetch(input, init);
      const headers = new Headers(init?.headers);
      headers.set('x-coder-organization', decodeURIComponent(org));

      return fetch(input, { ...init, headers });
    },
    onError(error) {
      if (error.status === 401 && (error.authenticate || /^Sign in/.test(error.message)))
        location.href = `/login?return=${encodeURIComponent(location.pathname + location.search)}`;
    },
  },
);

export async function signOut(): Promise<void> {
  const { url } = await client.signOut();
  location.href = url ?? '/?signed_out=1';
}

/** Runs `work` every `ms` once the last run settles, skipping while the tab is hidden; returns its stop. */
function poll(work: () => Promise<unknown>, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const next = () => {
    if (!stopped) timer = setTimeout(run, ms);
  };
  const run = () => {
    if (document.visibilityState === 'hidden') return next();
    void work()
      .catch(reason => console.error('coder dashboard: poll', reason))
      .finally(next);
  };
  next();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Polls `work` while it is set, and stops on unmount or when `inputs` change; `signal` says a run's poll has stopped. */
export function usePoll(
  work: ((signal: AbortSignal) => Promise<unknown>) | undefined,
  ms: number,
  inputs: unknown[] = [],
) {
  const latest = useRef(work);
  latest.current = work;
  const on = Boolean(work);

  useEffect(() => {
    if (!on) return;
    const abort = new AbortController();
    const stop = poll(async () => latest.current?.(abort.signal), ms);

    return () => {
      abort.abort();
      stop();
    };
  }, [on, ms, ...inputs]);
}
