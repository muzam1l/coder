import './tasks-list.css';
import { dynamic } from '@wular/pnext/dynamic';

import { zoneOf } from '@/utils/format';
import { LIST_PAGE } from '@/utils/paged';
import { load } from '@/api/load';
import { Settle } from '@/comps/frame/stream';
import { LoadingCard, LoadingToolbar } from '@/comps/frame/loading-card';
import { SOURCES, STATUSES, listFilters } from '@/app/dash/tasks/list/task';

// Rows arrive rendered; paging and filters hydrate once the list is in view.
const TasksList = dynamic(() => import('./tasks-list').then(m => m.TasksList), {
  load: 'visible',
  ssr: true,
});

/** A task list before it arrives; an agent's own tab has no head and no agent filter. */
export function TasksLoading({ head, agent }: { head?: { title: string }; agent?: boolean }) {
  return (
    <>
      <LoadingToolbar head={head} search="Search tasks" selects={[STATUSES[0]![1]]} more />
      <LoadingCard title="Tasks" label="Loading tasks" />
    </>
  );
}

/** The tasks the address bar's filters select; the page starts these loads before it renders. */
export function loadTasks(
  request: Request,
  agent?: string,
  agentChoices?: Promise<[string, string][]>,
) {
  const params = new URL(request.url).searchParams;
  const filters = {
    q: params.get('q') ?? '',
    status: params.get('status') ?? '',
    source: params.get('source') ?? '',
    agent: agent ? '' : (params.get('agent') ?? ''),
  };

  const first = load(request).tasks.list({
    cursor: '',
    limit: LIST_PAGE,
    summary: true,
    counts: true,
    ...listFilters(filters),
    agent: agent ?? filters.agent,
  });
  const catalog = load(request).integrations.list();
  // The agent filter's choices; an agent's own tab has none.
  const agents = agent
    ? undefined
    : (agentChoices ??
      load(request)
        .agents.list({ cursor: '', limit: 100 })
        .then(
          page => page.items.map((row): [string, string] => [row.id, row.name]),
          () => [],
        ));
  return { filters, first, catalog, agents, tz: zoneOf(request) };
}

export function TasksSection({
  tasks: { filters, first, catalog, agents, tz },
  agent,
  head,
  missing,
}: {
  tasks: ReturnType<typeof loadTasks>;
  agent?: string;
  head?: { title: string };
  /** No credential can run a task yet. */
  missing?: Promise<boolean>;
}) {
  return (
    <Settle
      load={() =>
        Promise.all([first, catalog.catch(() => []), agents, missing]).then(
          ([page, integrations, ids, needs]) => (
            <TasksList
              first={page}
              platforms={integrations.map((entry): [string, string] => [entry.id, entry.name])}
              agents={ids}
              filters={filters}
              agent={agent}
              head={head}
              missing={needs}
              tz={tz}
              now={Date.now()}
            />
          ),
        )
      }
    />
  );
}
