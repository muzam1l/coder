/** `coder task approvals [id]`: pending approvals across tasks or for one task. */
import process from 'node:process';

import { ageMs } from '../../core/state';
import type { ApprovalRow } from '../../core/task';
import { formatAge, outStyle, renderTable } from '../../tui/output';
import { serverOptions, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';

/** One task's pending approvals. */
function printTaskApprovals(
  taskId: string,
  items: Array<{ id: string; summary: string; answered?: string | null }>,
): void {
  const s = outStyle;
  if (!items.length)
    return void process.stdout.write(`${s.dim(`No pending approvals for task ${taskId}.`)}\n`);
  for (const item of items) {
    const state = item.answered ?? 'pending';
    process.stdout.write(
      `${s.cyan(item.id)}  ${state.padEnd(8)} ${s.dim(String(item.summary ?? ''))}\n`,
    );
  }
}

/** Every pending approval of running tasks. */
function printPendingApprovals(
  rows: Array<{ id: string; taskId: string; summary: string; createdAt?: string }>,
): void {
  const s = outStyle;
  if (!rows.length) return void process.stdout.write(`${s.dim('No pending approvals.')}\n`);
  process.stdout.write(
    `${renderTable(
      [
        {
          header: 'approval-id',
          value: (r: (typeof rows)[number]) => r.id,
          paint: cell => s.cyan(cell),
        },
        { header: 'task-id', value: r => r.taskId, paint: cell => s.cyan(cell) },
        { header: 'age', value: r => (r.createdAt ? formatAge(ageMs(r.createdAt)) : '-') },
        { header: 'summary', value: r => r.summary, paint: cell => s.light(cell) },
      ],
      rows,
      s,
    )}\n`,
  );
}

export const commandApprovals = command({
  name: 'approvals',
  description: 'pending approvals (all tasks, or one)',
  usage:
    'List only pending approvals across all tasks, or for one task. Answered approvals stay in the task log.',
  access: 'read',
  args: { 'task-id': str('one task (default: pending approvals of every task)'), ...serverOptions },
  cli: { positional: ['task-id'] },
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    const rows = await tasks.approvals(id, { ...options, organization: options.workspace });
    return rows.filter(row => row.answered == null);
  },
  json: (rows, { options, args: [id] }) =>
    options.server === undefined && id
      ? (rows as ApprovalRow[]).map(({ taskId: _taskId, ...item }) => item)
      : options.server === undefined
        ? (rows as ApprovalRow[]).map(({ taskId, id, summary, createdAt }) => ({
            taskId,
            id,
            summary,
            createdAt,
          }))
        : rows,
  next({ result: rows, args }) {
    if (args.server !== undefined)
      return rows.length ? [] : nextSteps(['Check tasks: coder task list']);
    const pending = rows;
    if (!pending.length) return args['task-id'] ? [] : nextSteps(['Check tasks: coder task list']);
    const ref = pending.length === 1 ? pending[0]!.id : '<approval-id>';
    return nextSteps([`Answer: coder task approve ${ref} [--deny]`]);
  },
  print(rows, { options, args: [id] }) {
    if (options.server === undefined)
      return id
        ? printTaskApprovals(id, rows as ApprovalRow[])
        : printPendingApprovals(rows as ApprovalRow[]);
    if (!rows.length)
      return void process.stdout.write(`${outStyle.dim('No pending approvals.')}\n`);
    for (const row of rows) process.stdout.write(`${row.taskId}  ${JSON.stringify(row)}\n`);
  },
});
