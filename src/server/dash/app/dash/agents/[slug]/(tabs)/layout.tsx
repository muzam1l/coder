import type { ComponentChildren } from 'preact';
import { dynamic } from '@wular/pnext/dynamic';

import { iGit, iPencil } from '@/comps/ui/icons';
import { Link } from '@wular/pnext/link';
import { load } from '@/api/load';
import type { AgentRow, TasksPage } from '@coder/client/types';
import { Back, Page } from '@/comps/frame/page-head';
import { Icon } from '@/comps/ui/icon';
import { Stream } from '@/comps/frame/stream';
import { LoadingTabs, Tabs } from '@/comps/ui/tabs';
import { editableAgent } from '@/api/types';
import { backFrom } from '@/comps/frame/heads';
import { LoadingHero, Hero } from '@/app/dash/agents/agent/hero';
import { loadAgent } from '@/api/load';
import { loadTasks } from '@/app/dash/tasks/list/tasks-section';

const NewTaskButton = dynamic(() => import('@/app/dash/tasks/composer').then(m => m.NewTaskButton));

function Actions({ agent }: { agent: AgentRow }) {
  return (
    <>
      {editableAgent(agent) ? (
        <Link class="btn outline" href="/dash/agents/[slug]/edit" params={{ slug: agent.id }}>
          <Icon d={iPencil} />
          Edit
        </Link>
      ) : agent.source === 'repo' && agent.sourceUrl ? (
        <a class="btn outline" href={agent.sourceUrl} target="_blank" rel="noreferrer">
          <Icon d={iGit} />
          Open in repository
        </a>
      ) : null}
      <NewTaskButton agent={agent.id} />
    </>
  );
}

/** The agent's newest task and its task counts. */
const lastTask = (request: Request, slug: string) =>
  load(request).tasks.list({ cursor: '', limit: 1, summary: true, counts: true, agent: slug });

const TABS = [
  ['/dash/agents/[slug]', 'Overview'],
  ['/dash/agents/[slug]/usage', 'Usage'],
  ['/dash/agents/[slug]/platforms', 'Platforms'],
  ['/dash/agents/[slug]/tasks', 'Tasks'],
  ['/dash/agents/[slug]/settings', 'Settings'],
] as const;

/** The agent's header and tabs while its record loads. */
function LoadingAgentHead({ back }: { back: ComponentChildren }) {
  return (
    <>
      <LoadingHero
        back={back}
        actions={
          <button type="button" class="btn" disabled>
            New task
          </button>
        }
      />
      <LoadingTabs labels={TABS.map(([, label]) => label)} />
    </>
  );
}

function AgentHead({
  agent,
  tasks,
  from,
  back,
}: {
  agent: AgentRow;
  tasks?: TasksPage;
  from: string | null;
  back: ComponentChildren;
}) {
  const counts: Partial<Record<(typeof TABS)[number][0], number>> = {
    '/dash/agents/[slug]/platforms': Object.keys(agent.definition?.integrations ?? {}).length,
    '/dash/agents/[slug]/tasks': tasks?.counts?.all,
  };

  return (
    <>
      <Hero agent={agent} back={back} actions={<Actions agent={agent} />} />
      <Tabs
        label="Agent"
        items={TABS.map(([href, label]) => ({
          href,
          params: { slug: agent.id },
          search: from ? { from } : undefined,
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
  const slug = decodeURIComponent(url.pathname.split('/')[3]!);
  const from = url.searchParams.get('from');
  const back = <Back {...backFrom(from, { href: '/dash/agents', params: {}, label: 'Agents' })} />;

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
            <AgentHead agent={agent} tasks={tasks} from={from} back={back} />
          ))
        }
      />
      <div class="tab-body">{children}</div>
    </Page>
  );
}
