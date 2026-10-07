import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';

import { load } from '@/api/load';
import type { Me } from '@coder/client/types';
import { Page } from '@/comps/frame/page-head';
import { Tabs } from '@/comps/ui/tabs';
import { SETTINGS, SettingsHead } from '@/app/dash/settings/settings-head';

async function Members({ me }: { me: Promise<Me> }) {
  const url = (await me.catch(() => undefined))?.manageMembersUrl;
  return url ? (
    <a class="btn outline" href={url} target="_blank" rel="noreferrer">
      Members in Wular Auth ↗
    </a>
  ) : null;
}

/** Settings' head and tabs around the open tab; a tab switch keeps them and swaps only the tab. */
export default function SettingsTabsLayout({
  request,
  children,
}: {
  request?: Request;
  children: ComponentChildren;
}) {
  if (!request) return null;
  const me = load(request).me();

  return (
    <Page>
      <SettingsHead
        actions={
          <Suspense fallback={null}>
            <Members me={me} />
          </Suspense>
        }
      />
      <Tabs
        label="Settings"
        items={SETTINGS.map(({ tab, label }) => ({
          href: '/dash/settings/[tab]',
          params: { tab },
          label,
        }))}
      />
      <div class="tab-body">{children}</div>
    </Page>
  );
}
