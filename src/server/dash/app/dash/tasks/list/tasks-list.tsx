'use client';

import './tasks-list.css';

import { useEffect, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { formatCount, formatDate, formatDay, formatDuration } from '@/utils/format';
import { iClock, iDots, iMonitor, iPlug, iTerminal } from '@/comps/ui/icons';
import { Menu, MenuItem, MenuRadio } from '@/comps/ui/menu';
import { Link } from '@wular/pnext/link';
import { usePaged } from '@/utils/paged';
import type { TaskCounts, TaskRow, TasksPage } from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Id } from '@/comps/ui/badge';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { ErrorText } from '@/comps/ui/field';
import { approvalParts } from '@/app/dash/tasks/[id]/task-actions';
import { reasonText } from '@/utils/format';
import { Status } from './status';
import { Icon } from '@/comps/ui/icon';
import { Select } from '@/comps/ui/select';
import { taskActive } from '@/app/dash/tasks/list/task';
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

type Keys = 'q' | 'status' | 'source' | 'agent';

const SOURCE_ICONS: Record<string, string> = {
  dashboard: iMonitor,
  cli: iTerminal,
  schedule: iClock,
};

/** How often a list with running tasks refreshes their status. */
const LIVE_MS = 4000;

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
  back,
  scoped,
  tz,
  now,
  onDone,
  onError,
}: {
  task: TaskRow;
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
          {scoped ? null : `${task.task.agent} · `}
          <Id value={task.task.id} />
          {kind ? ` · ${kind}` : null}
          {task.task.cwd ? (
            <span title={task.task.cwd}>{` · ${folderName(task.task.cwd)}`}</span>
          ) : null}
        </span>
      </td>
      <td>
        <Status status={task.status} />
      </td>
      <td>
        <span class="source" title={sourceLabel(source)}>
          <Icon d={SOURCE_ICONS[source] ?? iPlug} />
          {sourceLabel(source)}
        </span>
      </td>
      <td class="when" title={formatDate(task.createdAt, tz)}>
        {ago(task.createdAt, now, tz)}
      </td>
      <td class="num">
        {formatDuration(elapsed)}
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
  /** Every agent's id, for the agent filter. */
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
  const list = usePaged<TaskRow>({
    name: `tasks${scope}`,
    fetchPage: cursor => client.tasks.list({ ...options, cursor }),
    query,
    first,
    initial,
  });
  const [fresh, setFresh] = useState<{
    rows: Record<string, TaskRow>;
    counts?: TaskCounts;
    query?: string;
  }>({ rows: {} });
  const [gone, setGone] = useState<string[]>([]);
  // Rows hidden after an archive or delete come back into view when the filters change.
  useEffect(() => setGone([]), [query]);
  const [actionError, setActionError] = useState('');
  const rows = list.rows
    .filter(task => !gone.includes(task.task.id))
    .map(task => fresh.rows[task.task.id] ?? task);
  const counts =
    (fresh.query === query ? fresh.counts : undefined) ??
    (list.meta.counts as TaskCounts | undefined);
  const live = rows.some(taskActive) || !!counts?.active;

  // Running tasks' status follows while they run; the rows themselves stay where they are.
  useEffect(() => {
    if (!live) return;

    const byId = (items: TaskRow[]) => Object.fromEntries(items.map(row => [row.task.id, row]));
    const timer = setInterval(() => {
      void Promise.all([
        client.tasks.list({ ...options, cursor: '' }),
        // A row whose status leaves the filter still takes its new status.
        options.status
          ? client.tasks.list({ ...options, status: undefined, counts: false, cursor: '' })
          : undefined,
      ])
        .then(([page, recent]) =>
          setFresh(current => ({
            rows: { ...current.rows, ...byId(recent?.items ?? []), ...byId(page.items) },
            counts: page.counts,
            query,
          })),
        )
        .catch(() => {});
    }, LIVE_MS);
    return () => clearInterval(timer);
  }, [live, query, agent]);

  return (
    <>
      <Toolbar head={head}>
        <Search value={values.q} label="Search tasks" onInput={value => set('q', value, 250)} />
        <Select
          label="Status"
          value={values.status}
          options={STATUSES}
          onChange={value => set('status', value)}
        />
        <Menu
          class="filter-more"
          label="More filters"
          summaryClass={`field-btn${values.source || values.agent ? ' on' : ''}`}
          summary="Filter"
        >
          <p class="pop-label">Source</p>
          <div role="group" aria-label="Source">
            {[...SOURCES, ...platforms].map(([value, label]) => (
              <MenuRadio
                key={value}
                on={values.source === value}
                onPick={() => set('source', value)}
              >
                {label}
              </MenuRadio>
            ))}
          </div>
          {agent ? null : (
            <>
              <p class="pop-label">Agent</p>
              <div role="group" aria-label="Agent">
                {[
                  ['', 'All agents'] as [string, string],
                  ...(values.agent && !agents.some(([id]) => id === values.agent)
                    ? [[values.agent, values.agent] as [string, string]]
                    : []),
                  ...agents,
                ].map(([value, label]) => (
                  <MenuRadio
                    key={value}
                    on={values.agent === value}
                    onPick={() => set('agent', value)}
                  >
                    {label}
                  </MenuRadio>
                ))}
              </div>
            </>
          )}
        </Menu>
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
                  <th>Source</th>
                  <th>Created</th>
                  <th class="num">Duration</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(task => (
                  <TaskRowView
                    key={task.task.id}
                    task={task}
                    back={back}
                    scoped={Boolean(agent)}
                    tz={tz}
                    now={now}
                    onError={setActionError}
                    onDone={what => {
                      // An archived row leaves every view but the archive; a stopped one just refreshes.
                      if (what === 'delete' || (what === 'archive' && values.status !== 'archived'))
                        setGone(current => [...current, task.task.id]);
                      void client.tasks
                        .list({ ...options, cursor: '' })
                        .then(page =>
                          setFresh(current => ({
                            rows: {
                              ...current.rows,
                              ...Object.fromEntries(page.items.map(row => [row.task.id, row])),
                            },
                            counts: page.counts,
                            query,
                          })),
                        )
                        .catch(() => {});
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
              : 'Type what you want done in the box above and press Enter. Tasks from the dashboard, the CLI and platforms like GitHub show up here, newest first.'}
          </Empty>
        )}
        <Tail noun="tasks" {...list} />
      </Card>
    </>
  );
}
