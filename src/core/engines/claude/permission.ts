/** Claude's permission prompt fallback (`--permission-prompt-tool`): auto mode's classifier decided already; what still asks is denied and pointed at `escalate`. */
import path from 'node:path';

import { readJsonFile, writeJsonFileAtomic } from '../../../utils/fsx';
import { approvalFor, NOT_ALLOWED } from '../../approvals';
import { appendTaskLog, resolveTaskDir } from '../../state';
import type { McpServerSpec } from '../../types';

interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
}

export function decidePermission(
  cwd: string,
  taskId: string,
  args: Record<string, any>,
): PermissionDecision {
  const toolName = String(args.tool_name ?? '');
  const input = (args.input ?? args.tool_input ?? {}) as Record<string, any>;
  const summary =
    toolName === 'Bash'
      ? `run command: ${String(input.command ?? '') || '(unknown command)'}`
      : `${toolName || '(unknown tool)'}: ${JSON.stringify(input).slice(0, 200)}`;
  appendTaskLog(cwd, taskId, {
    kind: 'approval-decision',
    method: toolName,
    decision: 'decline',
    reason: NOT_ALLOWED,
    summary,
  } as any);

  return { behavior: 'deny', message: NOT_ALLOWED };
}

/** Claude's PreToolUse hook: allows a Bash call whose command exactly matches an approved action, else no decision. */
export function decideApprovedCall(cwd: string, taskId: string, event: Record<string, any>) {
  const command = String(event.tool_input?.command ?? '');
  const approval =
    event.tool_name === 'Bash' && command.trim()
      ? approvalFor(resolveTaskDir(cwd, taskId), command)
      : undefined;
  if (!approval) return null;
  appendTaskLog(cwd, taskId, {
    kind: 'approval-decision',
    method: 'Bash',
    decision: 'accept',
    approvalId: approval.id,
    summary: `run command: ${command.trim()}`,
  } as any);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: `Coder: approved action ${approval.id}`,
      updatedInput: event.tool_input,
    },
  };
}

const READ_ONLY = 'This task is read-only.';

/** Claude's PreToolUse hook on a read-only server: lists it once per task, then refuses every tool not marked `readOnlyHint`. */
export async function decideReadOnlyCall(
  cwd: string,
  taskId: string,
  event: Record<string, any>,
  serversFile: string | undefined,
) {
  const toolName = String(event.tool_name ?? '');
  if (!serversFile || !toolName.startsWith('mcp__')) return null;
  // Loaded here so the Bash approval path stays light.
  const [{ claudeToolName }, { listServerTools }] = await Promise.all([
    import('.'),
    import('../../task/mcp'),
  ]);
  const server = readJsonFile<McpServerSpec[]>(serversFile)?.find(server =>
    toolName.startsWith(`${claudeToolName(server.name)}__`),
  );
  const cache = path.join(resolveTaskDir(cwd, taskId), 'read-only-tools.json');
  let tools = server && readJsonFile<Record<string, string[]>>(cache)?.[server.name];
  let reason = READ_ONLY;
  if (server && !tools) {
    try {
      tools = (await listServerTools(server))
        .filter(tool => tool.annotations?.readOnlyHint === true)
        .map(tool => tool.name);
      writeJsonFileAtomic(cache, {
        ...readJsonFile<Record<string, string[]>>(cache),
        [server.name]: tools,
      });
    } catch (error) {
      reason = `This task is read-only, and MCP server "${server.name}" did not list its tools (${error instanceof Error ? error.message : String(error)}).`;
    }
  }
  if (server && tools?.some(tool => claudeToolName(server.name, tool) === toolName)) return null;
  appendTaskLog(cwd, taskId, {
    kind: 'approval-decision',
    method: toolName,
    decision: 'decline',
    reason,
    summary: `${toolName}: ${JSON.stringify(event.tool_input ?? {}).slice(0, 200)}`,
  } as any);

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}
