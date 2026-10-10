'use client';

import { ServerClient } from '@coder/client';

export const client = new ServerClient(
  '',
  { cookie: true },
  {
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
export function poll(work: () => Promise<unknown>, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout>;
  let stopped = false;
  const next = () => {
    if (!stopped) timer = setTimeout(run, ms);
  };
  const run = () => {
    if (document.visibilityState === 'hidden') return next();
    void work()
      .catch(() => {})
      .finally(next);
  };
  next();

  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
