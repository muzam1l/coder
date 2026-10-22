import type { ComponentChildren } from 'preact';

import { PageHead } from '@/comps/frame/page-head';

export const SETTINGS = [
  { tab: 'connections', label: 'Connections' },
  { tab: 'credentials', label: 'Credentials' },
  { tab: 'models', label: 'Models' },
  { tab: 'engines', label: 'Engines' },
  { tab: 'runners', label: 'Runners' },
] as const;

/** Settings' head; members are managed in Wular. */
export function SettingsHead({
  actions,
  back,
}: {
  actions?: ComponentChildren;
  back?: ComponentChildren;
}) {
  return (
    <PageHead
      back={back}
      title="Settings"
      lead="What every task runs with. Changes apply to the next task."
      actions={actions}
    />
  );
}
