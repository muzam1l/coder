import type { TaskRow } from '@coder/client/types';

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

export const taskActive = (task: TaskRow) =>
  task.status === 'queued' || task.status === 'running' || task.status === 'waiting';

export const taskTitle = (task: TaskRow) =>
  task.task.name?.trim() ||
  task.task.prompt?.trim() ||
  task.task.event?.text?.trim() ||
  `${task.task.event?.type ?? 'task'} on ${task.task.agent}`;

/** A folder path's last segment. */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
