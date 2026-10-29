import { Fragment, type ComponentChildren } from 'preact';
import { dynamic } from '@wular/pnext/dynamic';

import { iAlert, iGit, iPencil, iPlus } from '@/comps/ui/icons';
import { Icon } from '@/comps/ui/icon';
import { Notice } from '@/comps/ui/notice';
import { load, orgOf } from '@/api/load';
import type { AgentRow, Me, TasksPage } from '@coder/client/types';
import { Back, Page } from '@/comps/frame/page-head';
import { Button, LinkButton } from '@/comps/ui/button';
import { Stream } from '@/comps/frame/stream';
import { LoadingTabs, Tabs } from '@/comps/ui/tabs';
import { editableAgent, isAdmin } from '@/api/types';
import { LoadingHero, Hero } from '@/app/dash/[org]/agents/agent/hero';
import { loadAgent } from '@/api/load';
import { loadTasks } from '@/app/dash/[org]/tasks/list/tasks-section';
import { NeedsCredential } from '@/app/dash/[org]/tasks/composer';
import { NeedsPlatform } from '@/app/dash/[org]/agents/agent/needs-platform';
import { ChainLink } from '@/app/dash/[org]/settings/chain-hint';
import { ownModel } from '@/app/dash/[org]/settings/model-options';

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

/** Why the agent answers no events, and where its definition is fixed. */
function NotRunning({ agent, org, admin }: { agent: AgentRow; org: string; admin: boolean }) {
  return (
    <Notice tone="error">
      <Icon d={iAlert} />
      <span class="grow">
        Not running until its definition is fixed.
        {agent.problems!.map(problem => (
          <Fragment key={problem}>
            <br />
            {problem}
          </Fragment>
        ))}
      </span>
      {!admin ? (
        <span class="muted">Ask an admin to fix it.</span>
      ) : editableAgent(agent) ? (
        <LinkButton
          variant="secondary"
          size="sm"
          href="/dash/[org]/agents/[slug]/edit"
          params={{ org, slug: agent.id }}
        >
          Fix in editor
        </LinkButton>
      ) : agent.source === 'repo' && agent.sourceUrl ? (
        <Button variant="outline" size="sm" href={agent.sourceUrl} external>
          Open in repository
        </Button>
      ) : (
        <LinkButton
          variant="outline"
          size="sm"
          href="/dash/[org]/agents/[slug]/settings"
          params={{ org, slug: agent.id }}
        >
          Settings
        </LinkButton>
      )}
    </Notice>
  );
}

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
  me,
  org,
  tasks,
  backPath,
  back,
}: {
  agent: AgentRow;
  me: Me;
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
      {/* One setup step at a time, on every tab. */}
      {agent.problems?.length ? (
        <NotRunning agent={agent} org={org} admin={isAdmin(me)} />
      ) : agent.needsModel ? (
        <NeedsCredential
          label={agent.name}
          reason={
            ownModel(agent) ? (
              <>
                No credential runs {agent.model} or the <ChainLink org={org} />.
              </>
            ) : undefined
          }
        />
      ) : agent.source === 'builtin' && !agent.local && !agent.installations?.length ? (
        <NeedsPlatform agent={agent} />
      ) : null}
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
            load(request)
              .me()
              .catch((): Me => ({})),
            (url.pathname.endsWith('/tasks')
              ? loadTasks(request, slug).first
              : lastTask(request, slug)
            ).catch(() => undefined),
          ]).then(([agent, me, tasks]) => (
            <AgentHead
              agent={agent}
              me={me}
              org={org}
              tasks={tasks}
              backPath={backPath}
              back={back}
            />
          ))
        }
      />
      <div class="tab-body">{children}</div>
    </Page>
  );
}
