import type { ComponentChildren } from 'preact';

import { PageHead } from '@/comps/frame/page-head';

export const SETTINGS = [
  { tab: 'credentials', label: 'Credentials' },
  { tab: 'models', label: 'Models' },
  { tab: 'engines', label: 'Engines' },
  { tab: 'mcp', label: 'MCP' },
  { tab: 'runners', label: 'Runners' },
] as const;

export type SettingsTab = (typeof SETTINGS)[number]['tab'];

/** Settings' head; members are managed in Wular. */
export function SettingsHead({ actions }: { actions?: ComponentChildren }) {
  return (
    <PageHead
      title="Settings"
      lead="What every task runs with. Changes apply to the next task."
      actions={actions}
    />
  );
}
