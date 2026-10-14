'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { iPlus } from '@/comps/ui/icons';
import { reasonText } from '@/utils/format';
import { toastError } from '@/comps/frame/task-toasts';
import { Icon } from '@/comps/ui/icon';
import { useOrg } from '@/comps/nav/org';
import { Notice } from '@/comps/ui/notice';

/** One click per built-in app not yet installed here; the platform returns to that app's agent's Platforms tab, which words the outcome. */
export function ConnectApps({
  apps,
}: {
  apps: Array<{ id: string; agent: string; label: string }>;
}) {
  const org = useOrg();
  const [busy, setBusy] = useState('');
  const connect = ({ id: app, agent }: { id: string; agent: string }) => {
    setBusy(app);
    void client.apps
      .install(app, `/dash/${org}/agents/${encodeURIComponent(agent)}/platforms`)
      .then(({ url }) => {
        location.href = url;
      })
      .catch(reason => {
        setBusy('');
        toastError('Not installed', reasonText(reason));
      });
  };
  return (
    <Notice>
      <Icon d={iPlus} />
      <span class="grow">Add the built-in agent to your repositories and channels.</span>
      {apps.map(app => (
        <button
          key={app.id}
          type="button"
          class="btn outline sm"
          disabled={busy !== ''}
          aria-busy={busy === app.id}
          onClick={() => connect(app)}
        >
          {app.label}
        </button>
      ))}
    </Notice>
  );
}
