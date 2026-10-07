'use client';

import { useState } from 'preact/hooks';

import { ErrorText } from '@/comps/ui/field';
import { client } from '@/utils/client';
import { reasonText } from '@/utils/format';
import { AuthPanel } from '@/comps/frame/auth-panel';

export default function LinkPage() {
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const token =
    typeof location === 'undefined'
      ? ''
      : (new URLSearchParams(location.search).get('token') ?? '');
  return (
    <AuthPanel
      tag="connect"
      title="Connect your account"
      lead={done || 'Link this platform identity to your signed-in Coder account.'}
    >
      {done ? null : (
        <button
          type="button"
          class="btn wide"
          onClick={() =>
            void client
              .linkAccount(token)
              .then(result =>
                setDone(`${result.platform} account ${result.platformUserId} is connected.`),
              )
              .catch(reason => setError(reasonText(reason)))
          }
        >
          Connect
        </button>
      )}
      <ErrorText value={error} />
    </AuthPanel>
  );
}
