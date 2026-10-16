import type { ComponentChildren } from 'preact';
import { dynamic } from '@wular/pnext/dynamic';

import { iGit, iPencil, iPlus } from '@/comps/ui/icons';
import { load, orgOf } from '@/api/load';
import type { AgentRow, TasksPage } from '@coder/client/types';
import { Back, Page } from '@/comps/frame/page-head';
import { Button, LinkButton } from '@/comps/ui/button';
import { Stream } from '@/comps/frame/stream';
import { LoadingTabs, Tabs } from '@/comps/ui/tabs';
import { editableAgent } from '@/api/types';
import { LoadingHero, Hero } from '@/app/dash/[org]/agents/agent/hero';
import { loadAgent } from '@/api/load';
import { loadTasks } from '@/app/dash/[org]/tasks/list/tasks-section';

const NewTaskButton = dynamic(() =>
  import('@/app/dash/[org]/tasks/composer').then(m => m.NewTaskButton),
);

function Actions({ agent, org }: { agent: AgentRow; org: string }) {
  return (
    <>
      {editableAgent(agent) ? (
        <LinkButton
          variant="outline"
          leftIcon={iPencil}
          href="/dash/[org]/agents/[slug]/edit"
          params={{ org, slug: agent.id }}
        >
          Edit
        </LinkButton>
      ) : agent.source === 'repo' && agent.sourceUrl ? (
        <Button variant="outline" leftIcon={iGit} href={agent.sourceUrl} external>
          Open in repository
        </Button>
      ) : null}
      {agent.settings?.disabled ? (
        <Button leftIcon={iPlus} disabled title="Enable this agent to start tasks">
          New task
        </Button>
      ) : (
        <NewTaskButton agent={agent.id} />
      )}
    </>
  );
}

/** The agent's newest task and its task counts. */
const lastTask = (request: Request, slug: string) =>
  load(request).tasks.list({ cursor: '', limit: 1, summary: true, counts: true, agent: slug });

const TABS = [
  ['/dash/[org]/agents/[slug]', 'Overview'],
  ['/dash/[org]/agents/[slug]/usage', 'Usage'],
  ['/dash/[org]/agents/[slug]/platforms', 'Platforms'],
  ['/dash/[org]/agents/[slug]/tasks', 'Tasks'],
  ['/dash/[org]/agents/[slug]/settings', 'Settings'],
] as const;

/** The agent's header and tabs while its record loads. */
function LoadingAgentHead({ back }: { back: ComponentChildren }) {
  return (
    <>
      <LoadingHero
        back={back}
        actions={
          <Button leftIcon={iPlus} disabled>
            New task
          </Button>
        }
      />
      <LoadingTabs labels={TABS.map(([, label]) => label)} />
    </>
  );
}

function AgentHead({
  agent,
  org,
  tasks,
  backPath,
  back,
}: {
  agent: AgentRow;
  org: string;
  tasks?: TasksPage;
  backPath: string | null;
  back: ComponentChildren;
}) {
  const counts: Partial<Record<(typeof TABS)[number][0], number>> = {
    '/dash/[org]/agents/[slug]/platforms': Object.keys(agent.definition?.integrations ?? {}).length,
    '/dash/[org]/agents/[slug]/tasks': tasks?.counts?.all,
  };

  return (
    <>
      <Hero agent={agent} back={back} actions={<Actions agent={agent} org={org} />} />
      <Tabs
        label="Agent"
        items={TABS.map(([href, label]) => ({
          href,
          params: { org, slug: agent.id },
          search: backPath ? { back: backPath } : undefined,
          label,
          count: counts[href],
        }))}
      />
    </>
  );
}

/** The agent's header and tabs around the open tab; a tab switch keeps them and swaps only the tab. */
export default function AgentTabsLayout({
  request,
  children,
}: {
  request?: Request;
  children: ComponentChildren;
}) {
  if (!request) return null;
  const url = new URL(request.url);
  // Read from the address, not the params promise, so the layout renders with the loading frame.
  const org = orgOf(request);
  const slug = decodeURIComponent(url.pathname.split('/')[4]!);
  const backPath = url.searchParams.get('back');
  const back = <Back href="/dash/[org]/agents" params={{ org }} label="Agents" back={backPath} />;

  return (
    <Page>
      <Stream
        fallback={<LoadingAgentHead back={back} />}
        load={() =>
          Promise.all([
            loadAgent(request, slug),
            (url.pathname.endsWith('/tasks')
              ? loadTasks(request, slug).first
              : lastTask(request, slug)
            ).catch(() => undefined),
          ]).then(([agent, tasks]) => (
            <AgentHead agent={agent} org={org} tasks={tasks} backPath={backPath} back={back} />
          ))
        }
      />
      <div class="tab-body">{children}</div>
    </Page>
  );
}
