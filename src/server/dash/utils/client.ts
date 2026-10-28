'use client';

import { useEffect, useRef, useState } from 'preact/hooks';

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

const AWAY_MS = 60_000;
const IDLE_MS = 10 * 60_000;
const INPUT = ['focus', 'blur', 'pointerdown', 'pointermove', 'keydown', 'wheel'];

type Presence = 'focused' | 'present' | 'absent';

/** Tells `change` whether someone is at this tab: shown, with input in the last 10 minutes while focused or the last minute while not; returns its stop. */
export function presence(change: (presence: Presence) => void): () => void {
  let input = Date.now();
  let state: Presence | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const check = () => {
    const focused = document.hasFocus();
    const remaining = (focused ? IDLE_MS : AWAY_MS) - (Date.now() - input);
    const next =
      document.visibilityState === 'hidden' || remaining <= 0
        ? 'absent'
        : focused
          ? 'focused'
          : 'present';
    clearTimeout(timer);
    if (next !== 'absent') timer = setTimeout(check, remaining);
    if (next !== state) change((state = next));
  };
  const touch = () => {
    input = Date.now();
    check();
  };
  for (const type of INPUT) addEventListener(type, touch, { passive: true });
  addEventListener('visibilitychange', check);
  check();

  return () => {
    clearTimeout(timer);
    for (const type of INPUT) removeEventListener(type, touch);
    removeEventListener('visibilitychange', check);
  };
}

/** Whether someone is at this tab, as `presence` tells. */
export function usePresent(): Presence {
  const [state, setState] = useState<Presence>('focused');
  useEffect(() => presence(setState), []);

  return state;
}

/** Runs `work` every `ms` once the last run settles while someone is at the tab, and at once when they are back; returns its stop. */
function poll(work: () => Promise<unknown>, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let present = false;
  let running = false;
  let back = false;
  const next = () => {
    if (!stopped && present) timer = setTimeout(run, ms);
  };
  const run = () => {
    running = true;
    void work()
      .catch(reason => console.error('coder dashboard: poll', reason))
      .finally(() => {
        running = false;
        next();
      });
  };
  const leave = presence(state => {
    const now = state !== 'absent';
    if (now !== present) {
      present = now;
      clearTimeout(timer);
      if (now && !running) (back ? run : next)();
    }
    back = true;
  });

  return () => {
    stopped = true;
    clearTimeout(timer);
    leave();
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
