/** `coder task mcp <task-id>`: the coder MCP server (stdio), spawned by engines that need a callback into coder. */
import { defineApp, defineCommand } from 'contextjsx';
import { serve } from 'contextjsx/serve';
import * as z from 'zod/mini';

import { decidePermission } from '../../core/engines/claude/permission';
import { arg, str } from '../../utils/args';
import { command } from '../../cli';

const input = arg(z.optional(z.record(z.string(), z.unknown())), "The tool's input.");

/** Claude's permission prompt fallback for one task: denies and points at `escalate`. */
const approvals = (cwd: string, caller: string) =>
  defineApp({
    name: 'coder',
    description: 'Coder approval policy',
    commands: [
      defineCommand({
        name: 'approval_prompt',
        description: 'Coder approval policy for claude permission prompts.',
        args: { tool_name: str('The tool Claude asks to run.'), input, tool_input: input },
        access: 'read',
        run: request => decidePermission(cwd, caller, request),
        mcp: { text: result => JSON.stringify(result) },
      }),
    ],
  });

export const commandTaskMcp = command({
  name: 'mcp',
  description: 'the coder MCP server engines call back into',
  access: 'write',
  args: { 'task-id': str() },
  globalFlags: { json: false },
  cli: { positional: ['task-id'] },
  mcp: false,
  run: async ({ args, cwd }) => {
    await (
      await serve(approvals(cwd, args[0]!), 'stdio')
    ).done;
  },
});
