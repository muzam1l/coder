'use client';

import './tasks-list.css';

import { dynamic } from '@wular/pnext/dynamic';
import { useEffect, useRef, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
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
import { Menu } from '@/comps/ui/menu';
import { MenuItem } from '@/comps/ui/menu-items';
import { Link } from '@wular/pnext/link';
import { PendingApprovals } from '@/app/dash/[org]/tasks/list/pending-approvals';
import { useRouter } from '@wular/pnext/navigation/client';
import { usePaged } from '@/utils/paged';
import { useZone } from '@/app/zone';
import { pendingApproval } from '@/app/dash/[org]/tasks/[id]/task-actions';
import type {
  IntegrationInfo,
  Me,
  TaskCounts,
  TaskEvent,
  TaskRow,
  TasksPage,
  WorkspaceLimits,
} from '@coder/client/types';
import { BrandIcon } from '@/app/dash/[org]/agents/agent/agent-pills';
import { Button } from '@/comps/ui/button';
import { Card, Empty } from '@/comps/ui/card';
import { Badge } from '@/comps/ui/badge';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Status } from './status';
import { Icon } from '@/comps/ui/icon';
import { Filter, type Facet } from '@/comps/ui/filter';
import {
  addRows,
  readDelta,
  taskActive,
  withAdded,
  type DeltaCursor,
} from '@/app/dash/[org]/tasks/list/task';
import { taskModel, taskTitle } from '@/app/dash/[org]/tasks/list/task';
import { LIST_PAGE } from '@/utils/paged';
import { Search, Toolbar, queryOf, useFilters } from '@/comps/ui/toolbar';
import { Tail } from '@/comps/ui/tail';
import {
  SOURCES,
  STATUSES,
  folderName,
  listFilters,
  sourceLabel,
  taskOrigin,
} from '@/app/dash/[org]/tasks/list/task';
import { NeedsCredential } from '@/app/dash/[org]/tasks/composer';
import { MinutesNotice } from '@/app/dash/[org]/usage/minutes-notice';
import { useTaskEvents } from '@/comps/frame/task-toasts';
import { useOrg } from '@/comps/nav/org';

const NewTaskButton = dynamic(
  () => import('@/app/dash/[org]/tasks/composer').then(m => m.NewTaskButton),
  {
    // TODO: stays disabled after client navigation until pnext SSRs nested dynamic() like Next.js.
    loading: () => (
      <Button class="new-task" leftIcon={iPlus} disabled>
        New task
      </Button>
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

const DELTA_ROWS = 200;

/** How long ago, under a day; the date after that. */
function ago(value: number | undefined, now: number, tz: string) {
  if (value === undefined) return 'Not available';
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
}: {
  task: TaskRow;
  /** The source platform's brand art, when it has one. */
  brand?: IntegrationInfo['brand'];
  onDone: (what: RowAction) => void;
  /** The list to return to, when it is not the plain Tasks page. */
  back?: string;
  /** On an agent's own list, which names no agent. */
  scoped?: boolean;
  tz: string;
  now: number;
}) {
  const org = useOrg();
  const elapsed =
    taskActive(task) && task.startedAt !== undefined ? now - task.startedAt : task.lastTurnMs;
  const source = task.task.event?.integration ?? task.task.source ?? 'dashboard';
  const { what, by } = taskOrigin(task);

  return (
    <tr>
      <td>
        <Link
          class="cover"
          href="/dash/[org]/tasks/[id]"
          params={{ org, id: task.task.id }}
          search={back ? { back } : undefined}
        >
          {taskTitle(task)}
        </Link>
        {task.task.cwd ? (
          <span class="sub">
            <span title={task.task.cwd}>
              <Icon d={iFolder} />
              {folderName(task.task.cwd)}
            </span>
          </span>
        ) : null}
      </td>
      <td>
        <Status status={task.status} approvals={task.approvals} />
      </td>
      {scoped ? null : (
        <td class="agent" title={task.task.agent}>
          <Icon d={iAgent} />
          {task.task.agent}
        </td>
      )}
      <td class="model" title={taskModel(task)}>
        {task.model ?? task.task.usage?.model ?? task.task.definition?.model}
      </td>
      <td class="when" title={formatDate(task.lastActivityAt, tz)}>
        {ago(task.lastActivityAt, now, tz)}
      </td>
      <td class="num">{task.startedAt === undefined ? null : formatDuration(elapsed)}</td>
      <td>
        <span class="source" title={sourceLabel(source)}>
          {brand ? <BrandIcon brand={brand} /> : <Icon d={sourceIcon(source)} />}
          {what}
        </span>
        {by ? <span class="sub by">by {by}</span> : null}
        <span class="row-acts">
          <RowActions task={task} onDone={onDone} />
        </span>
      </td>
    </tr>
  );
}

/** Stop, Archive and Delete behind a row's ⋯ menu; the list hears what happened and drops or refreshes the row. */
type RowAction = 'cancel' | 'archive' | 'delete' | 'approve';

function RowActions({ task, onDone }: { task: TaskRow; onDone: (what: RowAction) => void }) {
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const approval = pendingApproval(task);
  const act = (what: RowAction, decision?: 'accept' | 'decline') =>
    void action
      .run(what, () =>
        what === 'approve'
          ? client.tasks.approve(task.task.id, approval?.id ?? '', decision ?? 'decline')
          : what === 'delete'
            ? client.tasks.delete(task.task.id)
            : client.tasks[what](task.task.id),
      )
      .then(ok => {
        if (ok) onDone(what);
        setConfirming(false);
      });
  return (
    <>
      <Menu summary={<Icon d={iDots} />} button="icon" label="Task actions" align="right">
        {approval ? <MenuItem title="Approve" onClick={() => act('approve', 'accept')} /> : null}
        {approval ? <MenuItem title="Deny" onClick={() => act('approve', 'decline')} /> : null}
        {taskActive(task) ? <MenuItem title="Stop" onClick={() => act('cancel')} /> : null}
        {task.archivedAt ? null : <MenuItem title="Archive" onClick={() => act('archive')} />}
        <MenuItem title="Delete" danger onClick={() => setConfirming(true)} />
      </Menu>
      <ConfirmDialog
        open={confirming}
        title="Delete this task?"
        body="Its conversation, activity and diff go with it."
        confirmLabel="Delete"
        busy={action.pending === 'delete'}
        onConfirm={() => act('delete')}
        onClose={() => setConfirming(false)}
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
  limits,
  pendingApprovals,
  me,
  tz: serverZone,
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
  /** The viewer's approval queue. */
  pendingApprovals?: TasksPage['pendingApprovals'];
  me: Me;
  /** No credential can run a task yet. */
  missing?: boolean;
  /** The workspace's usage limits, for the CPU minutes notice. */
  limits?: WorkspaceLimits;
  tz: string;
  now: number;
}) {
  const tz = useZone(serverZone);
  const org = useOrg();
  const { values, set, query } = useFilters<Keys>(filters);
  const initial = queryOf(filters);
  const scope = agent ? `&agent=${encodeURIComponent(agent)}` : '';
  const path = agent
    ? `/dash/${org}/agents/${encodeURIComponent(agent)}/tasks`
    : `/dash/${org}/tasks`;
  const back = query || agent ? `${path}${query ? `?${query}` : ''}` : undefined;
  const options = {
    limit: LIST_PAGE,
    summary: true,
    counts: true,
    ...listFilters(values),
    agent: agent ?? values.agent,
  };
  const facets: Facet<Keys>[] = [
    { key: 'status', label: 'Status', options: STATUSES, inline: true, shown: 3 },
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
  // Rows hidden after an archive or delete come back into view when the filters change.
  const [goneIn, setGoneIn] = useState<{ query: string; ids: string[] }>({ query, ids: [] });
  const gone = goneIn.query === query ? goneIn.ids : [];
  const setGone = (next: (ids: string[]) => string[]) =>
    setGoneIn(now => ({ query, ids: next(now.query === query ? now.ids : []) }));
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
  const refresh = () => {
    if (document.visibilityState === 'hidden') return void (hidden.current = true);
    if (refetching.current) return void (again.current = true);
    const started = (refetching.current = Date.now());
    const before = era.current;
    void client.tasks
      .list({ ...options, cursor: '' })
      .then(page => {
        if (era.current !== before) return;
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
    setGone(() => []);
    nav.refresh();
  };

  // Rows follow the events stream at once; counts, and tasks the list lacks, come with its first page again.
  const heard = (event: TaskEvent) => {
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
      Boolean(event.archivedAt) !== Boolean(row.archivedAt) ||
      Boolean(pendingApproval(row)) !==
        Boolean(pendingApproval({ approval: event.approval, approvals: event.approvals }))
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
            approvals: event.approvals ?? undefined,
            archivedAt: event.archivedAt,
            startedAt: event.startedAt,
            finishedAt: event.finishedAt,
          },
        },
      };
    });
  };

  // The minute's resync reads only rows changed since the newest one it has seen, each as an event.
  const since = useRef<DeltaCursor>({
    since: first.items.reduce((most, row) => Math.max(most, row.updatedAt), 0) || now,
  });
  const resync = () => {
    if (document.visibilityState === 'hidden') return;
    const started = Date.now();
    const before = era.current;
    void client.tasks
      .list({
        ...since.current,
        limit: DELTA_ROWS,
        agent: options.agent,
        source: options.source,
        archived: options.archived,
      })
      .then(changed => {
        if (era.current !== before) return;
        const delta = readDelta(changed, since.current, touched.current, started);
        since.current = delta.cursor;
        for (const row of delta.rows)
          heard({
            id: row.task.id,
            agent: row.task.agent,
            status: row.status,
            approval: row.approval,
            approvals: row.approvals,
            archivedAt: row.archivedAt,
            createdAt: row.createdAt,
            startedAt: row.startedAt,
            finishedAt: row.finishedAt,
          });
        // A full page has more past its cursor.
        if (changed.length === DELTA_ROWS) resync();
      })
      .catch(reason => console.error('coder dashboard: task resync', reason));
  };
  useTaskEvents(heard, reset, resync);

  return (
    <>
      <Toolbar head={head} action={head ? <NewTaskButton /> : undefined}>
        <Search value={values.q} label="Search tasks" onInput={value => set('q', value, 250)} />
        <Filter name="tasks" facets={facets} values={values} onChange={set} />
      </Toolbar>
      {missing ? <NeedsCredential /> : null}
      <MinutesNotice org={org} limits={limits} />
      {pendingApprovals?.length ? (
        <PendingApprovals
          rows={pendingApprovals.map(row => fresh.rows[row.task.id] ?? row)}
          me={me}
        />
      ) : null}
      <Card
        title="Tasks"
        count={counts ? formatCount(counts.all) : undefined}
        actions={
          counts ? (
            <>
              {counts.active ? <Badge tone="acc">{formatCount(counts.active)} active</Badge> : null}
              {counts.waiting ? (
                <Badge tone="warn" onClick={() => set('status', 'waiting')}>
                  {formatCount(counts.waiting)} awaiting approval
                </Badge>
              ) : null}
            </>
          ) : undefined
        }
      >
        {rows.length ? (
          <div class="table-scroll">
            <table
              class={agent ? 'rows tasks stacked scoped' : 'rows tasks stacked'}
              aria-busy={list.stale}
            >
              <thead>
                <tr>
                  <th>Task</th>
                  <th class="status">Status</th>
                  {agent ? null : <th class="agent">Agent</th>}
                  <th class="model">Model</th>
                  <th class="when">Last activity</th>
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
                    now={Date.now()}
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
