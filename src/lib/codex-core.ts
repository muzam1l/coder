/**
 * Forked from the codex plugin's codex.mjs, trimmed to what Coder needs:
 * - thread start/resume + turn capture over the app-server
 * - configurable approvalPolicy/sandbox with an onApprovalRequest callback
 *   (the upstream hardcodes approvalPolicy "never")
 * - persistent (non-ephemeral) threads by default so runs can be steered later
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";

import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.js";
import type { ProtocolError } from "./app-server.js";
import { requestCodexControl, startCodexControlServer } from "./codex-control.js";
import { shortPath } from "./fsx.js";
import { binaryAvailable } from "./process.js";
import { isCodexSessionArchived, unarchiveCodexSession } from "./codex-sessions.js";
import type { Availability, AuthStatus, Effort, ProgressUpdate, TokenUsage, TurnResult } from "./types.js";

const SERVICE_NAME = "coder_runtime";
// Only log a token snapshot once the count has moved this far.
const USAGE_LOG_STEP = 1000;
const TASK_THREAD_PREFIX = "Coder Task";

/** The connected app-server client (spawned or broker transport). */
type AppServerClient = Awaited<ReturnType<typeof CodexAppServerClient.connect>>;

/** A progress reporter passed by callers to observe a turn. */
type ProgressReporter = (update: ProgressUpdate) => void;

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

type Lifecycle = "started" | "completed";

/**
 * An approval callback: answers a server-initiated request during a turn. The
 * third arg is the live turn-capture state, passed opaquely to external handlers
 * (e.g. the approvals module), so it is typed loosely at this boundary.
 */
type ApprovalRequestHandler = (method: string, params: any, state?: any) => unknown;

/** Mutable state accumulated while capturing a single turn. */
interface TurnCaptureState {
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

/** Options accepted by runTurn. */
export interface RunTurnOptions {
  prompt?: string;
  model?: string | null;
  /** Codex model provider id (custom OpenAI-compatible endpoints). */
  modelProvider?: string | null;
  /** Per-thread codex config overrides (e.g. a model_providers entry). */
  configOverrides?: Record<string, unknown> | null;
  effort?: Effort | null;
  sandbox?: string;
  approvalPolicy?: string;
  /** "auto_review" routes approvals to codex's native reviewer subagent. */
  approvalsReviewer?: string | null;
  onApprovalRequest?: ApprovalRequestHandler;
  resumeThreadId?: string | null;
  onProgress?: ProgressReporter;
  onHeartbeat?: () => void;
  ephemeral?: boolean;
  outputSchema?: unknown;
  /** Publishes control for the exact client only after turn/start returns its active turnId. */
  onControlReady?: (endpoint: string, threadId: string, turnId: string) => void;
}

function cleanCodexStderr(stderr: string) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

function shorten(text: unknown, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskThreadName(prompt: string) {
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

function collectTouchedFiles(fileChanges: TurnItem[]): string[] {
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
    const deleting = kind === "delete";
    const start = Number(deleting ? match[1] : match[3]);
    const count = Number((deleting ? match[2] : match[4]) ?? 1);
    if (!Number.isFinite(start) || !Number.isFinite(count)) continue;
    ranges.push(count <= 1 ? `L${start}` : `L${start}-L${start + count - 1}`);
  }
  return ranges;
}

function currentFileRange(file: string): string[] {
  try {
    const content = fs.readFileSync(file, "utf8");
    const lines = content ? content.split(/\r\n|\r|\n/).length - (content.endsWith("\n") ? 1 : 0) : 0;
    return lines > 0 ? [lines === 1 ? "L1" : `L1-L${lines}`] : [];
  } catch {
    return [];
  }
}

function describeFileChange(
  change: NonNullable<TurnItem["changes"]>[number],
  readAddedFile: boolean,
  cwd?: string,
): string {
  const kind = typeof change.kind === "string" ? change.kind : change.kind?.type ?? "change";
  const file = change.path || "(unknown path)";
  const diffRanges = changedLineRanges(change.diff ?? "", kind);
  const ranges = diffRanges.length || kind !== "add" || !readAddedFile ? diffRanges : currentFileRange(file);
  const moved = typeof change.kind === "object" && change.kind?.move_path
    ? ` -> ${cwd ? shortPath(cwd, change.kind.move_path) : change.kind.move_path}`
    : "";
  const shown = cwd ? shortPath(cwd, file) : file;
  return `${kind} ${shown}${moved}${ranges.length ? ` ${ranges.join(", ")}` : ""}`;
}

export function describeCodexFileChanges(item: TurnItem, readAddedFiles = false, cwd?: string): string {
  return (item.changes ?? []).map(change => describeFileChange(change, readAddedFiles, cwd)).join("; ");
}

function diffPath(header: string): string {
  const value = header.trim().split("\t")[0] ?? "";
  return value === "/dev/null" ? "" : value.replace(/^[ab]\//, "");
}

/** Summarize an aggregate unified diff as path plus destination line spans. */
export function describeCodexTurnDiff(diff: string, cwd?: string): string {
  const files = new Map<string, string[]>();
  let oldPath = "";
  let newPath = "";
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith("--- ")) {
      oldPath = diffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
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
    const file = (deleting ? oldPath : newPath) || newPath || oldPath || "(unknown path)";
    const start = deleting ? oldStart : newStart;
    const count = deleting ? oldCount : newCount;
    const range = count <= 1 ? `L${start}` : `L${start}-L${start + count - 1}`;
    const ranges = files.get(file) ?? [];
    ranges.push(range);
    files.set(file, ranges);
  }
  return [...files]
    .map(([file, ranges]) => `${cwd ? shortPath(cwd, file) : file} ${ranges.join(", ")}`)
    .join("; ");
}

// Normalize an app-server TokenUsage ({inputTokens, cachedInputTokens,
// outputTokens, reasoningOutputTokens, totalTokens}) to the shared shape.
function normalizeTokenUsage(usage: any): TokenUsage | null {
  if (!usage || typeof usage !== "object") {
    return null;
  }
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const input = num(usage.inputTokens);
  const cachedInput = num(usage.cachedInputTokens);
  const output = num(usage.outputTokens);
  return { input, cachedInput, output, total: num(usage.totalTokens) || input + cachedInput + output };
}

// Sum the per-thread cumulative usage into one turn total.
function collectTokenUsage(state: TurnCaptureState): TokenUsage | null {
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
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value: unknown): string[] {
  if (!value) {
    return [];
  }
  if (typeof value === "string") {
    const normalized = normalizeReasoningText(value);
    return normalized ? [normalized] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractReasoningSections(entry));
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.text === "string") {
      return extractReasoningSections(record.text);
    }
    if ("summary" in record) {
      return extractReasoningSections(record.summary);
    }
    if ("content" in record) {
      return extractReasoningSections(record.content);
    }
    if ("parts" in record) {
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

function emitProgress(
  onProgress: ProgressReporter | null | undefined,
  message: string | null | undefined,
  phase: string | null = null,
  extra: Record<string, unknown> = {}
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
  return command.replace(/^\/(?:usr\/)?bin\/\w*sh\s+-l?c\s+/, "");
}

// Messages are logged raw (full command, full output) like the claude core;
// the text views trim them for display and --json keeps everything.
function describeStartedItem(item: TurnItem, cwd?: string): ProgressLine | null {
  switch (item.type) {
    case "commandExecution":
      return {
        message: unwrapShell(String(item.command ?? "").trim()),
        phase: "running",
        extra: { kind: "tool", tool: "command" }
      };
    // File changes are reported once, on completion — an "applying"/"applied"
    // pair says the same thing twice.
    case "fileChange":
      return null;
    case "mcpToolCall":
      return { message: `${item.server}/${item.tool}`, phase: "investigating", extra: { kind: "tool", tool: String(item.tool ?? "") } };
    case "dynamicToolCall":
      return { message: String(item.tool ?? ""), phase: "investigating", extra: { kind: "tool", tool: String(item.tool ?? "") } };
    case "webSearch":
      return { message: `search: ${String(item.query ?? "").trim()}`, phase: "investigating", extra: { kind: "tool", tool: "search" } };
    default:
      return null;
  }
}

function describeCompletedItem(item: TurnItem, cwd?: string): ProgressLine | null {
  switch (item.type) {
    case "agentMessage": {
      const text = String(item.text ?? "").trim();
      return text ? { message: text, phase: null, extra: { kind: "assistant" } } : null;
    }
    case "reasoning": {
      // Logged whole; the views preview it and open it up on --trim.
      const summary = extractReasoningSections(item.summary).join("\n");
      return summary ? { message: summary, phase: null, extra: { kind: "reasoning" } } : null;
    }
    case "commandExecution": {
      // The command is already on the line above — repeat it here and it just
      // crowds out the output that this entry exists to carry.
      const exitCode = typeof item.exitCode === "number" ? item.exitCode : null;
      return {
        message: String(item.aggregatedOutput ?? "").trim(),
        phase: "running",
        extra: {
          kind: "tool-result",
          tool: "command",
          command: String(item.command ?? "").trim(),
          ...(exitCode === null ? { isError: item.status !== "completed" } : { exitCode })
        }
      };
    }
    case "fileChange":
      return {
        message: describeCodexFileChanges(item, true, cwd) || "(details unavailable)",
        phase: "editing",
        extra: { kind: "tool", tool: "edit" }
      };
    case "mcpToolCall":
      return {
        message: `${item.server}/${item.tool} ${item.status}`,
        phase: "investigating",
        extra: { kind: "tool-result", isError: item.status !== "completed" }
      };
    case "dynamicToolCall":
      return {
        message: `${item.tool} ${item.status}`,
        phase: "investigating",
        extra: { kind: "tool-result", isError: item.status !== "completed" }
      };
    default:
      return null;
  }
}

function createTurnCaptureState(threadId: string, options: CaptureTurnOptions = {}): TurnCaptureState {
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
    lastAgentMessage: "",
    reasoningSummary: [],
    error: null,
    fileChanges: [],
    commandExecutions: [],
    tokenUsageByThread: new Map(),
    lastDiffSummary: "",
    loggedTokens: 0,
    reportedChanges: new Set(),
    cwd: options.cwd ?? "",
    // itemId -> item, populated on item/started so approval callbacks can look
    // up the pending command/file change they refer to.
    itemIndex: new Map(),
    onProgress: options.onProgress ?? null,
    onHeartbeat: options.onHeartbeat ?? null
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
    state.finalTurn = { id: state.turnId ?? "inferred-turn", status: "completed" };
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

function recordItem(state: TurnCaptureState, item: TurnItem, lifecycle: Lifecycle, threadId: string | null = null) {
  if (item.id) {
    state.itemIndex.set(item.id, item);
  }

  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id as string);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id as string);
        scheduleInferredCompletion(state);
      }
    }
    for (const receiverThreadId of item.receiverThreadIds ?? []) {
      state.threadIds.add(receiverThreadId);
    }
  }

  if (item.type === "agentMessage") {
    if (item.text && (!threadId || threadId === state.threadId)) {
      state.lastAgentMessage = item.text;
      if (lifecycle === "completed" && item.phase === "final_answer") {
        state.finalAnswerSeen = true;
        scheduleInferredCompletion(state);
      }
    }
    return;
  }

  if (item.type === "reasoning" && lifecycle === "completed") {
    state.reasoningSummary = mergeReasoningSections(state.reasoningSummary, extractReasoningSections(item.summary));
    return;
  }

  if (item.type === "fileChange" && lifecycle === "completed") {
    state.fileChanges.push(item);
    return;
  }

  if (item.type === "commandExecution" && lifecycle === "completed") {
    state.commandExecutions.push(item);
  }
}

function applyTurnNotification(state: TurnCaptureState, message: AppServerMessage) {
  // Any notification for this turn is a sign of life — including ones the
  // switch below ignores, like command output deltas during a long command.
  state.onHeartbeat?.();
  switch (message.method) {
    case "thread/started":
      state.threadIds.add(message.params.thread.id);
      break;
    case "turn/started":
      state.threadIds.add(message.params.threadId);
      state.threadTurnIds.set(message.params.threadId, message.params.turn.id);
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.add(message.params.threadId);
      }
      emitProgress(state.onProgress, `Turn started (${message.params.turn.id}).`, "starting", {
        kind: "status",
        threadId: message.params.threadId ?? null,
        turnId: message.params.turn.id ?? null
      });
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      emitLine(state.onProgress, describeStartedItem(message.params.item, state.cwd));
      break;
    case "item/completed": {
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      const item = message.params.item;
      if (item?.type === "fileChange") {
        for (const change of item.changes ?? []) {
          if (change.path) state.reportedChanges.add(shortPath(state.cwd, change.path));
        }
      }
      emitLine(state.onProgress, describeCompletedItem(item, state.cwd));
      break;
    }
    case "thread/tokenUsage/updated": {
      // Cumulative per-thread usage; keep the latest snapshot per thread and
      // sum across threads (subagents included) when the turn completes.
      const usage = normalizeTokenUsage(message.params?.tokenUsage?.total ?? message.params?.tokenUsage);
      const usageThreadId = extractThreadId(message);
      if (usage && usageThreadId) {
        state.tokenUsageByThread.set(usageThreadId, usage);
        const total = collectTokenUsage(state);
        if (total && (!state.loggedTokens || total.total - state.loggedTokens >= USAGE_LOG_STEP)) {
          state.loggedTokens = total.total;
          state.onProgress?.({ kind: "usage", tokens: total });
        }
      }
      break;
    }
    case "turn/diff/updated": {
      // Every file the turn touched via a fileChange item already has its own
      // line; only report what the aggregate diff adds (an apply_patch run as
      // a plain command, say).
      const summary = describeCodexTurnDiff(String(message.params?.diff ?? ""), state.cwd)
        .split("; ")
        .filter(part => !state.reportedChanges.has(part.split(" ")[0] ?? ""))
        .join("; ");
      if (summary && summary !== state.lastDiffSummary) {
        state.lastDiffSummary = summary;
        emitProgress(state.onProgress, `changed: ${summary}`, "editing", { kind: "status" });
      }
      break;
    }
    case "item/autoApprovalReview/completed": {
      const review = message.params?.review ?? {};
      const action = message.params?.action ?? {};
      const target = action.command ?? action.type ?? "";
      emitProgress(
        state.onProgress,
        `auto-review ${review.status}${review.riskLevel ? ` (${review.riskLevel} risk)` : ""}: ${shorten(target)}${review.rationale ? ` — ${shorten(review.rationale, 120)}` : ""}`,
        null
      );
      break;
    }
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed", { kind: "error" });
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(state.onProgress, `Turn ${message.params.turn.status}.`, "finalizing", { kind: "status" });
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(
  client: AppServerClient,
  threadId: string,
  startRequest: () => Promise<any>,
  options: CaptureTurnOptions = {}
): Promise<TurnCaptureState> {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message: AppServerMessage) => {
    if (!state.turnId) {
      state.bufferedNotifications.push(message);
      return;
    }
    if (message.method === "thread/started") {
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
    client.setServerRequestHandler((method: string, params: any) => onApprovalRequest(method, params, state));
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

    if (response.turn?.status && response.turn.status !== "inProgress") {
      completeTurn(state, response.turn);
    }

    return await state.completion;
  } finally {
    clearCompletionTimer(state);
    client.setNotificationHandler(previousHandler ?? null);
    client.setServerRequestHandler(null);
  }
}

async function withAppServer<T>(
  cwd: string,
  fn: (client: AppServerClient) => Promise<T>,
  internals: { connect?: typeof CodexAppServerClient.connect } = {},
): Promise<T> {
  const connect = internals.connect ?? CodexAppServerClient.connect;
  let client: AppServerClient | null = null;
  try {
    client = await connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const err = error as ProtocolError & NodeJS.ErrnoException;
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && err?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (err?.code === "ENOENT" || err?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

export function getCodexAvailability(cwd: string): Availability {
  const versionStatus = binaryAvailable("codex", ["--version"], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const appServerStatus = binaryAvailable("codex", ["app-server", "--help"], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; app-server runtime unavailable: ${appServerStatus.detail}`
    };
  }
  return { available: true, detail: `${versionStatus.detail}; app-server runtime available` };
}

export async function getCodexAuthStatus(cwd: string): Promise<AuthStatus & { available: boolean }> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }

  let client: AppServerClient | null = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    const accountResponse = await client.request("account/read", { refreshToken: false });
    const account = accountResponse?.account ?? null;
    if (account?.type === "chatgpt") {
      return {
        available: true,
        loggedIn: true,
        detail: account.email ? `ChatGPT login active for ${account.email}` : "ChatGPT login active"
      };
    }
    if (account?.type === "apiKey") {
      return { available: true, loggedIn: true, detail: "API key configured" };
    }
    if (accountResponse?.requiresOpenaiAuth === false) {
      return { available: true, loggedIn: true, detail: "Active provider does not require OpenAI authentication" };
    }
    return { available: true, loggedIn: false, detail: "Not authenticated. Run `codex login`." };
  } catch (error) {
    // No live broker to ask (ENOENT on the socket) or transport failure: fall
    // back to the codex CLI's own answer instead of surfacing the error.
    const probe = spawnSync("codex", ["login", "status"], { encoding: "utf8" });
    const output = `${probe.stdout ?? ""}${probe.stderr ?? ""}`.trim();
    if (probe.status === 0) {
      return { available: true, loggedIn: true, detail: output || "Logged in" };
    }
    return {
      available: true,
      loggedIn: false,
      detail: output || (error instanceof Error ? error.message : String(error))
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function interruptTurn(
  _cwd: string,
  { endpoint, threadId, turnId }: { endpoint?: string | null; threadId?: string | null; turnId?: string | null }
): Promise<{ interrupted: boolean; detail: string }> {
  if (!threadId || !turnId) {
    return { interrupted: false, detail: "missing threadId or turnId" };
  }
  const response = await requestCodexControl(endpoint, "turn/interrupt", { threadId, turnId });
  return response.ok
    ? { interrupted: true, detail: `Interrupted ${turnId} on ${threadId}.` }
    : { interrupted: false, detail: response.detail };
}

/**
 * Inject a follow-up into a thread's live turn ("steering"). The app-server's
 * `turn/steer` merges the input into the active turn instead of starting a new
 * one; the worker that owns the turn keeps capturing it and completes when the
 * (now-extended) turn finishes.
 *
 * Reaches the running turn only through its worker-owned endpoint, which is
 * bound to the exact app-server client executing the turn. This remains true
 * when broker-busy workers fall back to private app-server processes.
 */
export async function steerTurn(
  _cwd: string,
  { endpoint, threadId, turnId, text }: {
    endpoint?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    text: string;
  },
): Promise<{ steered: boolean; retryable: boolean; detail: string }> {
  if (!threadId) {
    return { steered: false, retryable: true, detail: "missing active threadId" };
  }
  if (!turnId) {
    return { steered: false, retryable: true, detail: "missing active turnId" };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { steered: false, retryable: false, detail: "empty follow-up" };
  }
  const response = await requestCodexControl(endpoint, "turn/steer", {
    threadId,
    input: [{ type: "text", text: trimmed, text_elements: [] }],
    expectedTurnId: turnId,
  });
  if (!response.ok) {
    return { steered: false, retryable: response.retryable, detail: response.detail };
  }
  if (response.result?.turnId !== turnId) {
    return {
      steered: false,
      retryable: false,
      detail: `turn/steer returned unexpected turnId ${String(response.result?.turnId ?? "(missing)")}; expected ${turnId}`,
    };
  }
  return { steered: true, retryable: false, detail: `Steered follow-up into ${turnId} on ${threadId}.` };
}

/**
 * Run one Codex turn. Options:
 * - prompt (required), model, effort
 * - sandbox: "read-only" | "workspace-write" | "danger-full-access"
 * - approvalPolicy: "untrusted" | "on-request" | "never"
 * - onApprovalRequest(method, params, state) -> {decision} (required unless approvalPolicy is "never")
 * - resumeThreadId: continue an existing thread (steering)
 * - onProgress: progress reporter
 */
export async function runTurn(cwd: string, options: RunTurnOptions = {}): Promise<TurnResult> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Codex CLI is not available: ${availability.detail}`);
  }

  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error("A prompt is required.");
  }

  return withAppServer(cwd, async (client): Promise<TurnResult> => {
    let controlServer: Awaited<ReturnType<typeof startCodexControlServer>> | null = null;
    let threadId: string;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting", { kind: "status" });
      // Sessions may have been auto-archived since the task stopped; resume
      // rejects archived sessions.
      if (isCodexSessionArchived(options.resumeThreadId)) {
        await unarchiveCodexSession(options.resumeThreadId);
      }
      const response = await client.request("thread/resume", {
        threadId: options.resumeThreadId,
        cwd,
        model: options.model ?? null,
        modelProvider: options.modelProvider ?? null,
        config: options.configOverrides ?? null,
        approvalPolicy: options.approvalPolicy ?? "never",
        sandbox: options.sandbox ?? "read-only",
        // Only sent when set: older codex builds reject unknown enum-bearing fields.
        ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {})
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting", { kind: "status" });
      const response = await client.request("thread/start", {
        cwd,
        model: options.model ?? null,
        modelProvider: options.modelProvider ?? null,
        config: options.configOverrides ?? null,
        approvalPolicy: options.approvalPolicy ?? "never",
        sandbox: options.sandbox ?? "read-only",
        ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
        serviceName: SERVICE_NAME,
        // Persist by default so status/steer/stop can target the thread later.
        ephemeral: options.ephemeral ?? false
      });
      threadId = response.thread.id;
      // Ephemeral threads reject metadata updates; they are never listed anyway.
      if (!(options.ephemeral ?? false)) {
        try {
          await client.request("thread/name/set", { threadId, name: buildTaskThreadName(prompt) });
        } catch (err) {
          const msg = String((err as Error)?.message ?? err ?? "");
          if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
            throw err;
          }
        }
      }
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", { kind: "status", threadId });

    let turnState: TurnCaptureState;
    try {
      turnState = await captureTurn(
        client,
        threadId,
        () =>
          client.request("turn/start", {
            threadId,
            input: [{ type: "text", text: prompt, text_elements: [] }],
            model: options.model ?? null,
            effort: options.effort ?? null,
            outputSchema: options.outputSchema ?? null
          }),
        {
          cwd,
          onProgress: options.onProgress,
          onHeartbeat: options.onHeartbeat,
          onApprovalRequest: options.onApprovalRequest,
          onTurnStarted: options.onControlReady
            ? async (turnId) => {
                controlServer = await startCodexControlServer(client, { threadId, turnId });
                options.onControlReady?.(controlServer.endpoint, threadId, turnId);
              }
            : undefined,
        }
      );
    } finally {
      await (controlServer as Awaited<ReturnType<typeof startCodexControlServer>> | null)?.close();
    }

    return {
      status: turnState.finalTurn?.status === "completed" ? 0 : 1,
      threadId,
      turnId: turnState.turnId,
      finalMessage: turnState.lastAgentMessage,
      reasoningSummary: turnState.reasoningSummary,
      turn: turnState.finalTurn,
      error: turnState.error,
      stderr: cleanCodexStderr(client.stderr),
      fileChanges: turnState.fileChanges,
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      tokens: collectTokenUsage(turnState),
      model: options.model ?? null,
      commandExecutions: turnState.commandExecutions
    };
  });
}

export { TASK_THREAD_PREFIX };

// Narrow test seam for deterministic broker-busy ownership regressions.
export const codexCoreTestInternals = { withAppServer };
