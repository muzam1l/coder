import { Button } from '@/comps/ui/button';
import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';

import { load, orgOf } from '@/api/load';
import type { Me } from '@coder/client/types';
import { Page } from '@/comps/frame/page-head';
import { Tabs } from '@/comps/ui/tabs';
import { SETTINGS, SettingsHead } from '@/app/dash/[org]/settings/settings-head';
import { RememberedBack } from '@/comps/nav/back';
import { rememberedBack } from '@/comps/nav/back-cookie';

async function Members({ me }: { me: Promise<Me> }) {
  const url = (await me.catch(() => undefined))?.manageMembersUrl;
  return url ? (
    <Button variant="outline" href={url} external>
      Members in Wular Auth
    </Button>
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
  const org = orgOf(request);
  const me = load(request).me();
  const back = rememberedBack(request.headers.get('cookie') ?? '');

  return (
    <Page>
      <SettingsHead
        back={<RememberedBack initial={back} />}
        actions={
          <Suspense fallback={null}>
            <Members me={me} />
          </Suspense>
        }
      />
      <Tabs
        label="Settings"
        items={SETTINGS.map(({ tab, label }) => ({
          href: '/dash/[org]/settings/[tab]',
          params: { org, tab },
          label,
        }))}
      />
      <div class="tab-body settings-body">{children}</div>
    </Page>
  );
}
