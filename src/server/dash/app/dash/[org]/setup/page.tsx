import { dynamic } from '@wular/pnext/dynamic';
import { LinkButton } from '@/comps/ui/button';

import { load, orgOf } from '@/api/load';
import { Page, PageHead } from '@/comps/frame/page-head';
import { Settle } from '@/comps/frame/stream';
import { TunnelGuide } from '@/app/dash/[org]/settings/tunnel-guide';
import { Outcome, readOutcome } from './outcome';

const CreateLink = dynamic(() => import('./create-link').then(m => m.CreateLink));

/** Where a create link starts, and where create, install and link flows end when they know no agent. */
export default function SetupPage({ request }: { request?: Request }) {
  if (!request) return null;
  const url = new URL(request.url);
  const integration = url.searchParams.get('create');
  const state = Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'create'));
  const catalog = load(request)
    .integrations.list()
    .catch(() => []);

  return (
    <Page narrow>
      <PageHead title={integration ? 'Create app' : 'Platform setup'} />
      <Settle
        load={() =>
          catalog.then(entries => {
            const info = entries.find(entry => entry.id === integration);

            return integration ? (
              <>
                <CreateLink integration={integration} state={state} info={info} />
                {info?.unreachable ? (
                  <div id="tunnel">
                    <TunnelGuide port={url.port || '8787'} />
                  </div>
                ) : null}
              </>
            ) : (
              <Outcome
                outcome={readOutcome(url.searchParams) ?? { status: 'failed' }}
                catalog={entries}
              >
                <LinkButton
                  variant="outline"
                  size="sm"
                  href="/dash/[org]/agents"
                  params={{ org: orgOf(request) }}
                >
                  Open agents
                </LinkButton>
              </Outcome>
            );
          })
        }
      />
    </Page>
  );
}
