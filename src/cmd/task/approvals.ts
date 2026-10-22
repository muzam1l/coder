/** `coder task approvals [id]`: pending (or denied) approvals across tasks, or every approval of one task. */
import process from 'node:process';

import { actionLines } from '../../core/approvals';
import { ageMs } from '../../core/state';
import { formatAge, outStyle } from '../../tui/output';
import { flag, serverOptions, serverSuffix, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';

interface Row {
  id: string;
  taskId: string;
  reason: string;
  actions: string[];
  createdAt?: string;
  answered?: 'accept' | 'decline' | 'closed' | null;
  deniedReason?: string | null;
  scope?: string;
  approvers?: string;
}

const STATES = { accept: 'approved', decline: 'denied', closed: 'stopped' } as const;

const state = (row: Row) => (row.answered ? STATES[row.answered] : 'pending');

/** Who approves a change request, after its reason. */
const approvers = (row: Row) =>
  row.scope ? `  ${outStyle.dim(`${row.approvers} approves this ${row.scope} change`)}` : '';

/** One task's approvals. */
function printTaskApprovals(taskId: string, items: Row[]): void {
  const s = outStyle;
  if (!items.length)
    return void process.stdout.write(`${s.dim(`No approvals for task ${taskId}.`)}\n`);
  for (const item of items) {
    const why = item.deniedReason ? `  ${s.dim(`denied: ${item.deniedReason}`)}` : '';
    process.stdout.write(
      `${s.cyan(item.id)}  ${state(item).padEnd(8)} ${s.light(item.reason)}${approvers(item)}${why}\n${actionLines(item.actions)}\n`,
    );
  }
}

/** Approvals across active tasks. */
function printApprovals(rows: Row[], denied: boolean): void {
  const s = outStyle;
  if (!rows.length)
    return void process.stdout.write(
      `${s.dim(denied ? 'No denied approvals.' : 'No pending approvals.')}\n`,
    );
  // A terminal cannot fold, so each approval lists its exact actions, as `task result --wait` does.
  for (const row of rows) {
    const age = row.createdAt ? `  ${s.dim(formatAge(ageMs(row.createdAt)))}` : '';
    process.stdout.write(
      `${s.cyan(row.id)}  task ${s.cyan(row.taskId)}${age}  ${s.light(row.reason)}${approvers(row)}\n${actionLines(row.actions)}\n`,
    );
  }
}

export const commandApprovals = command({
  name: 'approvals',
  description: 'pending approvals (all tasks, or one)',
  usage:
    'List pending approvals across all tasks, --denied the denied ones (still answerable), or every approval of one task.',
  access: 'read',
  args: {
    'task-id': str('one task (default: approvals of every task)'),
    denied: flag('denied approvals instead of pending ones'),
    ...serverOptions,
  },
  cli: { positional: ['task-id'] },
  run: async ({ options, args: [id] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.approvals(id, { ...options, organization: options.workspace });
  },
  json: (rows, { args: [id] }) => (id ? rows.map(({ taskId: _taskId, ...item }) => item) : rows),
  next({ result: rows, args }) {
    const flags = serverSuffix(args);
    if (!rows.length)
      return args['task-id'] ? [] : nextSteps([`Check tasks: coder task list${flags}`]);
    // A server needs the task id with the approval id.
    const ref =
      rows.length === 1
        ? args.server !== undefined
          ? `${rows[0]!.taskId} ${rows[0]!.id}`
          : rows[0]!.id
        : args.server !== undefined
          ? '<task-id> <approval-id>'
          : '<approval-id>';
    return nextSteps([`Answer: coder task approve ${ref} [--deny --reason "<why>"]${flags}`]);
  },
  print: (rows, { args: [id], options }) =>
    id ? printTaskApprovals(id, rows) : printApprovals(rows, Boolean(options.denied)),
});
