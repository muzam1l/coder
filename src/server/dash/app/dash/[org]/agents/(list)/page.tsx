import './page.css';
import { dynamic } from '@wular/pnext/dynamic';

import { load, orgOf } from '@/api/load';
import type { IntegrationInfo } from '@coder/client/types';
import { Page } from '@/comps/frame/page-head';
import { NeedsCredential } from '@/app/dash/[org]/tasks/composer';
import { Settle } from '@/comps/frame/stream';
import { credentialMissing } from '@/app/dash/[org]/tasks/composer-data';
import { HEADS } from '@/comps/frame/heads';

/** Agent cards per page: whole rows of two or three. */
const AGENT_PAGE = 18;

// Rows arrive rendered; paging and search hydrate once the list is in view.
const AgentsGrid = dynamic(() => import('./agents-grid').then(m => m.AgentsGrid), {
  load: 'visible',
  ssr: true,
});
const ConnectApps = dynamic(() => import('./connect-apps').then(m => m.ConnectApps));

/** Built-in apps this workspace has not installed, labelled in each platform's words. */
function connectable(
  apps: Array<{ id: string; integration: string; agent: string }>,
  integrations: IntegrationInfo[],
) {
  return apps.map(value => ({
    id: value.id,
    agent: value.agent,
    label:
      integrations.find(entry => entry.id === value.integration)?.installLabel ??
      `Connect ${value.integration}`,
  }));
}

export default function AgentsPage({ request }: { request?: Request }) {
  if (!request) return null;
  const url = new URL(request.url);
  const filters = {
    q: url.searchParams.get('q') ?? '',
    platform: url.searchParams.get('platform') ?? '',
    type: url.searchParams.get('type') ?? '',
  };

  const agents = load(request).agents.list({
    cursor: '',
    limit: AGENT_PAGE,
    connect: true,
    ...filters,
  });
  const missing = credentialMissing(load(request));
  const catalog = load(request).integrations.list();

  return (
    <Page>
      <Settle
        load={() =>
          Promise.all([agents, missing, catalog.catch(() => [])]).then(
            ([first, needsCredential, integrations]) => {
              const connect = connectable(first.connectable ?? [], integrations);
              return (
                <AgentsGrid
                  limit={AGENT_PAGE}
                  first={first}
                  filters={filters}
                  catalog={integrations}
                  head={HEADS.agents}
                >
                  {connect.length ? <ConnectApps apps={connect} /> : null}
                  {needsCredential ? (
                    <NeedsCredential reason="Agents need a model credential to run." />
                  ) : null}
                </AgentsGrid>
              );
            },
          )
        }
      />
    </Page>
  );
}
