'use client';

import { useEffect, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useRouter } from '@wular/pnext/navigation/client';
import type { AgentRow } from '@coder/client/types';
import { reasonText } from '@/utils/format';

/** Disable or Enable the agent in this workspace; its other settings stay. */
export function AgentToggle({
  agent,
  class: className,
  onError,
}: {
  agent: AgentRow;
  class: string;
  onError?: (message: string) => void;
}) {
  const nav = useRouter();
  const saved = Boolean(agent.settings?.disabled);
  const [disabled, setDisabled] = useState(saved);
  const [busy, setBusy] = useState(false);

  useEffect(() => setDisabled(saved), [saved]);

  const toggle = () => {
    setBusy(true);
    onError?.('');
    void client.agents
      .settings(agent.id, { ...agent.settings, disabled: !disabled })
      .then(() => {
        setDisabled(!disabled);
        nav.refresh();
      })
      .catch(reason => onError?.(reasonText(reason)))
      .finally(() => setBusy(false));
  };

  return (
    <button type="button" class={className} disabled={busy} aria-busy={busy} onClick={toggle}>
      {disabled ? 'Enable' : 'Disable'}
    </button>
  );
}
