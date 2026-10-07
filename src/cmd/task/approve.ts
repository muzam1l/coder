/** `coder task approve`: answer a pending approval, `--deny` to reject it. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

export const commandApprove = command({
  name: 'task approve',
  help: {
    usage: 'coder task approve [task-id] <approval-id> [--deny] [--server [url]]',
    summary:
      'Answer an escalated permission request. Accepts by default; --deny rejects it.\nApproval ids are unique, so the task id is optional.',
    flags: [['--deny', 'reject the request instead of accepting'], SERVER_FLAG],
  },
  options: { ...baseOptions, deny: flag, ...serverOptions },
  args: 2,
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
