import type { TaskRow } from '@coder/client/types';
import { byListKey, listRank } from '@coder/core/defaults';

/** Task statuses a list filters by. */
export const STATUSES: Array<[string, string]> = [
  ['', 'Recent'],
  ['active', 'Active'],
  ['waiting', 'Needs approval'],
  ['running', 'Running'],
  ['queued', 'Queued'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
  ['archived', 'Archived'],
];

/** The list request's filters; "archived" is its own switch, not a status. */
export function listFilters<T extends { status: string }>(
  filters: T,
): Omit<T, 'status'> & { status?: string; archived?: boolean } {
  const { status, ...rest } = filters;
  return status === 'archived' ? { ...rest, archived: true } : { ...rest, status };
}

/** Where tasks come from besides platforms, which join by their integration id. */
export const SOURCES: Array<[string, string]> = [
  ['', 'All sources'],
  ['dashboard', 'Dashboard'],
  ['cli', 'CLI'],
  ['schedule', 'Schedule'],
];

export const sourceLabel = (value: string) =>
  (SOURCES.find(([key]) => key === value) ?? [value, value])[1];

export const taskActive = (task: Pick<TaskRow, 'status'>) =>
  task.status === 'queued' || task.status === 'running' || task.status === 'waiting';

const listKey = (row: TaskRow) => ({
  rank: listRank(row.status),
  createdAt: row.createdAt,
  id: row.task.id,
});

/** The server's list order. */
export const listOrder = (a: TaskRow, b: TaskRow) => byListKey(listKey(a), listKey(b));

/** Rows refetched first pages added so far, the newest copy of each, in list order. */
export function addRows(previous: TaskRow[], page: TaskRow[]): TaskRow[] {
  const fetched = new Set(page.map(row => row.task.id));
  return [...page, ...previous.filter(row => !fetched.has(row.task.id))].sort(listOrder);
}

/** The loaded rows with the added ones they lack, each at its latest, in list order. */
export function withAdded(
  rows: TaskRow[],
  added: TaskRow[],
  latest: Record<string, TaskRow> = {},
): TaskRow[] {
  const listed = new Set(rows.map(row => row.task.id));
  return [...added.filter(row => !listed.has(row.task.id)), ...rows]
    .map(row => latest[row.task.id] ?? row)
    .sort(listOrder);
}

export const taskTitle = (task: TaskRow) =>
  task.task.name?.trim() ||
  task.task.prompt?.trim() ||
  task.task.event?.text?.trim() ||
  `${task.task.event?.type ?? 'task'} on ${task.task.agent}`;

/** A folder path's last segment. */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
