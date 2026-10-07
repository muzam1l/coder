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
