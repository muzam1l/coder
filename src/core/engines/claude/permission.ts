/** Coder's approval policy for claude permission prompts (`--permission-prompt-tool`). */
import { decideCommand, decideFileChange, escalate } from '../../approvals';
import { loadConfig } from '../../config';
import { appendTaskLog, loadTask, resolveTaskDir, resolveWorkspaceRoot } from '../../state';
import { decideSidecar } from './sidecar';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

export async function decidePermission(
  cwd: string,
  taskId: string,
  args: Record<string, any>,
): Promise<PermissionDecision> {
  const toolName = String(args.tool_name ?? '');
  const input = (args.input ?? args.tool_input ?? {}) as Record<string, any>;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const taskDir = resolveTaskDir(cwd, taskId);
  const config = loadConfig(cwd);
  const onEvent = (event: object) => appendTaskLog(cwd, taskId, event as any);

  let verdict: { decision: string; reason: string };
  let summary: string;
  if (toolName === 'Bash') {
    const command = String(input.command ?? '');
    summary = `run command: ${command || '(unknown command)'}`;
    verdict = decideCommand(command, { allowedNetworkHosts: config.approvals.allowedNetworkHosts });
  } else if (FILE_TOOLS.has(toolName)) {
    const file = String(input.file_path ?? input.notebook_path ?? '');
    summary = `${toolName}: ${file || '(unknown path)'}`;
    verdict = decideFileChange(file ? [file] : [], workspaceRoot);
  } else {
    summary = `${toolName || '(unknown tool)'}: ${JSON.stringify(input).slice(0, 200)}`;
    verdict = { decision: 'escalate', reason: `tool needs approval: ${toolName}` };
  }
  onEvent({
    kind: 'approval-decision',
    method: toolName,
    decision: verdict.decision,
    reason: verdict.reason,
    summary,
  });

  let decision = verdict.decision;
  let reason = verdict.reason;
  if (decision === 'escalate') {
    const sidecar = await decideSidecar(cwd, taskDir, {
      taskGoal: loadTask(cwd, taskId)?.prompt ?? null,
      summary,
    });
    onEvent({
      kind: 'sidecar-decision',
      decision: sidecar.decision,
      reason: sidecar.reason,
      summary,
    });
    if (sidecar.decision === 'escalate') {
      decision = await escalate(
        taskDir,
        { method: `claude/${toolName}`, summary, params: { tool_name: toolName, input } },
        { timeoutMs: config.approvals.escalationTimeoutMs, onEvent },
      );
      reason = 'escalated for human review';
    } else {
      decision = sidecar.decision;
      reason = sidecar.reason;
    }
  }
  return decision === 'accept'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: `Denied by coder policy: ${reason}` };
}
