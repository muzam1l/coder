/** `coder task approve`: answer an escalation, `--deny` to reject it; a denied one stays answerable. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { flag, serverOptions, str } from '../../utils/args';
import { command } from '../../cli';

export const commandApprove = command({
  name: 'approve',
  description: 'answer an escalation',
  usage:
    'Answer an escalation the task raised. Accepts by default; --deny rejects it, --reason says why.\nWorks any time, also after a deny: the task gets the decision as a message.\nApproval ids are unique, so the task id is optional.',
  access: 'write',
  args: {
    'task-id': str('the task, or the approval id alone'),
    'approval-id': str('the approval to answer'),
    deny: flag('reject the request instead of accepting'),
    reason: str('why it is denied; the task reads it'),
    ...serverOptions,
  },
  cli: { positional: ['task-id', 'approval-id'] },
  run: async ({ options, args: [reference, approvalId] }) => {
    const { tasks } = await import('../../core/task');
    return tasks.approve(reference, approvalId, { ...options, organization: options.workspace });
  },
  print: ({ taskId, approvalId }, { options }) =>
    process.stdout.write(
      `${options.deny ? 'Denied' : 'Approved'} ${outStyle.cyan(approvalId)} on task ${outStyle.cyan(taskId)}; the task has been told.\n`,
    ),
});
