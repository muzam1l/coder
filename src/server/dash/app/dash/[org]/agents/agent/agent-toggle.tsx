'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import type { AgentRow } from '@coder/client/types';

/** Disable or Enable the agent in this workspace; its other settings stay. */
export function AgentToggle({ agent, class: className }: { agent: AgentRow; class: string }) {
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

  return (
    <button type="button" class={className} disabled={busy} aria-busy={busy} onClick={toggle}>
      {disabled ? 'Enable' : 'Disable'}
    </button>
  );
}
