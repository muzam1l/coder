import { dynamic } from '@wular/pnext/dynamic';

import { load, orgOf } from '@/api/load';
import type { AgentRow } from '@coder/client/types';
import { Card } from '@/comps/ui/card';
import { Back, Page } from '@/comps/frame/page-head';
import { Settle } from '@/comps/frame/stream';
import { Hero } from '@/app/dash/[org]/agents/agent/hero';
import { loadAgent, loadRunDefaults } from '@/api/load';
import { editableAgent } from '@/api/types';

const AgentEditor = dynamic(() =>
  import('@/app/dash/[org]/agents/editor/editor').then(m => m.AgentEditor),
);

function EditedElsewhere({ agent }: { agent: AgentRow }) {
  return (
    <Card title="Where this agent is edited">
      <p class="body">
        {agent.source === 'repo' ? (
          <>
            This agent is tracked in <b>{agent.repo}</b>. Change its files there and push, and the
            server picks up the new version.{' '}
            {agent.sourceUrl ? (
              <a class="link" href={agent.sourceUrl} target="_blank" rel="noreferrer">
                Open the folder
              </a>
            ) : null}
          </>
        ) : (
          'This agent ships with Coder, so its definition is fixed. How it runs here is yours to change under Settings.'
        )}
      </p>
    </Card>
  );
}

/** The editor gets the whole page: back to the agent, its hero holding Cancel and Publish, then the parts. */
export default async function AgentEditPage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { slug: raw } = await params;
  const slug = Array.isArray(raw) ? raw[0]! : raw!;
  const catalog = load(request).integrations.list();
  const run = loadRunDefaults(request);
  const section = new URL(request.url).searchParams.get('section') ?? undefined;
  const agent = await loadAgent(request, slug);

  return (
    <Page>
      <Settle
        load={() =>
          Promise.all([catalog, run]).then(([integrations, { shape, defaults }]) =>
            editableAgent(agent) ? (
              <AgentEditor
                catalog={integrations}
                agent={agent}
                section={section}
                shape={shape}
                defaults={defaults}
              />
            ) : (
              <>
                <Hero
                  agent={agent}
                  back={
                    <Back
                      href="/dash/[org]/agents/[slug]"
                      params={{ org: orgOf(request), slug }}
                      label={agent.name}
                    />
                  }
                />
                <EditedElsewhere agent={agent} />
              </>
            ),
          )
        }
      />
    </Page>
  );
}
