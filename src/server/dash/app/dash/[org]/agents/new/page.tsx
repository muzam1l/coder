import { dynamic } from '@wular/pnext/dynamic';

import { load, loadRunDefaults } from '@/api/load';
import type { Me } from '@coder/client/types';
import { Page } from '@/comps/frame/page-head';
import { Settle } from '@/comps/frame/stream';
import type { Template } from '@/app/dash/[org]/agents/editor/editor';
import { needsTunnel } from '@/api/types';
import { suggestName } from '@/app/dash/[org]/agents/editor/names';

const AgentEditor = dynamic(() =>
  import('@/app/dash/[org]/agents/editor/editor').then(m => m.AgentEditor),
);

/** A new agent from a template, or imported from a repository. */
export default function NewAgentPage({ request }: { request?: Request }) {
  if (!request) return null;
  const url = new URL(request.url);
  const catalog = load(request).integrations.list();
  const run = loadRunDefaults(request);
  const installations = load(request).installations.list();
  const me = load(request).me();
  const asked = url.searchParams.get('template');

  return (
    <Page>
      <Settle
        load={() =>
          Promise.all([catalog, run, installations.catch(() => []), me.catch((): Me => ({}))]).then(
            ([integrations, { models, defaults }, installed, who]) => {
              const reach = integrations.filter(entry => entry.repositories);
              const connected = installed.some(
                ({ value }) =>
                  !value.deletedAt && reach.some(entry => entry.id === value.integration),
              );
              const template = ['import', 'reviewer', 'helper', 'blank'].includes(asked ?? '')
                ? (asked as Template)
                : 'blank';
              return (
                <AgentEditor
                  catalog={integrations}
                  suggested={suggestName()}
                  models={models}
                  defaults={defaults}
                  template={template}
                  connected={connected}
                  connectLabel={reach[0]?.installLabel ?? 'Connect'}
                  tunnel={needsTunnel(who)}
                  port={url.port || '8787'}
                  asked={Object.fromEntries(url.searchParams)}
                />
              );
            },
          )
        }
      />
    </Page>
  );
}
