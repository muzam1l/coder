/** One codex turn as the app-server reports it: its items captured into progress lines, token usage and the final message. */
import fs from 'node:fs';

import { shortPath } from '../../../utils/fsx';
import { processTiming } from '../../../utils/process';
import { MACHINE_SANDBOX_ENV, resolveCustomModel } from '../../config';
import type { McpServerSpec, ProgressUpdate, TokenUsage, TurnResult } from '../../types';
import { HISTORY_LOST } from '../../types';
import type { CodexAppServerClient } from './app-server';
import { startCodexControlServer } from './control';
import { isCodexSessionArchived, unarchiveCodexSession } from './sessions';
import type { RunTurnOptions } from '.';

// Only log a token snapshot once the count has moved this far.
const USAGE_LOG_STEP = 1000;

const TASK_THREAD_PREFIX = 'Coder Task';

const SERVICE_NAME = 'coder_runtime';

/** The connected app-server client (spawned or broker transport). */
export type AppServerClient = Awaited<ReturnType<typeof CodexAppServerClient.connect>>;

/**
 * An approval callback: answers a server-initiated request during a turn. The
 * third arg is the live turn-capture state, passed opaquely to external handlers
 * (e.g. the approvals module), so it is typed loosely at this boundary.
 */
export type ApprovalRequestHandler = (method: string, params: any, state?: any) => unknown;

/** A progress reporter passed by callers to observe a turn. */
export type ProgressReporter = (update: ProgressUpdate) => void;

/** A single item emitted by the app-server (command, file change, message, ...). */
interface TurnItem {
  id?: string;
  type?: string;
  status?: string;
  text?: string;
  phase?: string;
  command?: string;
  exitCode?: number | null;
  changes?: Array<{
    path?: string;
    kind?: string | { type?: string; move_path?: string | null };
    diff?: string;
  }>;
  server?: string;
  tool?: string;
  query?: string;
  summary?: unknown;
  receiverThreadIds?: string[];
  [key: string]: unknown;
}

/** A turn descriptor from turn/started and turn/completed. */
interface Turn {
  id?: string;
  status?: string;
  [key: string]: unknown;
}

/** A JSON-RPC notification/request frame from the app-server. */
interface AppServerMessage {
  method?: string;
  params?: any;
  [key: string]: unknown;
}

type Lifecycle = 'started' | 'completed';

/** Mutable state accumulated while capturing a single turn. */
export interface TurnCaptureState {
  threadId: string;
  rootThreadId: string;
  threadIds: Set<string>;
  threadTurnIds: Map<string, string>;
  turnId: string | null;
  bufferedNotifications: AppServerMessage[];
  completion: Promise<TurnCaptureState>;
  resolveCompletion: (state: TurnCaptureState) => void;
  rejectCompletion: (error: unknown) => void;
  finalTurn: Turn | null;
  completed: boolean;
  finalAnswerSeen: boolean;
  pendingCollaborations: Set<string>;
  activeSubagentTurns: Set<string>;
  completionTimer: ReturnType<typeof setTimeout> | null;
  lastAgentMessage: string;
  reasoningSummary: string[];
  reasoningStartedAt: Map<string, number>;
  error: { message?: string } | null;
  fileChanges: TurnItem[];
  commandExecutions: TurnItem[];
  // threadId -> latest cumulative token usage reported for that thread.
  tokenUsageByThread: Map<string, TokenUsage>;
  tokenUsageBaselineByThread: Map<string, TokenUsage>;
  contextTokens?: number;
  lastDiffSummary: string;
  loggedTokens: number;
  // Files already reported by a fileChange item, so the turn's aggregate diff
  // only has to mention what they missed.
  reportedChanges: Set<string>;
  /** Workspace root, so logged paths are relative to it. */
  cwd: string;
  itemIndex: Map<string, TurnItem>;
  onProgress: ProgressReporter | null;
  onHeartbeat: (() => void) | null;
}

interface CaptureTurnOptions {
  cwd?: string;
  onProgress?: ProgressReporter | null;
  onHeartbeat?: (() => void) | null;
  onApprovalRequest?: ApprovalRequestHandler;
  onTurnStarted?: (turnId: string) => Promise<void> | void;
}

function shorten(text: unknown, limit = 72) {
  const normalized = String(text ?? '')
    .trim()
    .replace(/\s+/g, ' ');
  if (!normalized) {
    return '';
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

export function buildTaskThreadName(prompt: string) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message: AppServerMessage): string | null {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message: AppServerMessage): string | null {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function changedLineRanges(diff: string, kind: string): string[] {
  const ranges: string[] = [];
  const hunks = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const match of diff.matchAll(hunks)) {
    const deleting = kind === 'delete';
    const start = Number(deleting ? match[1] : match[3]);
    const count = Number((deleting ? match[2] : match[4]) ?? 1);
    if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
    ranges.push(count <= 1 ? `L${start}` : `L${start}-L${start + count - 1}`);
  }
  return ranges;
}

function currentFileRange(file: string): string[] {
  try {
    const content = fs.readFileSync(file, 'utf8');
    const lines = content
      ? content.split(/\r\n|\r|\n/).length - (content.endsWith('\n') ? 1 : 0)
      : 0;
    return lines > 0 ? [lines === 1 ? 'L1' : `L1-L${lines}`] : [];
  } catch {
    return [];
  }
}

function describeFileChange(
  change: NonNullable<TurnItem['changes']>[number],
  readAddedFile: boolean,
  cwd?: string,
): string {
  const kind = typeof change.kind === 'string' ? change.kind : (change.kind?.type ?? 'change');
  const file = change.path || '(unknown path)';
  const diffRanges = changedLineRanges(change.diff ?? '', kind);
  const ranges =
    diffRanges.length || kind !== 'add' || !readAddedFile ? diffRanges : currentFileRange(file);
  const moved =
    typeof change.kind === 'object' && change.kind?.move_path
      ? ` -> ${cwd ? shortPath(cwd, change.kind.move_path) : change.kind.move_path}`
      : '';
  const shown = cwd ? shortPath(cwd, file) : file;
  return `${kind} ${shown}${moved}${ranges.length ? ` ${ranges.join(', ')}` : ''}`;
}

export function describeCodexFileChanges(
  item: TurnItem,
  readAddedFiles = false,
  cwd?: string,
): string {
  return (item.changes ?? [])
    .map(change => describeFileChange(change, readAddedFiles, cwd))
    .join('; ');
}

function diffPath(header: string): string {
  const value = header.trim().split('\t')[0] ?? '';
  return value === '/dev/null' ? '' : value.replace(/^[ab]\//, '');
}

/** Summarize an aggregate unified diff as path plus destination line spans. */
export function describeCodexTurnDiff(diff: string, cwd?: string): string {
  const files = new Map<string, string[]>();
  let oldPath = '';
  let newPath = '';
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('--- ')) {
      oldPath = diffPath(line.slice(4));
      continue;
    }
    if (line.startsWith('+++ ')) {
      newPath = diffPath(line.slice(4));
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (!hunk) continue;
    const oldStart = Number(hunk[1]);
    const oldCount = Number(hunk[2] ?? 1);
    const newStart = Number(hunk[3]);
    const newCount = Number(hunk[4] ?? 1);
    const deleting = newCount === 0;
    const file = (deleting ? oldPath : newPath) || newPath || oldPath || '(unknown path)';
    const start = deleting ? oldStart : newStart;
    const count = deleting ? oldCount : newCount;
    const range = count <= 1 ? `L${start}` : `L${start}-L${start + count - 1}`;
    const ranges = files.get(file) ?? [];
    ranges.push(range);
    files.set(file, ranges);
  }
  return [...files]
    .map(([file, ranges]) => `${cwd ? shortPath(cwd, file) : file} ${ranges.join(', ')}`)
    .join('; ');
}

// Normalize an app-server TokenUsage ({inputTokens, cachedInputTokens,
// outputTokens, reasoningOutputTokens, totalTokens}) to the shared shape.
function normalizeTokenUsage(usage: any): TokenUsage | null {
  if (!usage || typeof usage !== 'object') {
    return null;
  }
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
  const input = num(usage.inputTokens);
  const cachedInput = num(usage.cachedInputTokens);
  const output = num(usage.outputTokens);
  return {
    input,
    cachedInput,
    output,
    total: num(usage.totalTokens) || input + cachedInput + output,
  };
}

// Sum this turn's usage across the main thread and its children.
export function collectTokenUsage(state: TurnCaptureState): TokenUsage | null {
  if (state.tokenUsageByThread.size === 0) {
    return null;
  }
  const sum: TokenUsage = { input: 0, cachedInput: 0, output: 0, total: 0 };
  for (const [threadId, usage] of state.tokenUsageByThread) {
    const baseline = state.tokenUsageBaselineByThread.get(threadId);
    sum.input += Math.max(0, usage.input - (baseline?.input ?? 0));
    sum.cachedInput += Math.max(0, usage.cachedInput - (baseline?.cachedInput ?? 0));
    sum.output += Math.max(0, usage.output - (baseline?.output ?? 0));
    sum.total += Math.max(0, usage.total - (baseline?.total ?? 0));
  }
  return sum;
}

function normalizeReasoningText(text: unknown) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReasoningSections(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (typeof value === 'string') {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(entry => extractReasoningSections(entry));
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') {
      return extractReasoningSections(record.text);
    }
    if ('summary' in record) {
      return extractReasoningSections(record.summary);
    }
    if ('content' in record) {
      return extractReasoningSections(record.content);
    }
    if ('parts' in record) {
      return extractReasoningSections(record.parts);
    }
  }
  return [];
}

function mergeReasoningSections(existingSections: string[], nextSections: string[]): string[] {
  const merged: string[] = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

interface ProgressLine {
  message: string;
  phase?: string | null;
  /** Structured fields carried alongside the text (kind, exit code, ...). */
  extra?: Record<string, unknown>;
}

export function emitProgress(
  onProgress: ProgressReporter | null | undefined,
  message: string | null | undefined,
  phase: string | null = null,
  extra: Record<string, unknown> = {},
) {
  // An empty message is still worth logging when the entry carries structure
  // (a failed command that printed nothing); only "no line at all" is skipped.
  if (!onProgress || message == null) {
    return;
  }
  onProgress({ message, phase, ...extra });
}

function emitLine(onProgress: ProgressReporter | null | undefined, line: ProgressLine | null) {
  if (line) emitProgress(onProgress, line.message, line.phase ?? null, line.extra ?? {});
}

// Codex runs everything through a login shell; the wrapper is the same on
// every line and only crowds out the command that varies. The raw invocation
// is still on the turn result.
function unwrapShell(command: string): string {
  return command.replace(/^\/(?:usr\/)?bin\/\w*sh\s+-l?c\s+/, '');
}

// Messages are logged raw (full command, full output) like the claude core;
// the text views trim them for display and --json keeps everything.
/** Tags a tool call and its result with the item id, so concurrent calls pair with their own results. */
function withCallId(line: ProgressLine | null, item: TurnItem): ProgressLine | null {
  const kind = line?.extra?.kind;
  if (!line || (kind !== 'tool' && kind !== 'tool-result') || typeof item.id !== 'string')
    return line;

  return { ...line, extra: { ...line.extra, callId: item.id } };
}

function itemText(value: unknown): string {
  return value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
}

function describeGenericItem(item: TurnItem): ProgressLine {
  const tool = String(item.tool || item.name || item.kind || item.type || 'tool');
  const input = Object.fromEntries(
    Object.entries(item).filter(
      ([key, value]) =>
        value != null &&
        ![
          'id',
          'type',
          'kind',
          'name',
          'tool',
          'status',
          'result',
          'results',
          'output',
          'error',
          'contentItems',
          'success',
          'durationMs',
          'exitCode',
        ].includes(key),
    ),
  );
  const detail = Object.keys(input).length ? itemText(input) : '';

  return {
    message: detail ? `${tool} ${detail}` : tool,
    phase: 'investigating',
    extra: { kind: 'tool', tool },
  };
}

function describeStartedItem(item: TurnItem, cwd?: string): ProgressLine | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        message: unwrapShell(String(item.command ?? '').trim()) || 'command',
        phase: 'running',
        extra: { kind: 'tool', tool: 'command' },
      };
    case 'fileChange':
      return {
        message: describeCodexFileChanges(item, false, cwd) || 'edit',
        phase: 'editing',
        extra: { kind: 'tool', tool: 'edit' },
      };
    case 'mcpToolCall':
      return {
        message: [`${item.server}/${item.tool}`, itemText(item.arguments)]
          .filter(Boolean)
          .join(' '),
        phase: 'investigating',
        extra: { kind: 'tool', tool: String(item.tool ?? '') },
      };
    case 'dynamicToolCall':
      return {
        message: [
          [item.namespace, item.tool || 'tool'].filter(Boolean).join('/'),
          itemText(item.arguments),
        ]
          .filter(Boolean)
          .join(' '),
        phase: 'investigating',
        extra: { kind: 'tool', tool: String(item.tool ?? '') },
      };
    case 'webSearch': {
      const action = item.action as Record<string, unknown> | null;
      const queries = Array.isArray(action?.queries)
        ? action.queries.filter(query => typeof query === 'string' && query.trim())
        : [];
      const detail = queries.length
        ? queries.join('; ')
        : String(action?.query || item.query || '').trim() || itemText(action);
      return {
        message: detail ? `search: ${detail}` : 'search',
        phase: 'investigating',
        extra: { kind: 'tool', tool: 'search' },
      };
    }
    case 'agentMessage':
    case 'reasoning':
    case 'userMessage':
      return null;
    default:
      return describeGenericItem(item);
  }
}

function describeCompletedItem(item: TurnItem, cwd?: string): ProgressLine | null {
  switch (item.type) {
    case 'agentMessage': {
      const text = String(item.text ?? '').trim();
      return text ? { message: text, phase: null, extra: { kind: 'assistant' } } : null;
    }
    case 'reasoning': {
      // Logged whole; the views preview it and open it up on --trim.
      const summary = extractReasoningSections(item.summary).join('\n');
      return summary ? { message: summary, phase: null, extra: { kind: 'reasoning' } } : null;
    }
    case 'commandExecution': {
      // The command is already on the line above. Repeating it here only
      // crowds out the output that this entry exists to carry.
      const exitCode = typeof item.exitCode === 'number' ? item.exitCode : null;
      return {
        message: String(item.aggregatedOutput ?? '').trim(),
        phase: 'running',
        extra: {
          kind: 'tool-result',
          tool: 'command',
          command: String(item.command ?? '').trim(),
          durationMs: item.durationMs,
          ...(exitCode === null ? { isError: item.status !== 'completed' } : { exitCode }),
        },
      };
    }
    case 'fileChange':
      return {
        message: describeCodexFileChanges(item, true, cwd) || '(details unavailable)',
        phase: 'editing',
        extra: { kind: 'tool-result', tool: 'edit', isError: item.status !== 'completed' },
      };
    case 'mcpToolCall':
      return {
        message:
          itemText(item.error ?? item.result) || `${item.server}/${item.tool} ${item.status}`,
        phase: 'investigating',
        extra: {
          kind: 'tool-result',
          tool: String(item.tool ?? ''),
          durationMs: item.durationMs,
          isError: item.status !== 'completed' || item.error != null,
        },
      };
    case 'dynamicToolCall':
      return {
        message: itemText(item.contentItems) || `${item.tool} ${item.status}`,
        phase: 'investigating',
        extra: {
          kind: 'tool-result',
          tool: String(item.tool ?? ''),
          durationMs: item.durationMs,
          isError: item.status !== 'completed' || item.success === false,
        },
      };
    case 'userMessage':
      return null;
    default:
      return {
        message: itemText(
          item.error ?? item.result ?? item.results ?? item.output ?? item.action ?? item,
        ),
        phase: 'investigating',
        extra: {
          kind: 'tool-result',
          tool: describeStartedItem(item, cwd)?.extra?.tool,
          durationMs: item.durationMs,
          isError:
            item.status === 'failed' ||
            item.status === 'declined' ||
            item.success === false ||
            item.error != null,
        },
      };
  }
}

function createTurnCaptureState(
  threadId: string,
  options: CaptureTurnOptions = {},
): TurnCaptureState {
  let resolveCompletion!: (state: TurnCaptureState) => void;
  let rejectCompletion!: (error: unknown) => void;
  const completion = new Promise<TurnCaptureState>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });

  return {
    threadId,
    rootThreadId: threadId,
    threadIds: new Set([threadId]),
    threadTurnIds: new Map(),
    turnId: null,
    bufferedNotifications: [],
    completion,
    resolveCompletion,
    rejectCompletion,
    finalTurn: null,
    completed: false,
    finalAnswerSeen: false,
    pendingCollaborations: new Set(),
    activeSubagentTurns: new Set(),
    completionTimer: null,
    lastAgentMessage: '',
    reasoningSummary: [],
    reasoningStartedAt: new Map(),
    error: null,
    fileChanges: [],
    commandExecutions: [],
    tokenUsageByThread: new Map(),
    tokenUsageBaselineByThread: new Map(),
    lastDiffSummary: '',
    loggedTokens: 0,
    reportedChanges: new Set(),
    cwd: options.cwd ?? '',
    // itemId -> item, populated on item/started so approval callbacks can look
    // up the pending command/file change they refer to.
    itemIndex: new Map(),
    onProgress: options.onProgress ?? null,
    onHeartbeat: options.onHeartbeat ?? null,
  };
}

function clearCompletionTimer(state: TurnCaptureState) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state: TurnCaptureState, turn: Turn | null = null) {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id ?? null;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = { id: state.turnId ?? 'inferred-turn', status: 'completed' };
  }
  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state: TurnCaptureState) {
  if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
    return;
  }
  if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
    return;
  }
  clearCompletionTimer(state);
  state.completionTimer = setTimeout(() => {
    state.completionTimer = null;
    if (state.completed || state.finalTurn || !state.finalAnswerSeen) {
      return;
    }
    if (state.pendingCollaborations.size > 0 || state.activeSubagentTurns.size > 0) {
      return;
    }
    completeTurn(state, null);
  }, 250);
  state.completionTimer.unref?.();
}

function belongsToTurn(state: TurnCaptureState, message: AppServerMessage) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(
  state: TurnCaptureState,
  item: TurnItem,
  lifecycle: Lifecycle,
  threadId: string | null = null,
) {
  if (item.id) {
    state.itemIndex.set(item.id, item);
  }

  if (item.type === 'collabAgentToolCall') {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === 'started' || item.status === 'inProgress') {
        state.pendingCollaborations.add(item.id as string);
      } else if (lifecycle === 'completed') {
        state.pendingCollaborations.delete(item.id as string);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      state.threadIds.add(receiverThreadId);
    }
  }

  if (item.type === 'agentMessage') {
    if (item.text && (!threadId || threadId === state.threadId)) {
      // Models end an answer with a newline as often as not; every caller that
      // prints this adds its own spacing, so the padding is theirs to decide.
      state.lastAgentMessage = item.text.trim();
      if (lifecycle === 'completed' && item.phase === 'final_answer') {
        state.finalAnswerSeen = true;
        scheduleInferredCompletion(state);
      }
    }
    return;
  }

  if (item.type === 'reasoning' && lifecycle === 'completed') {
    state.reasoningSummary = mergeReasoningSections(
      state.reasoningSummary,
      extractReasoningSections(item.summary),
    );
    return;
  }

  if (item.type === 'fileChange' && lifecycle === 'completed') {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === 'commandExecution' && lifecycle === 'completed') {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state: TurnCaptureState, message: AppServerMessage) {
  // Any notification for this turn is a sign of life, including ones the
  // switch below ignores, like command output deltas during a long command.
  state.onHeartbeat?.();
  switch (message.method) {
    case 'thread/started':
      state.threadIds.add(message.params.thread.id);
      break;
    case 'turn/started':
      state.threadIds.add(message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(state.onProgress, `Turn started (${message.params.turn.id}).`, 'starting', {
        kind: 'status',
        threadId: message.params.threadId ?? null,
        turnId: message.params.turn.id ?? null,
      });
      break;
    case 'item/started':
      if (message.params.item?.type === 'reasoning' && message.params.item.id) {
        state.reasoningStartedAt.set(
          `${message.params.threadId}:${message.params.item.id}`,
          Date.now(),
        );
      }
      recordItem(state, message.params.item, 'started', message.params.threadId ?? null);
      emitLine(
        state.onProgress,
        withCallId(describeStartedItem(message.params.item, state.cwd), message.params.item),
      );
      break;
    case 'item/completed': {
      const item = { ...state.itemIndex.get(message.params.item.id), ...message.params.item };
      recordItem(state, item, 'completed', message.params.threadId ?? null);
      if (item?.type === 'fileChange') {
        for (const change of item.changes ?? []) {
          if (change.path) state.reportedChanges.add(shortPath(state.cwd, change.path));
        }
      }
      const line = withCallId(describeCompletedItem(item, state.cwd), item);
      if (line?.extra?.kind === 'tool-result') {
        const call = describeStartedItem(item, state.cwd);
        line.extra = {
          ...line.extra,
          callMessage: item.type === 'fileChange' ? line.message : call?.message,
        };
      }
      if (item?.type === 'reasoning') {
        const key = `${message.params.threadId}:${item.id}`;
        const startedAt = state.reasoningStartedAt.get(key);
        state.reasoningStartedAt.delete(key);
        if (line)
          line.extra = {
            ...line.extra,
            durationMs: Math.max(0, Date.now() - (startedAt ?? Date.now())),
          };
      }
      emitLine(state.onProgress, line);
      break;
    }
    case 'thread/tokenUsage/updated': {
      const last = normalizeTokenUsage(message.params?.tokenUsage?.last);
      const usageThreadId = extractThreadId(message);
      if (usageThreadId === state.threadId && message.params?.tokenUsage?.last) {
        state.contextTokens = last?.total;
      }
      // Cumulative per-thread usage; keep the latest snapshot per thread and
      // sum across threads (subagents included) when the turn completes.
      const usage = normalizeTokenUsage(
        message.params?.tokenUsage?.total ?? message.params?.tokenUsage,
      );
      if (usage && usageThreadId) {
        if (last && !state.tokenUsageByThread.has(usageThreadId)) {
          state.tokenUsageBaselineByThread.set(usageThreadId, {
            input: Math.max(0, usage.input - last.input),
            cachedInput: Math.max(0, usage.cachedInput - last.cachedInput),
            output: Math.max(0, usage.output - last.output),
            total: Math.max(0, usage.total - last.total),
          });
        }
        state.tokenUsageByThread.set(usageThreadId, usage);
        const total = collectTokenUsage(state);
        if (total && (!state.loggedTokens || total.total - state.loggedTokens >= USAGE_LOG_STEP)) {
          state.loggedTokens = total.total;
          state.onProgress?.({
            kind: 'usage',
            tokens: total,
            context: state.contextTokens ?? null,
          });
        }
      }
      break;
    }
    case 'turn/diff/updated': {
      // Every file the turn touched via a fileChange item already has its own
      // line; only report what the aggregate diff adds (an apply_patch run as
      // a plain command, say).
      const summary = describeCodexTurnDiff(String(message.params?.diff ?? ''), state.cwd)
        .split('; ')
        .filter(part => !state.reportedChanges.has(part.split(' ')[0] ?? ''))
        .join('; ');
      if (summary && summary !== state.lastDiffSummary) {
        state.lastDiffSummary = summary;
        emitProgress(state.onProgress, `changed: ${summary}`, 'editing', { kind: 'status' });
      }
      break;
    }
    case 'item/autoApprovalReview/completed': {
      const review = message.params?.review ?? {};
      const action = message.params?.action ?? {};
      // Unwrapped like the tool line above it, so the views can tell it is the
      // same command and skip repeating it. The message is what --echo prints;
      // the fields are what the transcript renders as an approval.
      const target = unwrapShell(String(action.command ?? action.type ?? '').trim());
      emitProgress(
        state.onProgress,
        `Auto-review ${review.status}. ${shorten(target, 48)}${review.rationale ? `. ${shorten(review.rationale, 320)}` : ''}`,
        null,
        {
          kind: 'auto-review',
          decision: String(review.status ?? ''),
          ...(review.riskLevel ? { riskLevel: String(review.riskLevel) } : {}),
          ...(target ? { summary: `run command: ${target}` } : {}),
          ...(review.rationale ? { reason: String(review.rationale) } : {}),
        },
      );
      break;
    }
    case 'error':
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, 'failed', {
        kind: 'error',
      });
      break;
    case 'turn/completed':
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(state.onProgress, `Turn ${message.params.turn.status}.`, 'finalizing', {
        kind: 'status',
      });
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

export async function captureTurn(
  client: AppServerClient,
  threadId: string,
  startRequest: () => Promise<any>,
  options: CaptureTurnOptions = {},
): Promise<TurnCaptureState> {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message: AppServerMessage) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }
    if (message.method === 'thread/started') {
      applyTurnNotification(state, message);
      return;
    }
    if (!belongsToTurn(state, message)) {
      previousHandler?.(message);
      return;
    }
    applyTurnNotification(state, message);
  });

  const onApprovalRequest = options.onApprovalRequest;
  if (onApprovalRequest) {
    client.setServerRequestHandler((method: string, params: any) =>
      onApprovalRequest(method, params, state),
    );
  }

  try {
    const response = await startRequest();
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
      await options.onTurnStarted?.(state.turnId);
    }
    for (const message of state.bufferedNotifications) {
      if (belongsToTurn(state, message)) {
        applyTurnNotification(state, message);
      } else {
        previousHandler?.(message);
      }
    }
    state.bufferedNotifications.length = 0;

    if (response.turn?.status && response.turn.status !== 'inProgress') {
      completeTurn(state, response.turn);
    }

    // The app-server (or the broker in front of it) dying ends the turn too.
    const exited = client.exitPromise?.then(() => {
      throw (
        client.exitError ??
        new Error('codex app-server connection closed before the turn completed.')
      );
    });
    return await (exited ? Promise.race([state.completion, exited]) : state.completion);
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
    client.setServerRequestHandler(null);
  }
}

/** turn/start sandboxPolicy carrying extra writable roots or read-only network, or null to keep the thread's sandbox. */
export function codexSandboxPolicy(
  sandbox: string | undefined,
  networkAccess: boolean | undefined,
  writableRoots: string[] = [],
): Record<string, unknown> | null {
  if (sandbox === 'read-only') return networkAccess ? { type: 'readOnly', networkAccess } : null;
  if (sandbox !== 'workspace-write' || !writableRoots.length) return null;
  // Temp roots stay read-only: the task's scratch is one of the writable roots.
  return {
    type: 'workspaceWrite',
    writableRoots,
    networkAccess: networkAccess ?? false,
    excludeTmpdirEnvVar: true,
    excludeSlashTmp: true,
  };
}

/** Thread-scoped MCP servers. */
export function buildCodexMcpOverrides(
  servers: McpServerSpec[] = [],
  nativeServers: string[] = [],
  nativeMcp = false,
): { mcp_servers?: Record<string, unknown> } {
  const configured: Record<string, unknown> = Object.fromEntries(
    (nativeMcp ? [] : nativeServers).map(name => [name, { enabled: false }]),
  );
  const names = new Set([...nativeServers, ...servers.map(server => server.name)]);
  for (const server of servers) {
    let name = server.name;
    if (nativeServers.includes(name)) {
      for (let suffix = 1; names.has(name); suffix++) name = `${server.name}_coder_${suffix}`;
      names.add(name);
    }
    configured[name] = {
      ...(server.url
        ? { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) }
        : {
            command: server.command,
            args: server.args ?? [],
            ...(server.env ? { env: server.env } : {}),
          }),
      default_tools_approval_mode: 'approve',
    };
  }
  return Object.keys(configured).length ? { mcp_servers: configured } : {};
}

function cleanCodexStderr(stderr: string) {
  return stderr
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(
      line =>
        line && !line.startsWith('WARNING: proceeding, even though we could not update PATH:'),
    )
    .join('\n');
}

function missingBridge(): never {
  throw new Error('The Codex app-server has no custom-model bridge; restart the Coder broker.');
}

/** One turn on a new or resumed thread of `client`. */
export async function threadTurn(
  client: AppServerClient,
  cwd: string,
  prompt: string,
  options: RunTurnOptions,
): Promise<TurnResult> {
  const mode =
    process.env[MACHINE_SANDBOX_ENV] === '1' && (options.sandbox ?? 'read-only') !== 'read-only'
      ? 'danger-full-access'
      : options.sandbox;
  const sandbox = { sandbox: mode ?? 'read-only' };
  // A policy that asks answers through the handler, never a reviewer the user's config names.
  const reviewer =
    options.approvalsReviewer ?? ((options.approvalPolicy ?? 'never') === 'never' ? null : 'user');
  const configOverrides =
    options.configOverrides && Object.keys(options.configOverrides).length
      ? options.configOverrides
      : null;
  const sandboxPolicy = codexSandboxPolicy(mode, options.networkAccess, options.writableRoots);

  let controlServer: Awaited<ReturnType<typeof startCodexControlServer>> | null = null;
  let threadId: string;
  processTiming('codex.config.start');
  const effective = await client.request('config/read', { cwd, includeLayers: false });
  processTiming('codex.config.done');
  const custom = options.customModel
    ? resolveCustomModel(
        options.customModel.alias,
        options.customModel.entry,
        client.bridgeUrl ?? missingBridge(),
      )
    : null;
  const model = options.customModel?.entry.model ?? options.model ?? null;
  const threadConfig = {
    ...(!custom ? { model_reasoning_summary: 'auto' } : {}),
    ...custom?.configOverrides,
    ...configOverrides,
    ...buildCodexMcpOverrides(
      options.mcpServers,
      Object.keys(effective.config?.mcp_servers ?? {}),
      options.nativeMcp,
    ),
    ...(!options.nativeMcp ? { 'features.apps': false, 'features.plugins': false } : {}),
    // Snapshots save the shell's environment, task tokens included, to disk.
    'features.shell_snapshot': false,
  };

  const developer = options.developerInstructions
    ? { developerInstructions: options.developerInstructions }
    : {};
  let resumed: { thread: { id: string } } | undefined;
  if (options.resumeThreadId) {
    emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, 'starting', {
      kind: 'status',
    });
    // Sessions may have been auto-archived since the task stopped; resume
    // rejects archived sessions.
    if (isCodexSessionArchived(options.resumeThreadId)) {
      await unarchiveCodexSession(options.resumeThreadId);
    }
    resumed = await client
      .request('thread/resume', {
        threadId: options.resumeThreadId,
        cwd,
        model,
        modelProvider: custom?.modelProvider ?? null,
        config: threadConfig,
        approvalPolicy: options.approvalPolicy ?? 'never',
        ...sandbox,
        // Only sent when set: older codex builds reject unknown enum-bearing fields.
        ...(reviewer ? { approvalsReviewer: reviewer } : {}),
        ...developer,
      })
      .catch(error => {
        emitProgress(options.onProgress, HISTORY_LOST, 'starting', {
          kind: 'warning',
          detail: String(error?.message ?? error),
        });
        return undefined;
      });
  }
  if (resumed) {
    threadId = resumed.thread.id;
  } else {
    emitProgress(options.onProgress, 'Starting Codex task thread.', 'starting', {
      kind: 'status',
    });
    processTiming('codex.thread.start');
    const response = await client.request('thread/start', {
      cwd,
      model,
      modelProvider: custom?.modelProvider ?? null,
      config: threadConfig,
      approvalPolicy: options.approvalPolicy ?? 'never',
      ...sandbox,
      ...(reviewer ? { approvalsReviewer: reviewer } : {}),
      ...developer,
      serviceName: SERVICE_NAME,
      // Persist by default so status/steer/stop can target the thread later.
      ephemeral: options.ephemeral ?? false,
    });
    threadId = response.thread.id;
    // Ephemeral threads reject metadata updates; they are never listed anyway.
    if (!(options.ephemeral ?? false)) {
      try {
        await client.request('thread/name/set', { threadId, name: buildTaskThreadName(prompt) });
      } catch (err) {
        const msg = String((err as Error)?.message ?? err ?? '');
        if (!msg.includes('unknown variant') && !msg.includes('unknown method')) {
          throw err;
        }
      }
    }
  }

  processTiming('codex.thread.ready');
  emitProgress(options.onProgress, `Thread ready (${threadId}).`, 'starting', {
    kind: 'status',
    threadId,
  });

  let turnState: TurnCaptureState;
  let activeTurnId: string | null = null;
  const interrupt = () => {
    if (activeTurnId)
      void client.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {});
  };
  options.signal?.addEventListener('abort', interrupt, { once: true });
  try {
    turnState = await captureTurn(
      client,
      threadId,
      () =>
        client.request('turn/start', {
          threadId,
          input: [
            {
              type: 'text',
              text: prompt,
              text_elements: [],
            },
          ],
          model,
          effort: options.effort ?? null,
          outputSchema: options.outputSchema ?? null,
          // A turn's policy persists on the thread, so every turn sets its own.
          approvalPolicy: options.approvalPolicy ?? 'never',
          ...(reviewer ? { approvalsReviewer: reviewer } : {}),
          ...(sandboxPolicy ? { sandboxPolicy } : {}),
        }),
      {
        cwd,
        onProgress: options.onProgress,
        onHeartbeat: options.onHeartbeat,
        onApprovalRequest: options.onApprovalRequest,
        onTurnStarted: async turnId => {
          activeTurnId = turnId;
          if (options.signal?.aborted) interrupt();
          if (options.onControlReady) {
            controlServer = await startCodexControlServer(client, { threadId, turnId });
            options.onControlReady(controlServer.endpoint, threadId, turnId);
          }
        },
      },
    );
    processTiming('codex.result');
    options.onResult?.({
      status: turnState.finalTurn?.status === 'completed' ? 0 : 1,
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      error: turnState.error ?? (turnState.finalTurn?.error as TurnCaptureState['error']) ?? null,
    });
  } finally {
    options.signal?.removeEventListener('abort', interrupt);
    await (controlServer as Awaited<ReturnType<typeof startCodexControlServer>> | null)?.close();
  }

  return {
    status: turnState.finalTurn?.status === 'completed' ? 0 : 1,
    threadId,
    turnId: turnState.turnId,
    finalMessage: turnState.lastAgentMessage,
    reasoningSummary: turnState.reasoningSummary,
    turn: turnState.finalTurn,
    error: turnState.error ?? (turnState.finalTurn?.error as TurnCaptureState['error']) ?? null,
    stderr: cleanCodexStderr(client.stderr),
    fileChanges: turnState.fileChanges,
    tokens: collectTokenUsage(turnState),
    contextTokens: turnState.contextTokens,
    model: options.customModel?.alias ?? options.model ?? null,
    commandExecutions: turnState.commandExecutions,
  };
}
