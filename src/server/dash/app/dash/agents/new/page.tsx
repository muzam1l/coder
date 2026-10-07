import { dynamic } from '@wular/pnext/dynamic';

import { load } from '@/api/load';
import type { Me } from '@coder/client/types';
import { Page } from '@/comps/frame/page-head';
import { Settle } from '@/comps/frame/stream';
import type { Template } from '@/app/dash/agents/editor/editor';
import { needsTunnel } from '@/api/types';
import { NO_MODELS, modelsByEngine } from '@/app/dash/settings/model-options';
import { suggestName } from '@/app/dash/agents/editor/names';

const AgentEditor = dynamic(() =>
  import('@/app/dash/agents/editor/editor').then(m => m.AgentEditor),
);

/** A new agent from a template, or imported from a repository. */
export default function NewAgentPage({ request }: { request?: Request }) {
  if (!request) return null;
  const url = new URL(request.url);
  const catalog = load(request).integrations.list();
  const models = load(request)
    .models.list()
    .catch(() => NO_MODELS);
  const config = load(request)
    .config.get()
    .catch(() => undefined);
  const installations = load(request).installations.list();
  const me = load(request).me();
  const asked = url.searchParams.get('template');

  return (
    <Page>
      <Settle
        load={() =>
          Promise.all([
            catalog,
            models,
            config,
            installations.catch(() => []),
            me.catch((): Me => ({})),
          ]).then(([integrations, shape, shown, installed, who]) => {
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
                models={modelsByEngine(shape)}
                defaults={{
                  engine: shown?.effective.chain?.[0] ?? 'claude',
                  engines: shown?.effective.engines ?? {},
                  builtin: shape.builtin,
                }}
                template={template}
                connected={connected}
                connectLabel={reach[0]?.installLabel ?? 'Connect'}
                tunnel={needsTunnel(who)}
                port={url.port || '8787'}
              />
            );
          })
        }
      />
    </Page>
  );
}
