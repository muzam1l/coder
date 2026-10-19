/** `coder task list` (also `coder list`): recent, running, stopped or archived tasks. */
import path from 'node:path';
import process from 'node:process';

import type { TaskRow } from '../../core/task';
import { CoderError } from '../../core/dispatch';
import { decodeJson, encodeJson } from '../../utils/base64url';
import { STALL_MS } from '../../core/state';
import type { TaskStatus } from '../../server/store/types';
import {
  formatAge,
  outStyle,
  paintStatus,
  renderTable,
  type Column,
  type TableGroup,
} from '../../tui/output';
import { flag, limitOption, serverOptions, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';
import { replyOf } from './result';

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
          paint: (cell, row) => paintStatus(row.status, cell.length),
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
    const limit = options.limit ?? 50;
    if (options.server !== undefined) {
      const { connect } = await import('../../core/remote');
      const api = connect({ ...options, organization: options.workspace });
      const items: TaskStatus[] = [];
      let cursor = options.cursor ?? '';
      let next: string | undefined;
      do {
        const page = (await api.tasks.list({
          cursor,
          limit: limit === 'all' ? 200 : Math.min(200, limit - items.length),
          status: options.running ? 'active' : undefined,
          archived: options.archived,
        })) as unknown as { items: TaskStatus[]; next?: string };
        items.push(
          ...page.items.filter(
            row => !options.stopped || ['completed', 'failed', 'cancelled'].includes(row.status),
          ),
        );
        next = page.next;
        cursor = next ?? '';
      } while (next && (limit === 'all' || items.length < limit));

      return { items, ...(next ? { next } : {}) };
    }
    const { tasks } = await import('../../core/task');
    const rows = (await tasks.list({ ...options, limit: 'all' })) as TaskRow[] & {
      clipped: number;
      archived: number;
    };
    let after = 0;
    if (options.cursor) {
      let id: string;
      try {
        id = decodeJson<string>(options.cursor);
        if (typeof id !== 'string') throw new Error();
      } catch {
        throw new CoderError('invalid-option', 'Invalid task list cursor.');
      }
      const index = rows.findIndex(row => row.taskId === id);
      if (index < 0)
        throw new CoderError(
          'invalid-option',
          'Task list cursor is no longer available; start a new list.',
        );
      after = index + 1;
    }
    const items = rows.slice(after, limit === 'all' ? undefined : after + limit);
    const more = after + items.length < rows.length;

    return {
      items: Object.assign(items, { clipped: 0, archived: rows.archived }),
      ...(more ? { next: encodeJson(items.at(-1)!.taskId) } : {}),
    };
  },
  json: (page, { options }) =>
    options.server === undefined
      ? page
      : {
          ...page,
          items: (page.items as TaskStatus[]).map(
            ({ task, status, createdAt, updatedAt, startedAt, finishedAt }) => ({
              task: {
                id: task.id,
                name: task.name,
                agent: task.agent,
                source: task.source,
                cwd: task.cwd,
                prompt: task.prompt?.replace(/\s+/g, ' ').trim().slice(0, 80),
              },
              status,
              createdAt,
              updatedAt,
              startedAt,
              finishedAt,
            }),
          ),
        },
  next({ result: page, args: options }) {
    const rows = page.items as TaskRow[] & { archived: number };
    const steps =
      options.server !== undefined
        ? []
        : nextSteps(
            rows.length
              ? [
                  'Result: coder task result <task-id>',
                  ...(!options.archived
                    ? ['Older tasks: coder task list --archived [--limit N]']
                    : []),
                ]
              : rows.archived
                ? [`${rows.archived} archived: coder task list --archived [--limit N]`]
                : [],
          );
    if (page.next)
      steps.push(
        ...nextSteps(
          [
            `Next page: coder task list --cursor ${page.next} --limit ${options.limit ?? 50}${options.running ? ' --running' : ''}${options.stopped ? ' --stopped' : ''}${options.archived ? ' --archived' : ''}${options.dir ? ` --dir ${JSON.stringify(options.dir)}` : ''}${options.server !== undefined ? ` --server${options.server === true ? '' : ` ${JSON.stringify(options.server)}`}` : ''}${options.workspace ? ` --workspace ${JSON.stringify(options.workspace)}` : ''}`,
          ],
          { layout: 'plain' },
        ),
      );
    return steps;
  },
  async print(page, { options }) {
    if (options.server !== undefined) printServerTasks(page.items as TaskStatus[]);
    else {
      const { readFlowRecord } = await import('../../flow/runs');
      printTasks(
        page.items as TaskRow[] & { clipped: number; archived: number },
        options,
        readFlowRecord,
      );
    }
  },
});
