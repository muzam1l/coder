/** `coder task approvals [id]`: pending approvals, or one task's approvals and their answers. */
import process from 'node:process';

import { ageMs } from '../../core/state';
import type { ApprovalRow } from '../../core/task';
import { formatAge, formatHints, outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

/** One task's approvals and whether each was answered. */
function printTaskApprovals(
  taskId: string,
  items: Array<{ id: string; summary: string; answered?: string | null }>,
): void {
  const s = outStyle;
  if (!items.length)
    return void process.stdout.write(`${s.dim(`No approvals for task ${taskId}.`)}\n`);
  for (const item of items) {
    const state = item.answered ?? 'pending';
    process.stdout.write(
      `${s.cyan(item.id)}  ${state.padEnd(8)} ${s.dim(String(item.summary ?? ''))}\n`,
    );
  }
  const pending = items.filter(item => !item.answered);
  if (pending.length) {
    const ref = pending.length === 1 ? pending[0]!.id : '<approval-id>';
    process.stdout.write(`\n${formatHints([`Answer: coder task approve ${ref} [--deny]`], s)}\n`);
  }
}

/** Every pending approval of running tasks. */
function printPendingApprovals(
  rows: Array<{ id: string; taskId: string; summary: string; createdAt?: string }>,
): void {
  const s = outStyle;
  if (!rows.length)
    return void process.stdout.write(
      `${s.dim('No pending approvals.')}\n\n${formatHints(['Check tasks: coder task list'], s)}\n`,
    );
  const w = {
    id: Math.max('approval-id'.length, ...rows.map(r => r.id.length)),
    task: Math.max('task-id'.length, ...rows.map(r => r.taskId.length)),
  };
  process.stdout.write(
    s.bold(s.light(`${'approval-id'.padEnd(w.id)}  ${'task-id'.padEnd(w.task)}  age    summary\n`)),
  );
  for (const r of rows) {
    const age = r.createdAt ? formatAge(ageMs(r.createdAt)) : '-';
    process.stdout.write(
      `${s.cyan(r.id.padEnd(w.id))}  ${s.cyan(r.taskId.padEnd(w.task))}  ${age.padEnd(5)}  ${s.light(r.summary)}\n`,
    );
  }
  const ref = rows.length === 1 ? rows[0]!.id : '<approval-id>';
  process.stdout.write(`\n${formatHints([`Answer: coder task approve ${ref} [--deny]`], s)}\n`);
}

export const commandApprovals = command({
  name: 'task approvals',
  help: {
    usage: 'coder task approvals [task-id] [--server [url]]',
    summary:
      "Without a task id: pending approvals across all tasks. With one: that task's\npermission escalations and how each was answered.",
    flags: [SERVER_FLAG],
  },
  options: { ...baseOptions, ...serverOptions },
  args: 1,
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.approvals(id, { ...options, organization: options.workspace });
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
  print(rows, { options, args: [id] }) {
    if (options.server === undefined)
      return id
        ? printTaskApprovals(id, rows as ApprovalRow[])
        : printPendingApprovals(rows as ApprovalRow[]);
    if (!rows.length)
      return void process.stdout.write(
        `${outStyle.dim('No pending approvals.')}\n\n${formatHints(['Check tasks: coder task list'], outStyle)}\n`,
      );
    for (const row of rows) process.stdout.write(`${row.taskId}  ${JSON.stringify(row)}\n`);
  },
});
