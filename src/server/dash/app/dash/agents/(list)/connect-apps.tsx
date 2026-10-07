'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { iPlus } from '@/comps/ui/icons';
import { reasonText } from '@/utils/format';
import { ErrorText } from '@/comps/ui/field';
import { Icon } from '@/comps/ui/icon';

/** One click per built-in app not yet installed here; the platform returns to this page. */
export function ConnectApps({ apps }: { apps: Array<{ id: string; label: string }> }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const connect = (app: string) => {
    setBusy(app);
    setError('');
    void client.apps
      .install(app, location.pathname)
      .then(({ url }) => {
        location.href = url;
      })
      .catch(reason => {
        setBusy('');
        setError(reasonText(reason));
      });
  };
  return (
    <div class="notice soft" role="status">
      <Icon d={iPlus} />
      <span class="grow">Add the built-in agent to your repositories and channels.</span>
      {apps.map(app => (
        <button
          key={app.id}
          type="button"
          class="btn outline sm"
          disabled={busy !== ''}
          onClick={() => connect(app.id)}
        >
          {app.label}
        </button>
      ))}
      <ErrorText value={error} />
    </div>
  );
}
