/**
 * Claude engine over the claude CLI in print mode. Used when the host cannot
 * spawn Claude subagents itself (codex plugin, direct CLI use). Sessions are
 * assigned an id up front so tasks are steerable via --resume, mirroring codex
 * threadIds.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
  CLAUDE_ACCESS_FLAGS,
  CLAUDE_SIDECAR_FLAGS,
  MACHINE_SANDBOX_ENV,
  claudeTurnSettings,
} from '../../config';
import { mailboxId, type MailboxKey } from '../../mailbox';
import { requestControl } from '../control';
import { CLI_PATH } from '../../runtime';
import { WORKER_ENV } from '../../dispatch';
import { engineEnvironment } from '../../connections';
import { taskSocket } from '../../../client/http';
import { parseVersion } from '../../hosts';
import { compareVersions } from '../../update-check';
import type {
  Access,
  AuthStatus,
  Availability,
  Effort,
  McpServerSpec,
  ProgressUpdate,
  TurnResult,
} from '../../types';
import { HISTORY_LOST } from '../../types';
import { claudeTurn } from './turn';

export { describeClaudeToolUse } from './turn';

const claudeVersions = new Map<string, string>();
const CLAUDE_VERSION_ENV = 'CODER_CLAUDE_VERSION';

function resolveClaudeExecutable(executable: string, env: NodeJS.ProcessEnv, cwd: string): string {
  const searchPath =
    process.platform === 'win32'
      ? (env[
          Object.keys(env)
            .sort()
            .find(key => key.toLowerCase() === 'path') ?? 'PATH'
        ] ??
        process.env.PATH ??
        '')
      : (env.PATH ?? '/usr/bin:/bin');
  const directories = /[\\/]/.test(executable)
    ? ['']
    : [...(process.platform === 'win32' ? [cwd] : []), ...searchPath.split(path.delimiter)];
  const extensions =
    process.platform === 'win32' && !path.extname(executable)
      ? ['', ...(env.PATHEXT ?? '.EXE;.COM').split(';')]
      : [''];
  for (const directory of directories) {
    for (const extension of extensions) {
      const file = path.resolve(cwd, directory, executable + extension);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return fs.realpathSync(file);
      } catch {}
    }
  }
  return path.resolve(cwd, executable);
}

export function claudeVersionEnvironment(env: NodeJS.ProcessEnv, cwd: string) {
  const executable = resolveClaudeExecutable('claude', engineEnvironment(env), cwd);
  const detail = claudeVersions.get(executable);

  return {
    [CLAUDE_VERSION_ENV]: detail === undefined ? undefined : JSON.stringify({ executable, detail }),
  };
}

export function claudeVersion(executable: string, env: NodeJS.ProcessEnv, cwd: string): string {
  const file = resolveClaudeExecutable(executable, env, cwd);
  const known = claudeVersions.get(file);
  if (known !== undefined) return known;
  try {
    const inherited = JSON.parse(env[CLAUDE_VERSION_ENV] ?? 'null');
    if (inherited?.executable === file && typeof inherited.detail === 'string') {
      claudeVersions.set(file, inherited.detail);
      return inherited.detail;
    }
  } catch {}

  return getClaudeAvailability(executable, env, cwd).detail;
}

export function getClaudeAvailability(
  executable = 'claude',
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): Availability {
  env = engineEnvironment(env);
  const file = resolveClaudeExecutable(executable, env, cwd);
  const probe = spawnSync(executable, ['--version'], {
    encoding: 'utf8',
    env,
    cwd,
  });
  const available = !probe.error && probe.status === 0;
  const detail = available
    ? String(probe.stdout || '').trim()
    : 'claude CLI not found on PATH (npm install -g @anthropic-ai/claude-code)';
  claudeVersions.set(file, detail);

  return { available, detail };
}

// Whether the claude CLI is logged in, via `claude auth status --json`.
export function getClaudeAuthStatus(): AuthStatus {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { loggedIn: true, detail: 'CLAUDE_CODE_OAUTH_TOKEN configured' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { loggedIn: true, detail: 'ANTHROPIC_API_KEY configured' };
  }
  const probe = spawnSync('claude', ['auth', 'status', '--json'], {
    encoding: 'utf8',
    env: engineEnvironment(),
  });
  if (probe.error || probe.status !== 0) {
    return { loggedIn: false, detail: 'not logged in' };
  }
  try {
    const data = JSON.parse(String(probe.stdout || '')) as {
      loggedIn?: boolean;
      email?: string;
      subscriptionType?: string;
    };
    if (!data.loggedIn) {
      return { loggedIn: false, detail: 'not logged in' };
    }
    const detail = [data.email, data.subscriptionType].filter(Boolean).join(', ') || 'logged in';
    return { loggedIn: true, detail };
  } catch {
    return { loggedIn: false, detail: 'unknown' };
  }
}

export interface ClaudeTurnOptions {
  prompt: string;
  promptCacheTtl?: '1h';
  outputSchema?: object;
  model?: string | null;
  effort?: Effort | null;
  access?: Access | null;
  /** The task Coder's PreToolUse hook acts for; in auto mode its prompt tool also denies what still asks and points at `escalate`. */
  approvalTaskId?: string | null;
  /** Hosts reachable inside the sandbox without review (auto mode only). */
  allowedNetworkHosts?: string[];
  /** The task's scratch folder, writable in auto. */
  scratch?: string;
  /** Whether the turn runs on the user's own machine (auto mode tells its classifier). */
  local?: boolean;
  /** Extra existing directories the turn may reach; writes there follow the permission mode. */
  additionalDirectories?: string[];
  /** Extra environment for the CLI and the commands it runs. */
  env?: Record<string, string>;
  /** Inspection tools for a read-only sidecar; supplying any also applies CLAUDE_SIDECAR_FLAGS. */
  readOnlyAllowedTools?: string[];
  /** Extra MCP servers (env already resolved) plus the tools the turn may call; `readOnly` ones go through the hook. */
  mcpServers?: McpServerSpec[];
  nativeMcp?: boolean;
  /** Directory for the short-lived 0600 MCP config file. */
  taskRoot?: string;
  resumeSessionId?: string | null;
  /** Appended to Claude Code's system prompt on every turn. */
  systemPrompt?: string;
  /** Moves per-machine sections out of the system prompt so conversations share its cache. */
  excludeDynamicSections?: boolean;
  settingSources?: string;
  onProgress?: (update: Exclude<ProgressUpdate, string>) => void;
  onHeartbeat?: () => void;
  /** Stops the turn: the child is terminated and the turn ends as it exits. */
  signal?: AbortSignal;
  command?: MailboxKey;
  onResult?: (result: TurnResult) => void;
  /** Publishes the worker-owned endpoint once this turn can accept live input. */
  onSteerReady?: (endpoint: string) => void;
  /** Test seam; production always resolves `claude` from PATH. */
  executable?: string;
}

export interface ClaudeTurnResult extends TurnResult {
  threadId: string;
  turnId: string | null;
  finalMessage: string;
  error: { message: string } | null;
}

/** Claude Code's name for an MCP server or tool: every character outside `[A-Za-z0-9_-]` becomes `_`. */
export const claudeToolName = (server: string, tool?: string) =>
  ['mcp', server, ...(tool === undefined ? [] : [tool])]
    .map(part => part.replace(/[^A-Za-z0-9_-]/g, '_'))
    .join('__');

/** One `sh -c` word, for the approval hook's command line. */
const shellQuote = (word: string) => `'${word.replaceAll("'", `'\\''`)}'`;

/** The approval server's name, apart from a task's `task` server. */
const APPROVAL_SERVER = 'coder-approval';

/** Build the native CLI invocation so every Claude caller shares one permission policy. */
export function buildClaudeMcpConfig(
  cwd: string,
  options: ClaudeTurnOptions,
): Record<string, unknown> {
  const access = options.access ?? 'auto';
  const extraServers = options.mcpServers ?? [];
  const mcpServers: Record<string, unknown> = {};
  const approvalServer = access === 'auto' && options.approvalTaskId;
  if (approvalServer) {
    mcpServers[APPROVAL_SERVER] = {
      type: 'stdio',
      command: process.execPath,
      args: [CLI_PATH, 'task', 'mcp', options.approvalTaskId, '--cwd', cwd],
      env: { [WORKER_ENV]: '1' },
    };
  }
  for (const server of extraServers) {
    mcpServers[server.name] = {
      ...(server.url
        ? {
            type: server.type ?? 'http',
            url: server.url,
            ...(server.headers ? { headers: server.headers } : {}),
          }
        : {
            type: 'stdio',
            command: server.command,
            args: server.args ?? [],
            ...(server.env ? { env: server.env } : {}),
          }),
      ...(server.alwaysLoad ? { alwaysLoad: true } : {}),
    };
  }
  return mcpServers;
}

export function buildClaudeTurnArgs(
  cwd: string,
  options: ClaudeTurnOptions,
  sessionId: string,
  mcpConfigPath?: string,
  cliVersion?: string,
  systemPromptPath?: string,
  readOnlyPath?: string,
): string[] {
  // stream-json emits newline-delimited events (tool calls, result) as the turn
  // runs, so progress is visible instead of a single blob at the end like the
  // plain "json" format. --verbose is required for stream-json in print mode.
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--replay-user-messages',
  ];
  const version = parseVersion(cliVersion);
  if (version && compareVersions(version, '2.1.94') >= 0) {
    args.push('--thinking-display', 'summarized');
  }
  args.push(options.resumeSessionId ? '--resume' : '--session-id', sessionId);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.systemPrompt)
    args.push(
      '--append-system-prompt-file',
      systemPromptPath ?? path.join(options.taskRoot ?? cwd, '.claude-system.md'),
    );
  // Claude reuses a conversation's first system prompt on resume unless told not to; each turn lists its own servers.
  if (options.systemPrompt && version && compareVersions(version, '2.1.267') >= 0)
    args.push('--system-prompt-snapshot', 'off');
  if (options.excludeDynamicSections) args.push('--exclude-dynamic-system-prompt-sections');
  if (options.settingSources) args.push('--setting-sources', options.settingSources);
  if (options.outputSchema) {
    // Claude Code's validator rejects the draft 2020-12 meta-schema reference that zod writes.
    const { $schema: _, ...schema } = options.outputSchema as Record<string, unknown>;
    args.push('--json-schema', JSON.stringify(schema));
  }
  const access = options.access ?? 'auto';
  const additionalDirectories = options.additionalDirectories ?? [];
  const readOnlyAllowedTools = access === 'read-only' ? (options.readOnlyAllowedTools ?? []) : [];
  const extraServers = options.mcpServers ?? [];
  const mcpServers = buildClaudeMcpConfig(cwd, options);
  const approvalServer = access === 'auto' && options.approvalTaskId;
  const mcpTools = extraServers.flatMap(server =>
    server.tools?.length
      ? server.tools.map(tool => claudeToolName(server.name, tool))
      : [claudeToolName(server.name)],
  );
  const mcpConfigFlags = Object.keys(mcpServers).length
    ? ['--mcp-config', mcpConfigPath ?? path.join(options.taskRoot ?? cwd, '.claude-mcp.json')]
    : options.nativeMcp
      ? []
      : ['--mcp-config', '{"mcpServers":{}}'];
  if (!options.nativeMcp) args.push('--strict-mcp-config', '--no-chrome');

  if (approvalServer) {
    // Claude's classifier decides; the prompt tool answers only what it hands back (repeated blocks, ask rules).
    args.push(
      ...CLAUDE_ACCESS_FLAGS.auto,
      ...mcpConfigFlags,
      '--permission-prompt-tool',
      claudeToolName(APPROVAL_SERVER, 'approval_prompt'),
    );
    if (mcpTools.length) {
      args.push('--allowedTools', ...mcpTools);
    }
  } else if (readOnlyAllowedTools.length) {
    // Sidecar: a stricter deny list than plain read-only, then the inspection
    // tools it is granted. Machine sandboxes keep Bash for inspection.
    args.push(
      ...CLAUDE_SIDECAR_FLAGS.filter(
        flag => process.env[MACHINE_SANDBOX_ENV] !== '1' || flag !== 'Bash',
      ),
      ...mcpConfigFlags,
      '--allowedTools',
      ...readOnlyAllowedTools,
      ...mcpTools,
    );
  } else {
    args.push(...(CLAUDE_ACCESS_FLAGS[access] ?? CLAUDE_ACCESS_FLAGS.auto), ...mcpConfigFlags);
    if (mcpTools.length) {
      args.push('--allowedTools', ...mcpTools);
    }
  }
  // The permission prompt tool answers Claude, never the model.
  if (approvalServer)
    args.push('--disallowedTools', claudeToolName(APPROVAL_SERVER, 'approval_prompt'));
  for (const directory of additionalDirectories) args.push('--add-dir', directory);
  const readOnlyServers = extraServers.filter(server => server.readOnly);
  const hook = options.approvalTaskId
    ? [
        process.execPath,
        CLI_PATH,
        'task',
        'hook',
        options.approvalTaskId,
        ...(readOnlyServers.length
          ? [
              '--servers',
              readOnlyPath ?? path.join(options.taskRoot ?? cwd, '.claude-read-only.json'),
            ]
          : []),
        '--cwd',
        cwd,
      ]
        .map(shellQuote)
        .join(' ')
    : undefined;
  // The OS sandbox enforces read-only writes when available.
  const turnSettings = claudeTurnSettings(
    access,
    cwd,
    options.allowedNetworkHosts ?? [],
    additionalDirectories,
    process.env[MACHINE_SANDBOX_ENV] !== '1',
    options.scratch,
    options.local ?? true,
    hook,
    [taskSocket()].filter(socket => socket !== undefined),
  );
  const base = turnSettings ? JSON.parse(turnSettings) : {};
  // Read-only servers' calls go to the hook, which lists the server once and refuses tools not marked read-only.
  const readOnlyHooks = hook
    ? readOnlyServers.map(server => ({
        matcher: `${claudeToolName(server.name)}__.*`,
        hooks: [{ type: 'command', command: hook }],
      }))
    : [];
  const settings = {
    ...base,
    // Match Codex's 2% skill listing budget.
    skillListingBudgetFraction: 0.02,
    ...(readOnlyHooks.length
      ? { hooks: { PreToolUse: [...(base.hooks?.PreToolUse ?? []), ...readOnlyHooks] } }
      : {}),
    ...(!options.nativeMcp ? { disableClaudeAiConnectors: true } : {}),
    ...(options.promptCacheTtl && version && compareVersions(version, '2.1.242') >= 0
      ? { promptCacheTtl: options.promptCacheTtl }
      : {}),
  };
  if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));

  return args;
}

/** Inject one user message into a worker-owned Claude stream-json process. */
export async function steerClaudeTurn(
  endpoint: string | null | undefined,
  text: string,
  timeoutMs = 3_000,
  command?: MailboxKey,
): Promise<{ steered: boolean; retryable: boolean; detail: string }> {
  if (!text.trim()) return { steered: false, retryable: false, detail: 'empty follow-up' };
  const reply = await requestControl(
    endpoint,
    { id: mailboxId(command), method: 'turn/steer', params: { text: text.trim() }, command },
    timeoutMs,
    'Claude live steer',
  );
  return {
    steered: reply.ok && reply.result?.accepted === true,
    retryable: reply.retryable,
    detail: reply.detail,
  };
}

export async function runClaudeTurn(
  cwd: string,
  options: ClaudeTurnOptions,
): Promise<ClaudeTurnResult> {
  const result = await claudeTurn(cwd, options);
  if (
    !options.resumeSessionId ||
    !result.error?.message?.includes('No conversation found with session ID')
  )
    return result;

  options.onProgress?.({ kind: 'warning', message: HISTORY_LOST });
  return claudeTurn(cwd, { ...options, resumeSessionId: null });
}
