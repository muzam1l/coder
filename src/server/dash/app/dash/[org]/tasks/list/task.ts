import type { TaskRow } from '@coder/client/types';
import { byListKey, listRank, promptTitle } from '@coder/core/task/view';
import { replyRequired as turnReplyRequired } from '@coder/agent/event-json';

/** A task page's tabs, the loading frame's too. */
export const TASK_TABS = ['Conversation', 'Activity', 'Details'];

/** Task statuses a list filters by; the filter menu lists the first three, outcomes behind More. */
export const STATUSES: Array<[string, string]> = [
  ['', 'Recent'],
  ['waiting', 'Needs approval'],
  ['archived', 'Archived'],
  ['completed', 'Completed'],
  ['failed', 'Failed'],
  ['cancelled', 'Cancelled'],
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

const STARTS: Record<string, string> = {
  dashboard: 'Dashboard task',
  cli: 'CLI task',
  schedule: 'Scheduled task',
};
const EVENT_NAMES: Record<string, string> = { pull_request: 'Pull request', dm: 'DM' };

/** What started a task, as its event's title, "Pull request" or "Dashboard task", and who: its member, else the platform account. */
export function taskOrigin(task: TaskRow) {
  const type = task.task.event?.type;
  const what =
    task.task.event?.title ??
    (type
      ? (EVENT_NAMES[type] ?? type[0]!.toUpperCase() + type.slice(1).replace(/_/g, ' '))
      : (STARTS[task.task.source] ?? `${sourceLabel(task.task.source)} task`));
  const by = task.task.context?.user?.name || task.task.event?.actor?.login;

  return { what, by };
}

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

export type DeltaCursor = { since: number; sinceId?: string };

/** A delta read's rows no event changed after `started`, and the cursor past its last row. */
export function readDelta(
  changed: TaskRow[],
  cursor: DeltaCursor,
  touched: Record<string, number>,
  started: number,
) {
  const last = changed.at(-1);

  return {
    rows: changed.filter(row => (touched[row.task.id] ?? 0) <= started),
    cursor: last ? { since: last.updatedAt, sinceId: last.task.id } : cursor,
  };
}

/** Whether a turn had to be answered: any of its events asks for a reply, else the task's event decides. */
export const replyRequired = (task: TaskRow, prompt: string) =>
  turnReplyRequired(prompt, task.task.event?.mustReply !== false)!;

/** A platform task is titled by its first message; dashboard and CLI tasks by their prompt. */
export function taskTitle(task: TaskRow) {
  // The first turn's prompt: a follow-up or a decision never retitles the task.
  const first = promptTitle(task.turns?.[0]?.prompt ?? task.task.prompt, task.task.event);

  return (
    task.task.name?.trim() || first || `${task.task.event?.type ?? 'task'} on ${task.task.agent}`
  );
}

/** The engine, model and effort a task runs on, as `claude/opus/high`; else its agent's model spec. */
export function taskModel(task: TaskRow) {
  const { usage, definition } = task.task;
  const own = usage?.engine || usage?.model ? usage : undefined;

  return [own?.engine, task.model ?? own?.model ?? definition?.model, own?.effort]
    .filter(Boolean)
    .join('/');
}

/** A folder path's last segment. */
export const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
