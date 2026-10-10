'use client';

import './tasks-list.css';

import { dynamic } from '@wular/pnext/dynamic';
import { useEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { formatCount, formatDate, formatDay, formatDuration } from '@/utils/format';
import {
  iAgent,
  iClock,
  iDots,
  iFolder,
  iMonitor,
  iPlug,
  iPlus,
  iTerminal,
} from '@/comps/ui/icons';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { Link } from '@wular/pnext/link';
import { useRouter } from '@wular/pnext/navigation/client';
import { usePaged } from '@/utils/paged';
import type {
  IntegrationInfo,
  TaskCounts,
  TaskEvent,
  TaskRow,
  TasksPage,
} from '@coder/client/types';
import { BrandIcon } from '@/app/dash/agents/agent/agent-pills';
import { Card, Empty } from '@/comps/ui/card';
import { Id } from '@/comps/ui/badge';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { ErrorText } from '@/comps/ui/field';
import { approvalParts } from '@/app/dash/tasks/[id]/task-actions';
import { reasonText } from '@/utils/format';
import { Status } from './status';
import { Icon } from '@/comps/ui/icon';
import { Filter, type Facet } from '@/comps/ui/filter';
import { addRows, listOrder, taskActive, withAdded } from '@/app/dash/tasks/list/task';
import { taskTitle } from '@/app/dash/tasks/list/task';
import { LIST_PAGE } from '@/utils/paged';
import { Search, Toolbar, queryOf, useFilters } from '@/comps/ui/toolbar';
import { Tail } from '@/comps/ui/tail';
import {
  SOURCES,
  STATUSES,
  folderName,
  listFilters,
  sourceLabel,
} from '@/app/dash/tasks/list/task';
import { NeedsCredential } from '@/app/dash/tasks/composer';
import { useTaskEvents } from '@/comps/frame/task-toasts';

const NewTaskButton = dynamic(
  () => import('@/app/dash/tasks/composer').then(m => m.NewTaskButton),
  {
    // TODO: stays disabled after client navigation until pnext SSRs nested dynamic() like Next.js.
    loading: () => (
      <button type="button" class="btn new-task" disabled>
        <Icon d={iPlus} />
        New task
      </button>
    ),
  },
);

type Keys = 'q' | 'status' | 'source' | 'agent';

const SOURCE_ICONS: Record<string, string> = {
  dashboard: iMonitor,
  cli: iTerminal,
  schedule: iClock,
};
const sourceIcon = (source: string) => SOURCE_ICONS[source] ?? iPlug;

/** How long ago, under a day; the date after that. */
function ago(value: number, now: number, tz: string) {
  const minutes = Math.round((now - value) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)} h ago`;
  return formatDay(value, tz);
}

function TaskRowView({
  task,
  brand,
  back,
  scoped,
  tz,
  now,
  onDone,
  onError,
}: {
  task: TaskRow;
  /** The source platform's brand art, when it has one. */
  brand?: IntegrationInfo['brand'];
  onDone: (what: RowAction) => void;
  onError: (message: string) => void;
  /** The list to return to, when it is not the plain Tasks page. */
  back?: string;
  /** On an agent's own list, which names no agent. */
  scoped?: boolean;
  tz: string;
  now: number;
}) {
  const elapsed =
    task.startedAt === undefined ? undefined : (task.finishedAt ?? now) - task.startedAt;
  const source = task.task.event?.integration ?? task.task.source ?? 'dashboard';
  const kind = task.task.event?.type ?? (task.task.flow === 'default' ? undefined : task.task.flow);

  return (
    <tr>
      <td>
        <Link
          class="cover"
          href="/dash/tasks/[id]"
          params={{ id: task.task.id }}
          search={back ? { back } : undefined}
        >
          {taskTitle(task)}
        </Link>
        <span class="sub">
          {scoped ? null : (
            <>
              <Icon d={iAgent} />
              {`${task.task.agent} · `}
            </>
          )}
          <Id value={task.task.id} />
          {kind ? ` · ${kind}` : null}
          {task.task.cwd ? (
            <>
              {' · '}
              <span title={task.task.cwd}>
                <Icon d={iFolder} />
                {folderName(task.task.cwd)}
              </span>
            </>
          ) : null}
        </span>
      </td>
      <td>
        <Status status={task.status} />
      </td>
      <td class="when" title={formatDate(task.createdAt, tz)}>
        {ago(task.createdAt, now, tz)}
      </td>
      <td class="num">{formatDuration(elapsed)}</td>
      <td>
        <span class="source" title={sourceLabel(source)}>
          {brand ? <BrandIcon brand={brand} /> : <Icon d={sourceIcon(source)} />}
          {sourceLabel(source)}
        </span>
        <span class="row-acts">
          <RowActions task={task} onDone={onDone} onError={onError} />
        </span>
      </td>
    </tr>
  );
}

/** Stop, Archive and Delete behind a row's ⋯ menu; the list hears what happened and drops or refreshes the row. */
type RowAction = 'cancel' | 'archive' | 'delete' | 'approve';

function RowActions({
  task,
  onDone,
  onError,
}: {
  task: TaskRow;
  onDone: (what: RowAction) => void;
  onError: (message: string) => void;
}) {
  const [deleting, setDeleting] = useState<'ask' | 'busy'>();
  const act = (what: RowAction, decision?: 'accept' | 'decline') => {
    onError('');
    const call =
      what === 'approve'
        ? client.tasks.approve(
            task.task.id,
            approvalParts(task.approval).id ?? '',
            decision ?? 'decline',
          )
        : what === 'delete'
          ? client.tasks.delete(task.task.id)
          : client.tasks[what](task.task.id);

    void call
      .then(
        () => onDone(what),
        reason => onError(reasonText(reason)),
      )
      .finally(() => setDeleting(undefined));
  };
  return (
    <>
      <Menu summary={<Icon d={iDots} />} summaryClass="icon-btn" label="Task actions" align="right">
        {task.approval ? (
          <MenuItem title="Approve" onClick={() => act('approve', 'accept')} />
        ) : null}
        {task.approval ? <MenuItem title="Deny" onClick={() => act('approve', 'decline')} /> : null}
        {taskActive(task) ? <MenuItem title="Stop" onClick={() => act('cancel')} /> : null}
        {task.archivedAt ? null : <MenuItem title="Archive" onClick={() => act('archive')} />}
        <MenuItem title="Delete" danger onClick={() => setDeleting('ask')} />
      </Menu>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this task?"
        body="Its conversation, activity and diff go with it."
        confirmLabel="Delete"
        busy={deleting === 'busy'}
        onConfirm={() => {
          setDeleting('busy');
          act('delete');
        }}
        onClose={() => setDeleting(undefined)}
      />
    </>
  );
}

/** Tasks newest first, in pages as the list scrolls; search and filters run on the server, running ones stay live. */
export function TasksList({
  first,
  platforms,
  brands = {},
  agents = [],
  filters,
  agent,
  head,
  missing,
  tz,
  now,
}: {
  first: TasksPage;
  /** Platform ids, the sources besides the dashboard, CLI and schedule. */
  platforms: [string, string][];
  /** Each platform's brand art, as the Agents page shows it. */
  brands?: Record<string, IntegrationInfo['brand']>;
  /** The first agents, for the agent filter before typing. */
  agents?: [string, string][];
  filters: Record<Keys, string>;
  agent?: string;
  /** On the tasks page the toolbar is the page head. */
  head?: { title: string };
  /** No credential can run a task yet. */
  missing?: boolean;
  tz: string;
  now: number;
}) {
  const { values, set, query } = useFilters<Keys>(filters);
  const initial = queryOf(filters);
  const scope = agent ? `&agent=${encodeURIComponent(agent)}` : '';
  const path = agent ? `/dash/agents/${encodeURIComponent(agent)}/tasks` : '/dash/tasks';
  const back = query || agent ? `${path}${query ? `?${query}` : ''}` : undefined;
  const options = {
    limit: LIST_PAGE,
    summary: true,
    counts: true,
    ...listFilters(values),
    agent: agent ?? values.agent,
  };
  const facets: Facet<Keys>[] = [
    { key: 'status', label: 'Status', options: STATUSES, inline: true },
    {
      key: 'source',
      label: 'Source',
      options: [...SOURCES, ...platforms],
      icon: value => (brands[value] ? <BrandIcon brand={brands[value]} /> : sourceIcon(value)),
    },
  ];
  if (!agent)
    facets.push({
      key: 'agent',
      label: 'Agent',
      options: agents,
      icon: () => iAgent,
      search: (q, limit) =>
        client.agents
          .list({ cursor: '', limit, q })
          .then(page => page.items.map((row): [string, string] => [row.id, row.name])),
    });
  const list = usePaged<TaskRow>({
    name: `tasks${scope}`,
    fetchPage: cursor => client.tasks.list({ ...options, cursor }),
    query,
    first,
    initial,
  });
  const [fresh, setFresh] = useState<{
    rows: Record<string, TaskRow>;
    /** Tasks newer than the loaded pages, on top. */
    added: TaskRow[];
    counts?: TaskCounts;
    query?: string;
  }>({ rows: {}, added: [] });
  const [gone, setGone] = useState<string[]>([]);
  // Rows hidden after an archive or delete come back into view when the filters change.
  useEffect(() => setGone([]), [query]);
  const [actionError, setActionError] = useState('');
  const rows = withAdded(list.rows, fresh.query === query ? fresh.added : [], fresh.rows).filter(
    task => !gone.includes(task.task.id),
  );
  const counts =
    (fresh.query === query ? fresh.counts : undefined) ??
    (list.meta.counts as TaskCounts | undefined);

  // One first-page refetch at a time and a second apart, longer after failures; a change meanwhile asks for one more, with the filters then; a hidden tab waits to show.
  const refetching = useRef<number>();
  const again = useRef(false);
  const hidden = useRef(false);
  const spaced = useRef<ReturnType<typeof setTimeout>>();
  const left = useRef(false);
  const failures = useRef(0);
  // Bumped by a reset, so a fetch started before it never writes over the page that follows.
  const era = useRef(0);
  // When each row last took an event, so an older page never undoes it.
  const touched = useRef<Record<string, number>>({});
  // The minute's resync reads every loaded row, not just the first page.
  const deep = useRef(false);
  const refresh = (all = false) => {
    deep.current ||= all;
    if (document.visibilityState === 'hidden') return void (hidden.current = true);
    if (refetching.current) return void (again.current = true);
    const started = (refetching.current = Date.now());
    const before = era.current;
    const loaded = deep.current ? rows : [];
    deep.current = false;
    // Pages of up to 200 until every loaded row is covered.
    const read = async () => {
      const first = await client.tasks.list({
        ...options,
        limit: Math.min(200, Math.max(LIST_PAGE, loaded.length)),
        cursor: '',
      });
      let page = first;
      const items = [...first.items];
      while (page.next && items.length < loaded.length) {
        page = await client.tasks.list({ ...options, limit: 200, cursor: page.next });
        items.push(...page.items);
      }

      return { ...page, items, counts: first.counts };
    };
    void read()
      .then(page => {
        if (era.current !== before) return;
        // A loaded row the read covers but no longer lists has left this view.
        const last = page.items.at(-1);
        const fetched = new Set(page.items.map(row => row.task.id));
        const left = loaded.filter(
          row =>
            !fetched.has(row.task.id) &&
            (touched.current[row.task.id] ?? 0) <= started &&
            (!page.next || (last && listOrder(row, last) < 0)),
        );
        if (left.length) setGone(current => [...current, ...left.map(row => row.task.id)]);
        setFresh(current => ({
          rows: {
            ...current.rows,
            // A page row is a summary, so what events added to the row stays.
            ...Object.fromEntries(
              page.items
                .filter(row => (touched.current[row.task.id] ?? 0) <= started)
                .map(row => [row.task.id, { ...current.rows[row.task.id], ...row }]),
            ),
          },
          added: addRows(current.query === query ? current.added : [], page.items),
          counts: page.counts,
          query,
        }));
        failures.current = 0;
      })
      // A failed read stays wanted, and tries again later each time.
      .catch(() => {
        failures.current++;
        again.current = true;
      })
      .finally(() => {
        if (left.current) return;
        if (!again.current) return void (refetching.current = undefined);
        again.current = false;
        spaced.current = setTimeout(
          () => {
            refetching.current = undefined;
            latest.current();
          },
          Math.min(30_000, 1000 * 2 ** failures.current),
        );
      });
  };
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    const show = () => {
      if (document.visibilityState !== 'visible' || !hidden.current) return;
      hidden.current = false;
      latest.current();
    };
    addEventListener('visibilitychange', show);
    return () => {
      removeEventListener('visibilitychange', show);
      clearTimeout(spaced.current);
      left.current = true;
    };
  }, []);

  // Changes were missed, so every loaded page goes: the page renders again from the server.
  const nav = useRouter();
  const reset = () => {
    era.current++;
    touched.current = {};
    setFresh({ rows: {}, added: [] });
    setGone([]);
    nav.refresh();
  };

  // Rows follow the events stream at once; counts, and tasks the list lacks, come with its first page again.
  useTaskEvents(
    (event: TaskEvent) => {
      const row = rows.find(task => task.task.id === event.id);
      if (!row) {
        // A deleted or archived task stays out even if a read from before it brings it; an unarchived one comes back.
        if (event.deleted || (event.archivedAt && values.status !== 'archived'))
          setGone(current => [...current, event.id]);
        else
          setGone(current =>
            current.includes(event.id) ? current.filter(id => id !== event.id) : current,
          );
        // A row kept from another view would outlive this change, so it goes.
        setFresh(current => {
          const { [event.id]: _kept, ...rows } = current.rows;
          return _kept ? { ...current, rows } : current;
        });
        if (event.deleted || (agent || values.agent || event.agent) === event.agent) refresh();
        return;
      }
      touched.current[event.id] = Date.now();
      if (refetching.current) again.current = true;
      // A change that moves the counts asks the server; a continued task also brings its new prompt.
      if (
        event.deleted ||
        event.status !== row.status ||
        Boolean(event.archivedAt) !== Boolean(row.archivedAt)
      )
        refresh();
      if (event.deleted || (event.archivedAt && values.status !== 'archived'))
        return setGone(current => [...current, event.id]);
      setFresh(current => {
        const was = current.rows[event.id] ?? row;
        return {
          ...current,
          rows: {
            ...current.rows,
            [event.id]: {
              ...was,
              status: event.status,
              approval: event.approval ?? undefined,
              archivedAt: event.archivedAt,
              startedAt: event.startedAt,
              finishedAt: event.finishedAt,
            },
          },
        };
      });
    },
    reset,
    () => refresh(true),
  );

  return (
    <>
      <Toolbar head={head} action={head ? <NewTaskButton /> : undefined}>
        <Search value={values.q} label="Search tasks" onInput={value => set('q', value, 250)} />
        <Filter name="tasks" facets={facets} values={values} onChange={set} />
      </Toolbar>
      {missing ? <NeedsCredential /> : null}
      <Card
        title="Tasks"
        count={counts ? formatCount(counts.all) : undefined}
        actions={
          counts ? (
            <>
              <ErrorText value={actionError} />
              {counts.active ? (
                <button type="button" class="badge acc" onClick={() => set('status', 'active')}>
                  {formatCount(counts.active)} active
                </button>
              ) : null}
              {counts.waiting ? (
                <button type="button" class="badge warn" onClick={() => set('status', 'waiting')}>
                  {formatCount(counts.waiting)} awaiting approval
                </button>
              ) : null}
            </>
          ) : undefined
        }
      >
        {rows.length ? (
          <div class="table-scroll">
            <table class="rows tasks stacked" aria-busy={list.stale}>
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th class="num">Duration</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(task => (
                  <TaskRowView
                    key={task.task.id}
                    task={task}
                    brand={brands[task.task.event?.integration ?? task.task.source]}
                    back={back}
                    scoped={Boolean(agent)}
                    tz={tz}
                    now={now}
                    onError={setActionError}
                    onDone={what => {
                      // An archived row leaves every view but the archive; a stopped one just refreshes.
                      if (what === 'delete' || (what === 'archive' && values.status !== 'archived'))
                        setGone(current => [...current, task.task.id]);
                      refresh();
                    }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        ) : list.stale ? null : query ? (
          <Empty title="No tasks match">Try another search or filter.</Empty>
        ) : (
          <Empty title="No tasks yet">
            {agent
              ? 'Tasks appear here as this agent runs.'
              : 'Start one with New task. Tasks from the dashboard, the CLI and platforms like GitHub show up here, newest first.'}
          </Empty>
        )}
        <Tail noun="tasks" {...list} />
      </Card>
    </>
  );
}
