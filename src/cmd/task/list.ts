/** `coder task list` (also `coder list`): recent, running, stopped or archived tasks. */
import path from 'node:path';
import process from 'node:process';

import type { TaskRow } from '../../core/task';
import { STALL_MS } from '../../core/state';
import {
  formatAge,
  outStyle,
  paintStatus,
  renderTable,
  type Column,
  type TableGroup,
} from '../../tui/output';
import { flag, limitOption, serverOptions, serverSuffix, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';

// Below this, a running task's idle age isn't worth showing at all.
const IDLE_SHOW_MS = 2 * 60_000;

/** Tasks in time order, a flow run's tasks grouped under its run line. */
function printTasks(
  rows: TaskRow[],
  view: { archived?: boolean; running?: boolean; stopped?: boolean },
  readFlowRecord: typeof import('../../flow/runs').readFlowRecord,
): void {
  const s = outStyle;
  if (!rows.length) {
    const scope = view.archived
      ? 'archived tasks'
      : view.running
        ? 'running tasks'
        : view.stopped
          ? 'recently stopped tasks'
          : 'recent tasks';
    process.stdout.write(`No ${scope}.\n`);
    return;
  }
  type Row = TaskRow;
  const whoOf = (t: Row) =>
    (t.engine === 'custom' && t.model
      ? t.model
      : (t.engine ?? '-') + (t.model ? `/${t.model}` : '')) + (t.effort ? `/${t.effort}` : '');
  const cwdOf = (t: Row) => (t.cwd ? path.basename(t.cwd) : '-');
  const columns: Column<Row>[] = [
    { header: 'task-id', value: t => t.taskId, paint: c => s.cyan(c), max: 28 },
    {
      header: 'status',
      value: t => t.status,
      paint: (c, t) => paintStatus(t.status, c.length),
      max: 16,
    },
    { header: 'engine', value: whoOf, paint: c => s.light(c), max: 26 },
    { header: 'cwd', value: cwdOf, paint: c => s.light(c), max: 24 },
    {
      header: 'name',
      value: t => {
        const mark = t.archived ? ` ${s.dim('(archived)')}` : '';
        const label = t.name ? t.name : s.light(t.prompt);
        const idle =
          t.idleMs !== null && t.idleMs >= IDLE_SHOW_MS
            ? ` ${(t.idleMs > STALL_MS ? s.red : s.dim)(`· idle ${formatAge(t.idleMs)}`)}`
            : '';
        return `${label}${idle}${mark}`;
      },
    },
  ];

  // Tasks stay in time order; a flow run renders as a group headed by its
  // run line, anchored where the run's first-listed task falls in that order.
  const groups: TableGroup<Row>[] = [];
  const byRun = new Map<string, TableGroup<Row>>();
  for (const t of rows) {
    if (!t.flowRunId) {
      const tail = groups.at(-1);
      if (tail && !tail.header) tail.rows.push(t);
      else groups.push({ rows: [t] });
      continue;
    }
    let group = byRun.get(t.flowRunId);
    if (!group) {
      const record = readFlowRecord(t.flowRunId);
      const header = record
        ? `(${s.bold(t.flowRunId)} ${record.status}. Flow ${record.name})`
        : `(${s.bold(t.flowRunId)} flow)`;
      group = { header, rows: [] };
      byRun.set(t.flowRunId, group);
      groups.push(group);
    }
    group.rows.push(t);
  }
  process.stdout.write(renderTable(columns, groups, s));
}

// coder list                   -> recent tasks: running + stopped in the last 2 min
// coder task list --running    -> only the running ones
// coder task list --stopped    -> only the recently stopped ones
// coder task list --archived   -> archived tasks (everything older)
export const commandTasks = command({
  name: 'list',
  description: 'list recent tasks (by default running + just stopped)',
  usage:
    'List recent tasks across all workspaces, most recent first: running tasks plus\nones stopped within the last 30 minutes. Older stopped tasks auto-archive and\nmove to --archived. Shortcut: `coder list`.',
  access: 'read',
  args: {
    running: flag('show only running tasks'),
    stopped: flag('show only recently stopped tasks (not yet archived)'),
    archived: flag('show only archived tasks (auto-archived or via task archive)'),
    limit: limitOption('tasks per page (default: 50; all for every task)'),
    cursor: str('continue from the previous page cursor'),
    dir: str('only tasks launched in that workspace'),
    ...serverOptions,
  },
  run: async ({ options }) => {
    const { tasks } = await import('../../core/task');
    return tasks.list({ ...options, organization: options.workspace });
  },
  next({ result: page, args: options }) {
    const flags = serverSuffix(options);
    const steps = nextSteps(
      page.items.length
        ? [
            `Result: coder task result <task-id>${flags}`,
            ...(!options.archived
              ? [`Older tasks: coder task list --archived [--limit N]${flags}`]
              : []),
          ]
        : page.items.archived
          ? [`${page.items.archived} archived: coder task list --archived [--limit N]${flags}`]
          : [],
    );
    if (page.next)
      steps.push(
        ...nextSteps(
          [
            `Next page: coder task list --cursor ${page.next} --limit ${options.limit ?? 50}${options.running ? ' --running' : ''}${options.stopped ? ' --stopped' : ''}${options.archived ? ' --archived' : ''}${options.dir ? ` --dir ${JSON.stringify(options.dir)}` : ''}${flags}`,
          ],
          { layout: 'plain' },
        ),
      );
    return steps;
  },
  async print(page, { options }) {
    const { readFlowRecord } = await import('../../flow/runs');
    printTasks(page.items, options, readFlowRecord);
  },
});
