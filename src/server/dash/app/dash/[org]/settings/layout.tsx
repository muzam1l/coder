import type { ComponentChildren } from 'preact';
import { Suspense } from 'preact/compat';

import { load, loadAgent, orgOf } from '@/api/load';
import type { Me } from '@coder/client/types';
import { Back, Page } from '@/comps/frame/page-head';
import { Tabs } from '@/comps/ui/tabs';
import { SETTINGS, SettingsHead } from '@/app/dash/[org]/settings/settings-head';

async function Members({ me }: { me: Promise<Me> }) {
  const url = (await me.catch(() => undefined))?.manageMembersUrl;
  return url ? (
    <a class="btn outline" href={url} target="_blank" rel="noreferrer">
      Members in Wular Auth ↗
    </a>
  ) : null;
}

/** Back to the page that sent the visitor here, named for its agent once that loads. */
async function ReturnBack({ request, back }: { request: Request; back: string }) {
  const slug = /^\/dash\/[^/]+\/agents\/([^/?#]+)/.exec(back)?.[1];
  const named = slug
    ? await Promise.resolve()
        .then(() => loadAgent(request, decodeURIComponent(slug)))
        .then(
          agent => agent.name,
          () => undefined,
        )
    : undefined;

  return (
    <Back
      href="/dash/[org]"
      params={{ org: orgOf(request) }}
      label="Back"
      back={back}
      named={named}
    />
  );
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
  const back = new URL(request.url).searchParams.get('return');

  return (
    <Page>
      <SettingsHead
        back={
          back ? (
            <Suspense
              fallback={<Back href="/dash/[org]" params={{ org }} label="Back" back={back} />}
            >
              <ReturnBack request={request} back={back} />
            </Suspense>
          ) : undefined
        }
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
      <div class="tab-body">{children}</div>
    </Page>
  );
}
