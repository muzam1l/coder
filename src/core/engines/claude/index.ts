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

import { CLAUDE_PERMISSION_FLAGS, CLAUDE_SIDECAR_FLAGS, claudeTurnSettings } from '../../config';
import { mailboxId, type MailboxKey } from '../../mailbox';
import { shortPath } from '../../../utils/fsx';
import { CLI_PATH } from '../../runtime';
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

// A token snapshot is only worth logging once the count has actually moved;
// every block of an assistant message reports usage.
const USAGE_LOG_STEP = 1000;

// Tools whose file_path names a file the turn changed.
const WRITING_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// Flatten a tool_result block's content (string, or array of text parts) to
// raw text for progress output.
function toolResultText(content: any): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('');
  }
  return content == null ? '' : JSON.stringify(content);
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

export function getClaudeAvailability(): Availability {
  const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    return {
      available: false,
      detail: 'claude CLI not found on PATH (npm install -g @anthropic-ai/claude-code)',
    };
  }
  return { available: true, detail: String(probe.stdout || '').trim() };
}

// Whether the claude CLI is logged in, via `claude auth status --json`.
export function getClaudeAuthStatus(): AuthStatus {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { loggedIn: true, detail: 'CLAUDE_CODE_OAUTH_TOKEN configured' };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { loggedIn: true, detail: 'ANTHROPIC_API_KEY configured' };
  }
  const probe = spawnSync('claude', ['auth', 'status', '--json'], { encoding: 'utf8' });
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
      args: [CLI_PATH, 'mcp', 'serve', options.approvalTaskId, '--cwd', cwd],
    };
  }
  for (const server of extraServers) {
    mcpServers[server.name] = server.url
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
        };
  }
  return mcpServers;
}

export function buildClaudeTurnArgs(
  cwd: string,
  options: ClaudeTurnOptions,
  sessionId: string,
  mcpConfigPath?: string,
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
  args.push(options.resumeSessionId ? '--resume' : '--session-id', sessionId);
  if (options.model) args.push('--model', options.model);
  if (options.effort) args.push('--effort', options.effort);
  if (options.outputSchema) args.push('--json-schema', JSON.stringify(options.outputSchema));
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
    // tools it is granted. See CLAUDE_SIDECAR_FLAGS for why Bash goes too.
    args.push(
      ...CLAUDE_SIDECAR_FLAGS,
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
  // Read-only is enforced by claude's OS sandbox, scoped to deny writes to this
  // workspace; passed as a settings JSON string so it needs no on-disk config.
  const turnSettings = claudeTurnSettings(
    permissions,
    cwd,
    options.allowedNetworkHosts ?? [],
    additionalDirectories,
    writableDirectories,
  );
  const settings = {
    ...(turnSettings ? JSON.parse(turnSettings) : {}),
    ...(!options.nativeMcp ? { disableClaudeAiConnectors: true } : {}),
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

function atomicJsonWrite(file: string, value: unknown) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, 'utf8');
  fs.renameSync(temp, file);
}

async function startClaudeSteerServer(
  sendSteer: (text: string, command?: MailboxKey) => Promise<void>,
) {
  // A file mailbox works in restricted worker sandboxes that deny Unix socket
  // binds. Atomic rename publishes complete requests/responses across detached
  // processes. The worker responds after the complete JSONL frame has been
  // accepted by Claude's stdin; Claude consumes it at its next model boundary.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'coder-claude-steer-'));
  const endpoint = `file:${directory}`;
  const processing = new Set<Promise<void>>();
  const accepting = new Set<string>();
  let stopped = false;
  let scanning = false;

  const scan = (closing = false) => {
    if ((stopped && !closing) || scanning) return;
    scanning = true;
    try {
      for (const name of fs.readdirSync(directory).filter(name => name.endsWith('.request.json'))) {
        const id = name.slice(0, -'.request.json'.length);
        const requestFile = path.join(directory, name);
        const responseFile = path.join(directory, `${id}.response.json`);
        if (fs.existsSync(responseFile)) {
          fs.unlinkSync(requestFile);
          continue;
        }
        if (accepting.has(id)) continue;
        const claimFile = `${requestFile}.${process.pid}.processing`;
        try {
          fs.renameSync(requestFile, claimFile);
        } catch {
          continue;
        }
        accepting.add(id);
        const work = (async () => {
          let response: any;
          try {
            const request = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
            const text =
              typeof request?.params?.text === 'string' ? request.params.text.trim() : '';
            if (request?.method !== 'turn/steer' || !text || request?.id !== id) {
              response = {
                id,
                error: {
                  message: 'Invalid Claude steer request.',
                  retryable: false,
                },
              };
            } else {
              try {
                await sendSteer(text, request.command);
                response = { id, result: { accepted: true } };
              } catch (error) {
                const input = error as ClaudeInputError;
                response = {
                  id,
                  error: {
                    message: input.message,
                    retryable: input.retryable === true,
                  },
                };
              }
            }
          } catch (error) {
            response = {
              id,
              error: {
                message: `Invalid Claude steer JSON: ${error instanceof Error ? error.message : String(error)}`,
                retryable: false,
              },
            };
          }
          try {
            atomicJsonWrite(responseFile, response);
          } finally {
            accepting.delete(id);
            try {
              fs.unlinkSync(claimFile);
            } catch {
              /* best-effort */
            }
          }
        })();
        processing.add(work);
        void work.then(
          () => processing.delete(work),
          () => processing.delete(work),
        );
      }
    } catch {
      // The directory is removed only after polling stops.
    } finally {
      scanning = false;
    }
  };
  const timer = setInterval(scan, 10);

  return {
    endpoint,
    async close() {
      stopped = true;
      clearInterval(timer);
      // Claim requests that raced the result event. The input controller now
      // answers them as retryable instead of losing them during teardown.
      scan(true);
      await Promise.allSettled([...processing]);
      // Let a waiting steer process observe its final response before cleanup.
      await new Promise(resolve => setTimeout(resolve, 50));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

/** Inject one user message into a worker-owned Claude stream-json process. */
export async function steerClaudeTurn(
  endpoint: string | null | undefined,
  text: string,
  timeoutMs = 3_000,
  command?: MailboxKey,
): Promise<{ steered: boolean; retryable: boolean; detail: string }> {
  if (!endpoint) {
    return {
      steered: false,
      retryable: true,
      detail: 'Claude live steer endpoint is not ready.',
    };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { steered: false, retryable: false, detail: 'empty follow-up' };
  }
  if (!endpoint.startsWith('file:') || endpoint.length === 'file:'.length) {
    return {
      steered: false,
      retryable: false,
      detail: `Unsupported Claude steer endpoint: ${endpoint}`,
    };
  }
  const directory = endpoint.slice('file:'.length);
  if (!fs.existsSync(directory)) {
    return {
      steered: false,
      retryable: true,
      detail: 'Claude live steer endpoint is no longer available.',
    };
  }
  const id = mailboxId(command);
  const requestFile = path.join(directory, `${id}.request.json`);
  const responseFile = path.join(directory, `${id}.response.json`);
  try {
    if (!fs.existsSync(responseFile))
      atomicJsonWrite(requestFile, {
        id,
        method: 'turn/steer',
        params: { text: trimmed },
        command,
      });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      steered: false,
      retryable: code === 'ENOENT',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const response = JSON.parse(fs.readFileSync(responseFile, 'utf8'));
      try {
        if (!command || response?.error?.retryable) fs.unlinkSync(responseFile);
      } catch {
        /* best-effort */
      }
      if (response?.result?.accepted === true) {
        return {
          steered: true,
          retryable: false,
          detail: 'Claude accepted the live follow-up.',
        };
      }
      return {
        steered: false,
        retryable: response?.error?.retryable === true,
        detail: String(response?.error?.message ?? 'Malformed Claude steer response.'),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return {
          steered: false,
          retryable: false,
          detail: `Invalid Claude steer response: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  // The request was published, so acceptance is unknown. Never queue a second
  // copy; surface the protocol failure for the caller and task log.
  return {
    steered: false,
    retryable: false,
    detail: 'Timed out waiting for Claude live steer acknowledgement.',
  };
}

export async function runClaudeTurn(
  cwd: string,
  options: ClaudeTurnOptions,
): Promise<ClaudeTurnResult> {
  const sessionId = options.resumeSessionId ?? randomUUID();
  const mcpServers = buildClaudeMcpConfig(cwd, options);
  const configFile = Object.keys(mcpServers).length
    ? path.join(options.taskRoot ?? cwd, `.claude-mcp-${randomUUID()}.json`)
    : undefined;
  if (configFile) {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, `${JSON.stringify({ mcpServers })}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
  }
  const args = buildClaudeTurnArgs(cwd, options, sessionId, configFile);
  const removeConfig = () => {
    if (!configFile) return;
    try {
      fs.unlinkSync(configFile);
    } catch {
      /* best-effort */
    }
  };

  options.onProgress?.({
    kind: 'status',
    message: `claude turn started (session ${sessionId})`,
    threadId: sessionId,
  });

  return new Promise((resolve, reject) => {
    const child = spawn(options.executable ?? 'claude', args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
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
      } else if (event.type === 'assistant') {
        // Each block is logged with its kind, so the text views can tell a
        // command apart from prose without parsing the message back out.
        const usage = normalizeClaudeUsage(event.message?.usage);
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
          if (block?.type === 'tool_use') {
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
          } else if (
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
            block?.type === 'thinking' &&
            typeof block.thinking === 'string' &&
            block.thinking.trim()
          ) {
            // Logged in full; the views preview its first line and open it up
            // on --trim.
            options.onProgress?.({
              kind: 'reasoning',
              message: block.thinking.trim(),
              durationMs: Math.max(1000, Date.now() - lastEventAt),
              threadId: streamSessionId,
            });
          }
        }
      } else if (event.type === 'user') {
        // Forward tool results raw, so intermediate command output is visible.
        for (const block of event.message?.content ?? []) {
          if (block?.type === 'tool_result') {
            const text = toolResultText(block.content).trim();
            const failed = block.is_error === true;
            const call = block.tool_use_id ? openCalls.get(String(block.tool_use_id)) : undefined;
            if (block.tool_use_id) openCalls.delete(String(block.tool_use_id));
            // An empty result still closes its call.
            if (!text && !failed && !call) continue;
            options.onProgress?.({
              kind: 'tool-result',
              ...(block.tool_use_id ? { callId: String(block.tool_use_id) } : {}),
              ...(call ? { tool: call.name, durationMs: Date.now() - call.at } : {}),
              ...(failed ? { isError: true } : {}),
              message: text || (failed ? '(tool failed with no output)' : ''),
              threadId: streamSessionId,
            });
          }
        }
      } else if (event.type === 'result') {
        resultEvent = event;
        options.onResult?.({
          status: event.is_error ? 1 : 0,
          threadId: event.session_id ?? streamSessionId,
          finalMessage:
            event.structured_output !== undefined
              ? JSON.stringify(event.structured_output)
              : String(event.result ?? '').trim(),
          error: event.is_error ? { message: String(event.result ?? '') } : null,
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
      await steerServer?.close();
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
      resolve({
        status: failed ? 1 : 0,
        threadId: resultEvent?.session_id ?? streamSessionId,
        turnId: null,
        finalMessage,
        touchedFiles: [...touched],
        tokens: normalizeClaudeUsage(resultEvent?.usage),
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
