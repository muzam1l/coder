/** `coder task hook <task-id>`: Claude's PreToolUse hook; allows an approved exact command, refuses a read-only server's write tools, else prints nothing. */
import { decideApprovedCall, decideReadOnlyCall } from '../../core/engines/claude/permission';
import { str } from '../../utils/args';
import { command } from '../../cli';

export const commandTaskHook = command({
  name: 'hook',
  description: "Claude's PreToolUse hook for approved actions and read-only servers",
  access: 'write',
  args: {
    'task-id': str(),
    servers: str("the 0600 file with the turn's read-only MCP servers"),
  },
  globalFlags: { json: false },
  cli: { positional: ['task-id'] },
  mcp: false,
  run: async ({ args, options, cwd }) => {
    let input = '';
    for await (const chunk of process.stdin) input += chunk.toString();
    const event = JSON.parse(input);
    const decision =
      decideApprovedCall(cwd, args[0]!, event) ??
      (await decideReadOnlyCall(cwd, args[0]!, event, options.servers));
    if (decision) process.stdout.write(JSON.stringify(decision));
  },
});
