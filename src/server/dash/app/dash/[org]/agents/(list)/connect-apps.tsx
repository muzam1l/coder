'use client';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { iPlus } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { Button } from '@/comps/ui/button';
import { useOrg } from '@/comps/nav/org';
import { Notice } from '@/comps/ui/notice';

/** One click per built-in app not yet installed here; the platform returns to that app's agent's Platforms tab, which words the outcome. */
export function ConnectApps({
  apps,
}: {
  apps: Array<{ id: string; agent: string; label: string }>;
}) {
  const org = useOrg();
  const action = useAction({ toast: 'Not installed', leaves: true });
  const connect = ({ id: app, agent }: { id: string; agent: string }) =>
    void action.run(app, async () => {
      const back = `/dash/${org}/agents/${encodeURIComponent(agent)}/platforms`;
      location.href = (await client.apps.install(app, back)).url;
    });
  return (
    <Notice>
      <Icon d={iPlus} />
      <span class="grow">Add the built-in agent to your repositories and channels.</span>
      {apps.map(app => (
        <Button
          key={app.id}
          variant="outline"
          size="sm"
          disabled={Boolean(action.pending)}
          loading={action.pending === app.id}
          onClick={() => connect(app)}
        >
          {app.label}
        </Button>
      ))}
    </Notice>
  );
}
