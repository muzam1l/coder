/**
 * Forked from the codex plugin's codex.mjs, trimmed to what Coder needs:
 * - thread start/resume + turn capture over the app-server
 * - configurable approvalPolicy/sandbox with an onApprovalRequest callback
 *   (the upstream hardcodes approvalPolicy "never")
 * - persistent (non-ephemeral) threads by default so runs can be steered later
 */
import { spawnSync } from "node:child_process";

import { BROKER_BUSY_RPC_CODE, BROKER_ENDPOINT_ENV, CodexAppServerClient } from "./app-server.js";
import { binaryAvailable } from "./process.js";

const SERVICE_NAME = "coder_runtime";
const TASK_THREAD_PREFIX = "Coder Task";

function cleanCodexStderr(stderr) {
  return stderr
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line && !line.startsWith("WARNING: proceeding, even though we could not update PATH:"))
    .join("\n");
}

function shorten(text, limit = 72) {
  const normalized = String(text ?? "").trim().replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit - 3)}...`;
}

function buildTaskThreadName(prompt) {
  const excerpt = shorten(prompt, 56);
  return excerpt ? `${TASK_THREAD_PREFIX}: ${excerpt}` : TASK_THREAD_PREFIX;
}

function extractThreadId(message) {
  return message?.params?.threadId ?? null;
}

function extractTurnId(message) {
  if (message?.params?.turnId) {
    return message.params.turnId;
  }
  if (message?.params?.turn?.id) {
    return message.params.turn.id;
  }
  return null;
}

function collectTouchedFiles(fileChanges) {
  const paths = new Set();
  for (const fileChange of fileChanges) {
    for (const change of fileChange.changes ?? []) {
      if (change.path) {
        paths.add(change.path);
      }
    }
  }
  return [...paths];
}

function normalizeReasoningText(text) {
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

function extractReasoningSections(value) {
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
    if (typeof value.text === "string") {
      return extractReasoningSections(value.text);
    }
    if ("summary" in value) {
      return extractReasoningSections(value.summary);
    }
    if ("content" in value) {
      return extractReasoningSections(value.content);
    }
    if ("parts" in value) {
      return extractReasoningSections(value.parts);
    }
  }
  return [];
}

function mergeReasoningSections(existingSections, nextSections) {
  const merged = [];
  for (const section of [...existingSections, ...nextSections]) {
    const normalized = normalizeReasoningText(section);
    if (!normalized || merged.includes(normalized)) {
      continue;
    }
    merged.push(normalized);
  }
  return merged;
}

function emitProgress(onProgress, message, phase = null, extra = {}) {
  if (!onProgress || !message) {
    return;
  }
  onProgress({ message, phase, ...extra });
}

function describeStartedItem(item) {
  switch (item.type) {
    case "commandExecution":
      return { message: `Running command: ${shorten(item.command, 96)}`, phase: "running" };
    case "fileChange":
      return { message: `Applying ${item.changes.length} file change(s).`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Calling ${item.server}/${item.tool}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Running tool: ${item.tool}.`, phase: "investigating" };
    case "webSearch":
      return { message: `Searching: ${shorten(item.query, 96)}`, phase: "investigating" };
    default:
      return null;
  }
}

function describeCompletedItem(item) {
  switch (item.type) {
    case "commandExecution":
      return {
        message: `Command ${item.status === "completed" ? "completed" : item.status}: ${shorten(item.command, 96)} (exit ${item.exitCode ?? "?"})`,
        phase: "running"
      };
    case "fileChange":
      return { message: `File changes ${item.status}.`, phase: "editing" };
    case "mcpToolCall":
      return { message: `Tool ${item.server}/${item.tool} ${item.status}.`, phase: "investigating" };
    case "dynamicToolCall":
      return { message: `Tool ${item.tool} ${item.status}.`, phase: "investigating" };
    default:
      return null;
  }
}

function createTurnCaptureState(threadId, options: any = {}) {
  let resolveCompletion;
  let rejectCompletion;
  const completion = new Promise<any>((resolve, reject) => {
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
    // itemId -> item, populated on item/started so approval callbacks can look
    // up the pending command/file change they refer to.
    itemIndex: new Map(),
    onProgress: options.onProgress ?? null
  };
}

function clearCompletionTimer(state) {
  if (state.completionTimer) {
    clearTimeout(state.completionTimer);
    state.completionTimer = null;
  }
}

function completeTurn(state, turn = null) {
  if (state.completed) {
    return;
  }
  clearCompletionTimer(state);
  state.completed = true;

  if (turn) {
    state.finalTurn = turn;
    if (!state.turnId) {
      state.turnId = turn.id;
    }
  } else if (!state.finalTurn) {
    state.finalTurn = { id: state.turnId ?? "inferred-turn", status: "completed" };
  }
  state.resolveCompletion(state);
}

function scheduleInferredCompletion(state) {
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

function belongsToTurn(state, message) {
  const messageThreadId = extractThreadId(message);
  if (!messageThreadId || !state.threadIds.has(messageThreadId)) {
    return false;
  }
  const trackedTurnId = state.threadTurnIds.get(messageThreadId) ?? null;
  const messageTurnId = extractTurnId(message);
  return trackedTurnId === null || messageTurnId === null || messageTurnId === trackedTurnId;
}

function recordItem(state, item, lifecycle, threadId = null) {
  if (item.id) {
    state.itemIndex.set(item.id, item);
  }

  if (item.type === "collabAgentToolCall") {
    if (!threadId || threadId === state.threadId) {
      if (lifecycle === "started" || item.status === "inProgress") {
        state.pendingCollaborations.add(item.id);
      } else if (lifecycle === "completed") {
        state.pendingCollaborations.delete(item.id);
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

function applyTurnNotification(state, message) {
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
        threadId: message.params.threadId ?? null,
        turnId: message.params.turn.id ?? null
      });
      break;
    case "item/started":
      recordItem(state, message.params.item, "started", message.params.threadId ?? null);
      {
        const update = describeStartedItem(message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "item/completed":
      recordItem(state, message.params.item, "completed", message.params.threadId ?? null);
      {
        const update = describeCompletedItem(message.params.item);
        emitProgress(state.onProgress, update?.message, update?.phase ?? null);
      }
      break;
    case "error":
      state.error = message.params.error;
      emitProgress(state.onProgress, `Codex error: ${message.params.error.message}`, "failed");
      break;
    case "turn/completed":
      if ((message.params.threadId ?? null) !== state.threadId) {
        state.activeSubagentTurns.delete(message.params.threadId);
        scheduleInferredCompletion(state);
        break;
      }
      emitProgress(state.onProgress, `Turn ${message.params.turn.status}.`, "finalizing");
      completeTurn(state, message.params.turn);
      break;
    default:
      break;
  }
}

async function captureTurn(client, threadId, startRequest, options: any = {}) {
  const state = createTurnCaptureState(threadId, options);
  const previousHandler = client.notificationHandler;

  client.setNotificationHandler((message) => {
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

  if (options.onApprovalRequest) {
    client.setServerRequestHandler((method, params) => options.onApprovalRequest(method, params, state));
  }

  try {
    const response = await startRequest();
    state.turnId = response.turn?.id ?? null;
    if (state.turnId) {
      state.threadTurnIds.set(state.threadId, state.turnId);
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

async function withAppServer(cwd, fn) {
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const brokerRequested = client?.transport === "broker" || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === "broker" && error?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (error?.code === "ENOENT" || error?.code === "ECONNREFUSED"));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await CodexAppServerClient.connect(cwd, { disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

export function getCodexAvailability(cwd) {
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

export async function getCodexAuthStatus(cwd) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }

  let client = null;
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

export async function interruptTurn(cwd, { threadId, turnId }) {
  if (!threadId || !turnId) {
    return { interrupted: false, detail: "missing threadId or turnId" };
  }
  let client = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    await client.request("turn/interrupt", { threadId, turnId });
    return { interrupted: true, detail: `Interrupted ${turnId} on ${threadId}.` };
  } catch (error) {
    return { interrupted: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await client?.close().catch(() => {});
  }
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
export async function runTurn(cwd, options: any = {}) {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Codex CLI is not available: ${availability.detail}`);
  }

  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error("A prompt is required.");
  }

  return withAppServer(cwd, async (client) => {
    let threadId;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, "starting");
      const response = await client.request("thread/resume", {
        threadId: options.resumeThreadId,
        cwd,
        model: options.model ?? null,
        approvalPolicy: options.approvalPolicy ?? "never",
        sandbox: options.sandbox ?? "read-only"
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, "Starting Codex task thread.", "starting");
      const response = await client.request("thread/start", {
        cwd,
        model: options.model ?? null,
        approvalPolicy: options.approvalPolicy ?? "never",
        sandbox: options.sandbox ?? "read-only",
        serviceName: SERVICE_NAME,
        // Persist by default so status/steer/stop can target the thread later.
        ephemeral: options.ephemeral ?? false
      });
      threadId = response.thread.id;
      try {
        await client.request("thread/name/set", { threadId, name: buildTaskThreadName(prompt) });
      } catch (err) {
        const msg = String(err?.message ?? err ?? "");
        if (!msg.includes("unknown variant") && !msg.includes("unknown method")) {
          throw err;
        }
      }
    }

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, "starting", { threadId });

    const turnState = await captureTurn(
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
      { onProgress: options.onProgress, onApprovalRequest: options.onApprovalRequest }
    );

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
      commandExecutions: turnState.commandExecutions
    };
  });
}

export { TASK_THREAD_PREFIX };
