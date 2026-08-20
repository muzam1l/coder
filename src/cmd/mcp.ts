/**
 * `coder _mcp <job-id>` - the coder MCP server (stdio), spawned by engines that
 * need a callback into coder. Tools live in TOOLS; today that is approval_prompt
 * (claude's --permission-prompt-tool), with room for more.
 */
import process from 'node:process';
import readline from 'node:readline';

import * as z from 'zod/mini';

import { parseArgs, str } from '../lib/args.js';
import { decideCommand, decideFileChange, escalate } from '../lib/approvals.js';
import { decideSidecar } from '../lib/sidecar.js';
import { appendJobLog, readJob, resolveJobDir, resolveWorkspaceRoot } from '../lib/state.js';
import { loadConfig } from '../lib/config.js';
import { resolveCwd } from '../lib/ui.js';
import { readVersion } from '../lib/runtime.js';

const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

interface PermissionDecision {
  behavior: 'allow' | 'deny';
  updatedInput?: unknown;
  message?: string;
}

export async function decidePermission(
  cwd: string,
  jobId: string,
  args: Record<string, any>,
): Promise<PermissionDecision> {
  const toolName = String(args.tool_name ?? '');
  const input = (args.input ?? args.tool_input ?? {}) as Record<string, any>;
  const workspaceRoot = resolveWorkspaceRoot(cwd);
  const jobDir = resolveJobDir(cwd, jobId);
  const config = loadConfig(cwd);
  const onEvent = (event: object) => appendJobLog(cwd, jobId, event as any);

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
  onEvent({ kind: 'approval-decision', method: toolName, decision: verdict.decision, reason: verdict.reason, summary });

  let decision = verdict.decision;
  let reason = verdict.reason;
  if (decision === 'escalate') {
    const sidecar = await decideSidecar(cwd, jobDir, {
      taskGoal: readJob(cwd, jobId)?.prompt ?? null,
      summary,
    });
    onEvent({ kind: 'sidecar-decision', decision: sidecar.decision, reason: sidecar.reason, summary });
    if (sidecar.decision === 'escalate') {
      decision = await escalate(
        jobDir,
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

interface McpTool {
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (cwd: string, jobId: string, args: Record<string, any>) => Promise<unknown>;
}

const TOOLS: Record<string, McpTool> = {
  approval_prompt: {
    description: 'Coder approval policy for claude permission prompts.',
    inputSchema: { type: 'object', additionalProperties: true },
    handler: decidePermission,
  },
};

export async function commandMcp(argv: string[]): Promise<void> {
  const { options, positionals } = parseArgs(argv, z.object({ cwd: str }));
  const cwd = resolveCwd(options);
  const jobId = positionals[0]!;

  const write = (message: unknown) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: any;
    try {
      request = JSON.parse(line);
    } catch {
      continue;
    }
    const { id, method, params } = request;
    if (method === 'initialize') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'coder', version: readVersion() },
        },
      });
    } else if (method === 'tools/list') {
      write({
        jsonrpc: '2.0',
        id,
        result: {
          tools: Object.entries(TOOLS).map(([name, tool]) => ({
            name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          })),
        },
      });
    } else if (method === 'tools/call') {
      const tool = TOOLS[String(params?.name ?? '')];
      let payload: unknown;
      try {
        if (!tool) throw new Error(`unknown tool: ${params?.name}`);
        payload = await tool.handler(cwd, jobId, params?.arguments ?? {});
      } catch (error) {
        payload = {
          behavior: 'deny',
          message: `coder mcp tool failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      write({
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(payload) }] },
      });
    } else if (id !== undefined) {
      write({ jsonrpc: '2.0', id, result: {} });
    }
  }
}
