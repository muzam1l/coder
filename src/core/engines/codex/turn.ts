/** One codex turn as the app-server reports it: its items captured into progress lines, touched files, token usage and the final message. */
import fs from 'node:fs';

import { shortPath } from '../../../utils/fsx';
import type { ProgressUpdate, TokenUsage } from '../../types';
import type { CodexAppServerClient } from './app-server';

// Only log a token snapshot once the count has moved this far.
export const USAGE_LOG_STEP = 1000;

export const TASK_THREAD_PREFIX = 'Coder Task';

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
  error: { message?: string } | null;
  fileChanges: TurnItem[];
  commandExecutions: TurnItem[];
  // threadId -> latest cumulative token usage reported for that thread.
  tokenUsageByThread: Map<string, TokenUsage>;
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

export function collectTouchedFiles(fileChanges: TurnItem[]): string[] {
  const paths = new Set<string>();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
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

// Sum the per-thread cumulative usage into one turn total.
export function collectTokenUsage(state: TurnCaptureState): TokenUsage | null {
  if (state.tokenUsageByThread.size === 0) {
    return null;
  }
  const sum: TokenUsage = { input: 0, cachedInput: 0, output: 0, total: 0 };
  for (const usage of state.tokenUsageByThread.values()) {
    sum.input += usage.input;
    sum.cachedInput += usage.cachedInput;
    sum.output += usage.output;
    sum.total += usage.total;
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

function describeStartedItem(item: TurnItem, cwd?: string): ProgressLine | null {
  switch (item.type) {
    case 'commandExecution':
      return {
        message: unwrapShell(String(item.command ?? '').trim()),
        phase: 'running',
        extra: { kind: 'tool', tool: 'command' },
      };
    // File changes are reported once on completion. An "applying" or "applied"
    // pair says the same thing twice.
    case 'fileChange':
      return null;
    case 'mcpToolCall':
      return {
        message: `${item.server}/${item.tool}`,
        phase: 'investigating',
        extra: { kind: 'tool', tool: String(item.tool ?? '') },
      };
    case 'dynamicToolCall':
      return {
        message: String(item.tool ?? ''),
        phase: 'investigating',
        extra: { kind: 'tool', tool: String(item.tool ?? '') },
      };
    case 'webSearch':
      return {
        message: `search: ${String(item.query ?? '').trim()}`,
        phase: 'investigating',
        extra: { kind: 'tool', tool: 'search' },
      };
    default:
      return null;
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
          ...(exitCode === null ? { isError: item.status !== 'completed' } : { exitCode }),
        },
      };
    }
    case 'fileChange':
      return {
        message: describeCodexFileChanges(item, true, cwd) || '(details unavailable)',
        phase: 'editing',
        extra: { kind: 'tool', tool: 'edit' },
      };
    case 'mcpToolCall':
      return {
        message: `${item.server}/${item.tool} ${item.status}`,
        phase: 'investigating',
        extra: { kind: 'tool-result', isError: item.status !== 'completed' },
      };
    case 'dynamicToolCall':
      return {
        message: `${item.tool} ${item.status}`,
        phase: 'investigating',
        extra: { kind: 'tool-result', isError: item.status !== 'completed' },
      };
    default:
      return null;
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
    error: null,
    fileChanges: [],
    commandExecutions: [],
    tokenUsageByThread: new Map(),
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
      recordItem(state, message.params.item, 'started', message.params.threadId ?? null);
      emitLine(
        state.onProgress,
        withCallId(describeStartedItem(message.params.item, state.cwd), message.params.item),
      );
      break;
    case 'item/completed': {
      recordItem(state, message.params.item, 'completed', message.params.threadId ?? null);
      const item = message.params.item;
      if (item?.type === 'fileChange') {
        for (const change of item.changes ?? []) {
          if (change.path) state.reportedChanges.add(shortPath(state.cwd, change.path));
        }
      }
      emitLine(state.onProgress, withCallId(describeCompletedItem(item, state.cwd), item));
      break;
    }
    case 'thread/tokenUsage/updated': {
      // Cumulative per-thread usage; keep the latest snapshot per thread and
      // sum across threads (subagents included) when the turn completes.
      const usage = normalizeTokenUsage(
        message.params?.tokenUsage?.total ?? message.params?.tokenUsage,
      );
      const usageThreadId = extractThreadId(message);
      if (usage && usageThreadId) {
        state.tokenUsageByThread.set(usageThreadId, usage);
        const total = collectTokenUsage(state);
        if (total && (!state.loggedTokens || total.total - state.loggedTokens >= USAGE_LOG_STEP)) {
          state.loggedTokens = total.total;
          state.onProgress?.({ kind: 'usage', tokens: total });
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
