'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { Button } from '@/comps/ui/button';
import { useAction } from '@/utils/action';
import type { AgentRow } from '@coder/client/types';

/** Disable or Enable the agent in this workspace; its other settings stay. `link` shows it as a text link. */
export function AgentToggle({ agent, link }: { agent: AgentRow; link?: boolean }) {
  const action = useAction({ refresh: true });
  const busy = Boolean(action.pending);
  const saved = Boolean(agent.settings?.disabled);
  // A toggle shows at once, until the refreshed agent says the same.
  const [toggled, setToggled] = useState({ saved, disabled: saved });
  const disabled = toggled.saved === saved ? toggled.disabled : saved;

  const toggle = () =>
    void action.run('toggle', async () => {
      await client.agents.settings(agent.id, { ...agent.settings, disabled: !disabled });
      setToggled({ saved, disabled: !disabled });
    });

  const label = disabled ? 'Enable' : 'Disable';

  return link ? (
    <button type="button" class="link" disabled={busy} aria-busy={busy} onClick={toggle}>
      {label}
    </button>
  ) : (
    <Button variant="outline" loading={busy} onClick={toggle}>
      {label}
    </Button>
  );
}
