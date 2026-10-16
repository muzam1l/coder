/**
 * Claude engine over the claude CLI in print mode. Used when the host cannot
 * spawn Claude subagents itself (codex plugin, direct CLI use). Sessions are
 * assigned an id up front so tasks are steerable via --resume, mirroring codex
 * threadIds.
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { processTiming } from '../../../utils/process';

import {
  CLAUDE_PERMISSION_FLAGS,
  CLAUDE_SIDECAR_FLAGS,
  MACHINE_SANDBOX_ENV,
  claudeTurnSettings,
} from '../../config';
import { mailboxId, type MailboxKey } from '../../mailbox';
import { shortPath } from '../../../utils/fsx';
import { serveControl, requestControl } from '../control';
import { CLI_PATH } from '../../runtime';
import { engineEnvironment } from '../../connections';
import { parseVersion } from '../../hosts';
import { compareVersions } from '../../update-check';
import type {
  AuthStatus,
  Availability,
  Effort,
  McpServerSpec,
  Permission,
  ProgressUpdate,
  TokenUsage,
  TurnResult,
} from '../../types';
import { HISTORY_LOST } from '../../types';
import { lastClaudeUsage } from './sessions';

// A token snapshot is only worth logging once the count has actually moved;
// every block of an assistant message reports usage.
const USAGE_LOG_STEP = 1000;

// Tools whose file_path names a file the turn changed.
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

const MCP_STATUS_REQUEST = 'coder-mcp-status';

const claudeVersions = new Map<string, string>();
const CLAUDE_VERSION_ENV = 'CODER_CLAUDE_VERSION';

// Flatten a tool_result block's content (string, or array of text parts) to
// raw text for progress output.
function toolResultText(content: any): string {
  const binary = (value: any): boolean =>
    value &&
    typeof value === 'object' &&
    (typeof value.data === 'string' ||
      typeof value.blob === 'string' ||
      Object.values(value).some(binary));
  const text = (part: any): string => {
    if (typeof part === 'string') return part;
    if (binary(part) || ['image', 'document', 'audio', 'video', 'file'].includes(part?.type))
      return `[${part?.type ?? 'binary'}]`;
    if (typeof part?.text === 'string') return part.text;

    return part == null ? '' : JSON.stringify(part);
  };

  return Array.isArray(content) ? content.map(text).join('') : text(content);
}

function textLineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.at(-1) === '') lines.pop();
  return Math.max(1, lines.length);
}

function matchingLineRanges(file: string, needle: string, replaceAll = false): string[] {
  if (!needle) return [];
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const ranges: string[] = [];
  let from = 0;
  while (from <= source.length) {
    const index = source.indexOf(needle, from);
    if (index < 0) break;
    const start = textLineCount(source.slice(0, index)) + 1;
    const count = Math.max(1, textLineCount(needle));
    ranges.push(count === 1 ? `L${start}` : `L${start}-L${start + count - 1}`);
    if (!replaceAll) break;
    from = index + Math.max(needle.length, 1);
  }
  if (ranges.length > 4) {
    return [...ranges.slice(0, 4), `+${ranges.length - 4} matches`];
  }
  return ranges;
}

// One argument of an unrecognized tool, short enough to sit on a shared line.
function compactValue(value: unknown): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/** Compact, path-first tool detail for task logs and watch output. */
export function describeClaudeToolUse(
  name: string,
  input: Record<string, any>,
  cwd: string,
): string {
  const target = String(input.file_path ?? input.notebook_path ?? input.path ?? '');
  const resolved = target ? (path.isAbsolute(target) ? target : path.resolve(cwd, target)) : '';
  // Paths read best relative to the workspace, which every view names already.
  const shown = target ? shortPath(cwd, resolved) || target : '(unknown path)';
  const where = input.path ? ` in ${shortPath(cwd, String(input.path))}` : '';
  if (name === 'Write') {
    const lines = textLineCount(String(input.content ?? ''));
    return `Write ${shown} ${lines ? `L1-L${lines}` : '(empty file)'}`;
  }
  if (name === 'Edit') {
    const ranges = matchingLineRanges(
      resolved,
      String(input.old_string ?? ''),
      input.replace_all === true,
    );
    return `Edit ${shown}${ranges.length ? ` ${ranges.join(', ')}` : ''}`;
  }
  if (name === 'MultiEdit') {
    const edits = Array.isArray(input.edits) ? input.edits : [];
    const ranges = edits.flatMap((edit: any) =>
      matchingLineRanges(resolved, String(edit?.old_string ?? ''), edit?.replace_all === true),
    );
    return `MultiEdit ${shown}${ranges.length ? ` ${ranges.join(', ')}` : ''} (${edits.length} edits)`;
  }
  if (name === 'NotebookEdit') {
    const cell = input.cell_id ?? input.cell_number;
    return `NotebookEdit ${shown}${cell == null ? '' : ` cell ${cell}`}`;
  }
  if (name === 'Read') {
    const from = Number(input.offset ?? 0);
    const count = Number(input.limit ?? 0);
    const range = from && count ? ` L${from}-L${from + count - 1}` : from ? ` from L${from}` : '';
    return `Read ${shown}${range}`;
  }
  if (name === 'Bash') {
    return `Bash ${String(input.command ?? '').trim() || '(no command)'}`;
  }
  if (name === 'Glob') {
    return `Glob ${String(input.pattern ?? '')}${where}`;
  }
  if (name === 'Grep') {
    const glob = input.glob ? ` (${String(input.glob)})` : '';
    return `Grep ${String(input.pattern ?? '')}${where}${glob}`;
  }
  if (name === 'Task') {
    const agent = input.subagent_type ? `${String(input.subagent_type)}: ` : '';
    return `Task ${agent}${compactValue(input.description ?? input.prompt ?? '')}`;
  }
  if (name === 'WebFetch') {
    return `WebFetch ${String(input.url ?? '')}`;
  }
  if (name === 'WebSearch') {
    return `WebSearch ${String(input.query ?? '')}`;
  }
  if (name === 'TodoWrite') {
    const todos = Array.isArray(input.todos) ? input.todos : [];
    return `TodoWrite ${todos.length} item${todos.length === 1 ? '' : 's'}`;
  }
  const args = Object.entries(input ?? {})
    .map(([key, value]) => `${key}=${compactValue(value)}`)
    .join(' ');
  return args ? `${name} ${args}` : name;
}

// Normalize the result event's usage block ({input_tokens,
// cache_creation_input_tokens, cache_read_input_tokens, output_tokens}).
function normalizeClaudeUsage(usage: any): TokenUsage | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const input = num(usage.input_tokens);
  const cachedInput = num(usage.cache_read_input_tokens) + num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  return { input, cachedInput, output, total: input + cachedInput + output };
}

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

function claudeVersion(executable: string, env: NodeJS.ProcessEnv, cwd: string): string {
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
  permissions?: Permission | null;
  /** Route unresolved permission asks to coder's approval policy (auto mode only). */
  approvalTaskId?: string | null;
  /** Hosts reachable inside the sandbox without approval (auto mode only). */
  allowedNetworkHosts?: string[];
  /** Extra existing directories the turn may reach; writes there follow the permission mode. */
  additionalDirectories?: string[];
  /** Extra directories sandboxed commands may write in every mode, read-only included. */
  writableDirectories?: string[];
  /** Extra environment for the CLI and the commands it runs. */
  env?: Record<string, string>;
  /** Inspection tools for a read-only sidecar; supplying any also applies CLAUDE_SIDECAR_FLAGS. */
  readOnlyAllowedTools?: string[];
  /** Extra MCP servers (env already resolved) plus the tools the turn may call. */
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

/** Build the native CLI invocation so every Claude caller shares one permission policy. */
export function buildClaudeMcpConfig(
  cwd: string,
  options: ClaudeTurnOptions,
): Record<string, unknown> {
  const permissions = options.permissions ?? 'auto';
  const extraServers = options.mcpServers ?? [];
  const mcpServers: Record<string, unknown> = {};
  const approvalServer = permissions === 'auto' && options.approvalTaskId;
  if (approvalServer) {
    mcpServers.coder = {
      type: 'stdio',
      command: process.execPath,
      args: [CLI_PATH, 'task', 'mcp', options.approvalTaskId, '--cwd', cwd],
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
  if (options.excludeDynamicSections) args.push('--exclude-dynamic-system-prompt-sections');
  if (options.settingSources) args.push('--setting-sources', options.settingSources);
  if (options.outputSchema) {
    // Claude Code's validator rejects the draft 2020-12 meta-schema reference that zod writes.
    const { $schema: _, ...schema } = options.outputSchema as Record<string, unknown>;
    args.push('--json-schema', JSON.stringify(schema));
  }
  const permissions = options.permissions ?? 'auto';
  const additionalDirectories = options.additionalDirectories ?? [];
  const readOnlyAllowedTools =
    permissions === 'read-only' ? (options.readOnlyAllowedTools ?? []) : [];
  const extraServers = options.mcpServers ?? [];
  const mcpServers = buildClaudeMcpConfig(cwd, options);
  const approvalServer = permissions === 'auto' && options.approvalTaskId;
  const mcpTools = extraServers.flatMap(server =>
    server.tools?.length
      ? server.tools.map(tool => `mcp__${server.name}__${tool}`)
      : [`mcp__${server.name}`],
  );
  const mcpConfigFlags = Object.keys(mcpServers).length
    ? ['--mcp-config', mcpConfigPath ?? path.join(options.taskRoot ?? cwd, '.claude-mcp.json')]
    : options.nativeMcp
      ? []
      : ['--mcp-config', '{"mcpServers":{}}'];
  if (!options.nativeMcp) args.push('--strict-mcp-config', '--no-chrome');

  if (approvalServer) {
    // Prompt tool is only consulted in default mode (never auto/dontAsk):
    // unresolved asks hit coder's policy instead of a flat deny.
    args.push(
      '--permission-mode',
      'default',
      ...mcpConfigFlags,
      '--permission-prompt-tool',
      'mcp__coder__approval_prompt',
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
    args.push(
      ...(CLAUDE_PERMISSION_FLAGS[permissions] ?? CLAUDE_PERMISSION_FLAGS.auto),
      ...mcpConfigFlags,
    );
    if (mcpTools.length) {
      args.push('--allowedTools', ...mcpTools);
    }
  }
  const writableDirectories = options.writableDirectories ?? [];
  for (const directory of [
    ...additionalDirectories,
    ...(permissions === 'read-only' ? [] : writableDirectories),
  ]) {
    args.push('--add-dir', directory);
  }
  // The OS sandbox enforces read-only writes when available.
  const turnSettings = claudeTurnSettings(
    permissions,
    cwd,
    options.allowedNetworkHosts ?? [],
    additionalDirectories,
    writableDirectories,
    process.env[MACHINE_SANDBOX_ENV] !== '1',
  );
  const settings = {
    ...(turnSettings ? JSON.parse(turnSettings) : {}),
    ...(!options.nativeMcp ? { disableClaudeAiConnectors: true } : {}),
    ...(options.promptCacheTtl && version && compareVersions(version, '2.1.242') >= 0
      ? { promptCacheTtl: options.promptCacheTtl }
      : {}),
  };
  if (Object.keys(settings).length) args.push('--settings', JSON.stringify(settings));

  return args;
}

interface ClaudeInputError extends Error {
  retryable: boolean;
}

function inputError(message: string, retryable: boolean): ClaudeInputError {
  return Object.assign(new Error(message), { retryable });
}

function claudeUserMessage(text: string, command?: MailboxKey) {
  const id = command && mailboxId(command);
  const uuid =
    id &&
    `${id.slice(0, 14)}5${id.slice(15, 19)}${((Number.parseInt(id[19]!, 16) & 3) | 8).toString(16)}${id.slice(20)}`;
  return {
    type: 'user',
    ...(uuid ? { uuid } : {}),
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
    },
  };
}

function createClaudeInputController(
  write: (frame: string, callback: (error?: Error | null) => void) => void,
) {
  let accepting = true;

  return {
    sendInitial(text: string, command?: MailboxKey): Promise<void> {
      return new Promise((resolve, reject) => {
        write(`${JSON.stringify(claudeUserMessage(text, command))}\n`, error => {
          if (error) reject(error);
          else resolve();
        });
      });
    },
    sendSteer(text: string, command?: MailboxKey): Promise<void> {
      if (!accepting) {
        return Promise.reject(inputError('Claude turn is no longer accepting live input.', true));
      }
      return new Promise((resolve, reject) => {
        write(`${JSON.stringify(claudeUserMessage(text, command))}\n`, error => {
          if (!error) {
            resolve();
            return;
          }
          const code = (error as NodeJS.ErrnoException).code;
          const completionRace =
            code === 'EPIPE' ||
            code === 'ERR_STREAM_DESTROYED' ||
            code === 'ERR_STREAM_WRITE_AFTER_END';
          reject(inputError(`Failed to write Claude live steer: ${error.message}`, completionRace));
        });
      });
    },
    stopAccepting() {
      accepting = false;
    },
  };
}

async function startClaudeSteerServer(
  sendSteer: (text: string, command?: MailboxKey) => Promise<void>,
) {
  return serveControl('coder-claude-steer-', async (request, closing) => {
    if (closing) throw inputError('Claude turn is no longer accepting live input.', true);
    const text = typeof request?.params?.text === 'string' ? request.params.text.trim() : '';
    if (request.method !== 'turn/steer' || !text)
      throw inputError('Invalid Claude steer request.', false);
    await sendSteer(text, request.command);
    return { accepted: true };
  });
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

async function claudeTurn(cwd: string, options: ClaudeTurnOptions): Promise<ClaudeTurnResult> {
  const sessionId = options.resumeSessionId ?? randomUUID();
  const mcpServers = buildClaudeMcpConfig(cwd, options);
  const configFile = Object.keys(mcpServers).length
    ? path.join(options.taskRoot ?? cwd, `.claude-mcp-${randomUUID()}.json`)
    : undefined;
  const systemFile = options.systemPrompt
    ? path.join(options.taskRoot ?? cwd, `.claude-system-${randomUUID()}.md`)
    : undefined;
  for (const [file, content] of [
    [configFile, `${JSON.stringify({ mcpServers })}\n`],
    [systemFile, options.systemPrompt],
  ]) {
    if (!file) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content!, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  }
  processTiming('claude.prepare', { resume: Boolean(options.resumeSessionId) });
  const env = engineEnvironment({ ...process.env, ...options.env });
  const version = claudeVersion(options.executable ?? 'claude', env, cwd);
  const args = buildClaudeTurnArgs(cwd, options, sessionId, configFile, version, systemFile);
  const removeConfig = () => {
    for (const file of [configFile, systemFile]) {
      if (!file) continue;
      try {
        fs.unlinkSync(file);
      } catch {
        /* best-effort */
      }
    }
  };

  options.onProgress?.({
    kind: 'status',
    message: `claude turn started (session ${sessionId})`,
    threadId: sessionId,
  });

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    processTiming('claude.spawn');
    const child = spawn(options.executable ?? 'claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    let buffer = '';
    let stderr = '';
    const protocolErrors: string[] = [];
    let resultEvent: any = null;
    let streamSessionId = sessionId;
    let steerServer: Awaited<ReturnType<typeof startClaudeSteerServer>> | null = null;
    let settled = false;
    const input = createClaudeInputController((frame, callback) =>
      child.stdin.write(frame, callback),
    );
    // Timestamp of the previous stream event, to estimate thinking duration.
    let lastEventAt = Date.now();
    // tool_use id -> the call it opened, so its result can report which tool
    // produced it and how long it took.
    const openCalls = new Map<string, { name: string; at: number }>();
    // Output accrues across the turn's requests; input/cached describe the
    // latest one (the context the model is holding right now).
    let outputSoFar = 0;
    let contextTokens = 0;
    let requestUsage: any = null;
    let requestId: string | undefined;
    let loggedTokens = 0;
    // Files the turn wrote, mirroring codex's touchedFiles so both engines
    // report what changed.
    const touched = new Set<string>();

    const handleEvent = (event: any) => {
      if (!event || typeof event !== 'object') {
        return;
      }
      // A protocol event proves Claude completed startup and consumed its
      // configuration. Removing the file on stdin's write callback races the
      // child before it has opened --mcp-config.
      removeConfig();
      options.onHeartbeat?.();
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        streamSessionId = event.session_id;
        // Init carries only the status; the control request returns each server's error.
        if (event.mcp_servers?.some((server: any) => server.status === 'failed'))
          child.stdin.write(
            `${JSON.stringify({ type: 'control_request', request_id: MCP_STATUS_REQUEST, request: { subtype: 'mcp_status' } })}\n`,
          );
      } else if (
        event.type === 'control_response' &&
        event.response?.request_id === MCP_STATUS_REQUEST
      ) {
        for (const server of event.response.response?.mcpServers ?? [])
          if (server.status === 'failed')
            options.onProgress?.({
              kind: 'error',
              message: `MCP server ${server.name} failed to start. ${server.error ?? ''}`.trim(),
            });
      } else if (event.type === 'stream_event' && !event.parent_tool_use_id) {
        const delta = event.event;
        if (delta?.type === 'message_start') {
          requestId = delta.message?.id;
          requestUsage = delta.message?.usage;
        } else if (delta?.type === 'message_delta')
          requestUsage = { ...requestUsage, ...delta.usage };
        const usage = normalizeClaudeUsage(requestUsage);
        contextTokens = usage ? usage.input + usage.cachedInput : 0;
      } else if (event.type === 'assistant' || event.type === 'user') {
        // Each block is logged with its kind, so the text views can tell a
        // command apart from prose without parsing the message back out.
        const usage =
          event.type === 'assistant' ? normalizeClaudeUsage(event.message?.usage) : null;
        if (event.type === 'assistant' && !event.parent_tool_use_id) {
          if (!requestId || requestId !== event.message?.id) requestUsage = null;
          requestId = event.message?.id;
          if (!requestUsage || (usage && usage.input + usage.cachedInput > 0))
            requestUsage = event.message?.usage;
          const latest = normalizeClaudeUsage(requestUsage);
          contextTokens = latest ? latest.input + latest.cachedInput : 0;
        }
        if (usage) {
          outputSoFar += usage.output;
          const total = usage.input + usage.cachedInput + outputSoFar;
          // Every block of a message reports usage; log a snapshot only when
          // the count has actually moved, or the log fills with near-copies.
          if (!loggedTokens || total - loggedTokens >= USAGE_LOG_STEP) {
            loggedTokens = total;
            options.onProgress?.({
              kind: 'usage',
              tokens: { ...usage, output: outputSoFar, total },
              threadId: streamSessionId,
            });
          }
        }
        for (const block of event.message?.content ?? []) {
          if (block?.type === 'tool_use' || block?.type?.endsWith('_tool_use')) {
            const name = String(block.name ?? 'Tool');
            if (block.id) openCalls.set(String(block.id), { name, at: Date.now() });
            if (WRITING_TOOLS.has(name)) {
              const target = String(block.input?.file_path ?? block.input?.notebook_path ?? '');
              if (target) touched.add(path.isAbsolute(target) ? target : path.resolve(cwd, target));
            }
            options.onProgress?.({
              kind: 'tool',
              tool: name,
              ...(block.id ? { callId: String(block.id) } : {}),
              message: describeClaudeToolUse(name, block.input ?? {}, cwd),
              threadId: streamSessionId,
            });
          } else if (block?.type === 'tool_result' || block?.type?.endsWith('_tool_result')) {
            const text = toolResultText(block.content).trim();
            const failed =
              block.is_error === true || block.content?.type?.endsWith('_error') === true;
            const call = block.tool_use_id ? openCalls.get(String(block.tool_use_id)) : undefined;
            if (block.tool_use_id) openCalls.delete(String(block.tool_use_id));
            options.onProgress?.({
              kind: 'tool-result',
              ...(block.tool_use_id ? { callId: String(block.tool_use_id) } : {}),
              ...(call ? { tool: call.name, durationMs: Date.now() - call.at } : {}),
              ...(failed ? { isError: true } : {}),
              message: text || (failed ? '(tool failed with no output)' : '(no output)'),
              threadId: streamSessionId,
            });
          } else if (
            event.type === 'assistant' &&
            block?.type === 'text' &&
            typeof block.text === 'string' &&
            block.text.trim()
          ) {
            options.onProgress?.({
              kind: 'assistant',
              message: block.text.trim(),
              threadId: streamSessionId,
            });
          } else if (
            event.type === 'assistant' &&
            block?.type === 'thinking' &&
            typeof block.thinking === 'string' &&
            block.thinking.trim()
          ) {
            // Logged in full; the views preview its first line and open it up
            // on --trim.
            options.onProgress?.({
              kind: 'reasoning',
              message: block.thinking.trim(),
              durationMs: Math.max(0, Date.now() - lastEventAt),
              threadId: streamSessionId,
            });
          }
        }
      } else if (event.type === 'result') {
        processTiming('claude.result');
        resultEvent = event;
        options.onResult?.({
          status: event.is_error || protocolErrors.length ? 1 : 0,
          threadId: event.session_id ?? streamSessionId,
          finalMessage:
            event.structured_output !== undefined
              ? JSON.stringify(event.structured_output)
              : String(event.result ?? '').trim(),
          error:
            event.is_error || protocolErrors.length
              ? { message: protocolErrors[0] || String(event.result ?? '') }
              : null,
        });
        if (event.session_id) {
          streamSessionId = event.session_id;
        }
        // stream-json input keeps the CLI alive waiting for more messages even
        // after the result. End stdin only after Claude declares this extended
        // turn complete; a steer arriving before this event stays in the same
        // agent loop and is observed at the next model boundary.
        input.stopAccepting();
        child.stdin.end();
      }
      lastEventAt = Date.now();
    };

    child.stdout.on('data', chunk => {
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) {
          continue;
        }
        try {
          handleEvent(JSON.parse(line));
        } catch (error) {
          protocolErrors.push(
            `Invalid Claude stream-json output: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });

    // coder task stop SIGTERMs the worker; take the claude child down with us.
    const onTerm = () => {
      input.stopAccepting();
      child.kill('SIGTERM');
      removeConfig();
      const endpoint = steerServer?.endpoint;
      if (endpoint?.startsWith('file:')) {
        fs.rmSync(endpoint.slice('file:'.length), {
          recursive: true,
          force: true,
        });
      }
      process.exit(143);
    };
    process.on('SIGTERM', onTerm);

    void (async () => {
      if (options.onSteerReady) {
        steerServer = await startClaudeSteerServer((text, command) =>
          input.sendSteer(text, command),
        );
      }
      await input.sendInitial(options.prompt, options.command);
      // The endpoint becomes externally visible only after stdin has accepted
      // the original prompt frame, so no live steer can become frame one.
      if (steerServer) {
        options.onSteerReady?.(steerServer.endpoint);
      }
    })().catch(error => {
      if (settled) return;
      settled = true;
      input.stopAccepting();
      child.kill('SIGTERM');
      removeConfig();
      process.removeListener('SIGTERM', onTerm);
      void steerServer?.close();
      reject(error);
    });

    child.on('error', error => {
      if (settled) return;
      settled = true;
      input.stopAccepting();
      process.removeListener('SIGTERM', onTerm);
      removeConfig();
      void steerServer?.close();
      reject(new Error(`claude spawn failed: ${(error as NodeJS.ErrnoException).message}`));
    });
    child.on('close', async code => {
      if (settled) return;
      settled = true;
      input.stopAccepting();
      process.removeListener('SIGTERM', onTerm);
      removeConfig();
      processTiming('claude.exit');
      await steerServer?.close();
      processTiming('claude.teardown.done');
      const tail = buffer.trim();
      if (tail) {
        try {
          handleEvent(JSON.parse(tail));
        } catch (error) {
          protocolErrors.push(
            `Invalid trailing Claude stream-json output: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      // Trailing newlines are the model's, not the caller's: every consumer
      // prints this with spacing of its own.
      const finalMessage =
        resultEvent?.structured_output !== undefined
          ? JSON.stringify(resultEvent.structured_output)
          : (resultEvent?.result ?? '').trim();
      // No result event means the turn never completed (sandbox init failure,
      // auth error printed to stderr); treat that as failed too.
      const failed =
        code !== 0 ||
        resultEvent?.is_error === true ||
        resultEvent == null ||
        protocolErrors.length > 0;
      processTiming('claude.usage.start');
      const tokens = normalizeClaudeUsage(resultEvent?.usage);
      if (!contextTokens && resultEvent) {
        // Result usage spans requests; prefer the last request's finalized transcript usage.
        const last = normalizeClaudeUsage(
          await lastClaudeUsage(streamSessionId, startedAt, env.CLAUDE_CONFIG_DIR).catch(
            () => null,
          ),
        );
        const usage = last && last.input + last.cachedInput > 0 ? last : tokens;
        contextTokens = usage ? usage.input + usage.cachedInput : 0;
      }
      processTiming('claude.usage.done');
      resolve({
        status: failed ? 1 : 0,
        threadId: resultEvent?.session_id ?? streamSessionId,
        turnId: null,
        finalMessage,
        touchedFiles: [...touched],
        tokens,
        contextTokens,
        // modelUsage is keyed by the actual model id(s) that served the turn.
        model:
          (resultEvent?.modelUsage && Object.keys(resultEvent.modelUsage).join('+')) ||
          options.model ||
          null,
        error: failed
          ? {
              message:
                protocolErrors[0] || finalMessage || stderr.trim() || `claude exited ${code}`,
            }
          : null,
      });
    });
  });
}