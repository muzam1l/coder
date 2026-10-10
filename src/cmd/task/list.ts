/** `coder task list` (also `coder list`): recent, running, stopped or archived tasks. */
import path from 'node:path';
import process from 'node:process';

import type { TaskRow } from '../../core/task';
import { STALL_MS } from '../../core/state';
import type { TaskStatus } from '../../server/store/types';
import {
  formatAge,
  formatHints,
  outStyle,
  paintStatus,
  renderTable,
  type Column,
  type TableGroup,
} from '../../tui/output';
import { flag, limitOption, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { replyOf, statusStyle } from './result';

const serverOptions = { server: optStr, workspace: str, yes: flag };

// Below this, a running task's idle age isn't worth showing at all.
const IDLE_SHOW_MS = 2 * 60_000;

function printServerTasks(rows: TaskStatus[]): void {
  if (!rows.length) return void process.stdout.write('No server tasks.\n');
  const s = outStyle;
  process.stdout.write(
    renderTable<TaskStatus>(
      [
        { header: 'task-id', value: row => row.task.id, paint: value => s.cyan(value) },
        {
          header: 'status',
          value: row => row.status,
          paint: value => statusStyle(value as TaskStatus['status'], s),
        },
        { header: 'agent', value: row => row.task.agent },
        { header: 'source', value: row => row.task.source },
        {
          header: 'request',
          value: row =>
            (
              row.task.prompt ??
              (row.task.event ? `${row.task.event.type}: ${row.task.event.text}` : '-')
            ).slice(0, 80),
        },
        { header: 'reply', value: row => replyOf(row) ?? '-' },
      ],
      rows,
      s,
    ),
  );
}

/** Tasks in time order, a flow run's tasks grouped under its run line. */
function printTasks(
  rows: TaskRow[] & { clipped: number; archived: number },
  view: { archived?: boolean; running?: boolean; stopped?: boolean; limit?: number | 'all' },
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
    // On the default (recent) view, point at the archive if it has tasks.
    if (rows.archived)
      process.stdout.write(
        `\n${formatHints([`${rows.archived} archived: coder task list --archived [--limit N]`], s)}\n`,
      );
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

  if (rows.clipped) {
    process.stdout.write(
      s.dim(
        `\n... ${rows.clipped} more not shown (--limit ${view.limit === 'all' ? undefined : view.limit})\n`,
      ),
    );
  }

  const hints = ['Result: coder task result <task-id>'];
  // The default view only shows recent tasks; point at the archive.
  if (!view.archived) {
    hints.push('Older tasks: coder task list --archived [--limit N]');
  }
  process.stdout.write(`\n${formatHints(hints, s)}\n`);
}

// coder list                   -> recent tasks: running + stopped in the last 2 min
// coder task list --running    -> only the running ones
// coder task list --stopped    -> only the recently stopped ones
// coder task list --archived   -> archived tasks (everything older)
export const commandTasks = command({
  name: 'task list',
  help: {
    usage: 'coder task list [--running] [--stopped] [--archived [--limit N]] [--server [url]]',
    summary:
      'List recent tasks across all workspaces, most recent first: running tasks plus\nones stopped within the last 30 minutes. Older stopped tasks auto-archive and\nmove to --archived. Shortcut: `coder list`.',
    flags: [
      ['--running', 'show only running tasks'],
      ['--stopped', 'show only recently stopped tasks (not yet archived)'],
      ['--archived', 'show only archived tasks (auto-archived or via task archive)'],
      ['--limit <n|all>', 'show at most n tasks (default all)'],
      ['--dir <dir>', 'only tasks launched in that workspace'],
      SERVER_FLAG,
    ],
  },
  options: {
    cwd: str,
    dir: str,
    limit: limitOption,
    json: flag,
    running: flag,
    stopped: flag,
    archived: flag,
    ...serverOptions,
  },
  run: async ({ options }) => {
    const { tasks } = await import('../../core/task');
    return tasks.list({ ...options, organization: options.workspace });
  },
  async print(rows, { options }) {
    if (options.server !== undefined) return printServerTasks(rows as TaskStatus[]);
    const { readFlowRecord } = await import('../../flow/runs');
    printTasks(rows as TaskRow[] & { clipped: number; archived: number }, options, readFlowRecord);
  },
});
