/** `coder task approve`: answer a pending approval, `--deny` to reject it. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, serverOptions, str } from '../../utils/args';
import { command } from '../../cli';

export const commandApprove = command({
  name: 'approve',
  description: 'answer an escalated permission',
  usage:
    'Answer an escalated permission request. Accepts by default; --deny rejects it.\nApproval ids are unique, so the task id is optional.',
  access: 'write',
  args: {
    'task-id': str('the task, or the approval id alone'),
    'approval-id': str('the approval to answer'),
    deny: flag('reject the request instead of accepting'),
    ...serverOptions,
  },
  cli: { positional: ['task-id', 'approval-id'] },
  run: async ({ options, args: [reference, approvalId] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.approve(reference, approvalId, { ...options, organization: options.workspace });
  },
  print: (result, { options, args }) =>
    process.stdout.write(
      options.server !== undefined
        ? `${options.deny ? 'Denied' : 'Approved'} ${outStyle.cyan(args[1]!)}.\n`
        : `${options.deny ? 'Denied' : 'Approved'} ${outStyle.cyan((result as { approvalId: string }).approvalId)} on task ${outStyle.cyan((result as { taskId: string }).taskId)}.\n`,
    ),
});
