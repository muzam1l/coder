import './page.css';
import { dynamic } from '@wular/pnext/dynamic';

import { load } from '@/api/load';
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
    ...filters,
  });
  const missing = credentialMissing(load(request));
  const catalog = load(request).integrations.list();

  return (
    <Page>
      <Settle
        load={() =>
          Promise.all([agents, missing, catalog.catch(() => [])]).then(
            ([first, needsCredential, integrations]) => (
              <AgentsGrid
                limit={AGENT_PAGE}
                first={first}
                filters={filters}
                catalog={integrations}
                head={HEADS.agents}
              >
                {needsCredential ? <NeedsCredential /> : null}
              </AgentsGrid>
            ),
          )
        }
      />
    </Page>
  );
}
