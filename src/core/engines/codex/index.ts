/**
 * Forked from the codex plugin's codex.mjs, trimmed to what Coder needs:
 * - thread start/resume + turn capture over the app-server
 * - configurable approvalPolicy/sandbox with an onApprovalRequest callback
 *   (the upstream hardcodes approvalPolicy "never")
 * - persistent (non-ephemeral) threads by default so runs can be steered later
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  BROKER_BUSY_RPC_CODE,
  BROKER_ENDPOINT_ENV,
  BROKER_RECYCLE_METHOD,
  CodexAppServerClient,
  type ProtocolError,
} from './app-server';
import { describeUnsupportedModel, errorText, isStaleAuthError } from './errors';
import type { MailboxKey } from '../../mailbox';
import { requestCodexControl, startCodexControlServer } from './control';
import { binaryAvailable } from '../../../utils/process';
import { isCodexSessionArchived, unarchiveCodexSession } from './sessions';
import type { Availability, AuthStatus, Effort, McpServerSpec, TurnResult } from '../../types';
import {
  type TurnCaptureState,
  type ProgressReporter,
  buildTaskThreadName,
  collectTouchedFiles,
  collectTokenUsage,
  emitProgress,
  captureTurn,
  type AppServerClient,
  type ApprovalRequestHandler,
} from './turn';

const SERVICE_NAME = 'coder_runtime';

/** Options accepted by runTurn. */
export interface RunTurnOptions {
  prompt?: string;
  model?: string | null;
  /** Codex model provider id (custom OpenAI-compatible endpoints). */
  modelProvider?: string | null;
  /** Per-thread codex config overrides (e.g. a model_providers entry). */
  configOverrides?: Record<string, unknown> | null;
  /** Extra MCP servers (env already resolved) plus the tools the turn may call. */
  mcpServers?: McpServerSpec[];
  effort?: Effort | null;
  sandbox?: string;
  approvalPolicy?: string;
  networkAccess?: boolean;
  /** Extra writable roots; in a read-only sandbox they are the only writable paths. */
  writableRoots?: string[];
  /** "auto_review" routes approvals to codex's native reviewer subagent. */
  approvalsReviewer?: string | null;
  onApprovalRequest?: ApprovalRequestHandler;
  resumeThreadId?: string | null;
  onProgress?: ProgressReporter;
  onHeartbeat?: () => void;
  onResult?: (result: TurnResult) => void;
  ephemeral?: boolean;
  outputSchema?: unknown;
  /** Publishes control for the exact client only after turn/start returns its active turnId. */
  onControlReady?: (endpoint: string, threadId: string, turnId: string) => void;
}

/** turn/start sandboxPolicy carrying extra writable roots, or null to keep the thread's sandbox. */
export function codexSandboxPolicy(
  sandbox: string | undefined,
  networkAccess: boolean | undefined,
  writableRoots: string[] = [],
): Record<string, unknown> | null {
  if (sandbox !== 'workspace-write' || !writableRoots.length) return null;
  return { type: 'workspaceWrite', writableRoots, networkAccess: networkAccess ?? false };
}

const READ_ONLY_PROFILE = 'coder_read_only';

/** Per-thread permission profile: read-only everywhere except the given roots, or null when none apply. */
export function codexReadOnlyProfile(
  sandbox: string | undefined,
  writableRoots: string[] = [],
): Record<string, unknown> | null {
  if ((sandbox ?? 'read-only') !== 'read-only' || !writableRoots.length) return null;
  return {
    default_permissions: READ_ONLY_PROFILE,
    [`permissions.${READ_ONLY_PROFILE}`]: {
      extends: ':read-only',
      filesystem: Object.fromEntries(writableRoots.map(root => [root, 'write'])),
    },
  };
}

/**
 * Per-thread config overrides attaching MCP servers, as dotted `mcp_servers.<name>`
 * keys (the same overlay shape custom model providers use). `enabled_tools` is
 * codex's per-server tool allowlist.
 */
export function buildCodexMcpOverrides(servers: McpServerSpec[] = []): Record<string, unknown> {
  const overrides: Record<string, unknown> = {};
  for (const server of servers) {
    overrides[`mcp_servers.${server.name}`] = {
      ...(server.url
        ? { url: server.url, ...(server.headers ? { http_headers: server.headers } : {}) }
        : {
            command: server.command,
            args: server.args ?? [],
            ...(server.env ? { env: server.env } : {}),
          }),
      ...(server.tools?.length ? { enabled_tools: server.tools } : {}),
    };
  }
  return overrides;
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

async function withAppServer<T>(
  cwd: string,
  fn: (client: AppServerClient) => Promise<T>,
  internals: { connect?: typeof CodexAppServerClient.connect; networkAccess?: boolean } = {},
): Promise<T> {
  const connect = internals.connect ?? CodexAppServerClient.connect;
  const clientOptions =
    internals.networkAccess === undefined ? {} : { networkAccess: internals.networkAccess };
  let client: AppServerClient | null = null;
  try {
    client = await connect(cwd, clientOptions);
    const result = await fn(client);
    await client.close();
    return result;
  } catch (error) {
    const err = error as ProtocolError & NodeJS.ErrnoException;
    const brokerRequested =
      client?.transport === 'broker' || Boolean(process.env[BROKER_ENDPOINT_ENV]);
    const shouldRetryDirect =
      (client?.transport === 'broker' && err?.rpcCode === BROKER_BUSY_RPC_CODE) ||
      (brokerRequested && (err?.code === 'ENOENT' || err?.code === 'ECONNREFUSED'));

    if (client) {
      await client.close().catch(() => {});
      client = null;
    }

    if (!shouldRetryDirect) {
      throw error;
    }

    const directClient = await connect(cwd, { ...clientOptions, disableBroker: true });
    try {
      return await fn(directClient);
    } finally {
      await directClient.close();
    }
  }
}

export function getCodexAvailability(cwd: string): Availability {
  const auth = process.env.CODEX_AUTH_JSON;
  if (auth) {
    const dir = path.join(os.homedir(), '.codex');
    const file = path.join(dir, 'auth.json');
    if (!fs.existsSync(file)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(file, auth, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  }
  const versionStatus = binaryAvailable('codex', ['--version'], { cwd });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const appServerStatus = binaryAvailable('codex', ['app-server', '--help'], { cwd });
  if (!appServerStatus.available) {
    return {
      available: false,
      detail: `${versionStatus.detail}; app-server runtime unavailable: ${appServerStatus.detail}`,
    };
  }
  return { available: true, detail: `${versionStatus.detail}; app-server runtime available` };
}

export async function getCodexAuthStatus(
  cwd: string,
): Promise<AuthStatus & { available: boolean }> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    return { available: false, loggedIn: false, detail: availability.detail };
  }

  let client: AppServerClient | null = null;
  try {
    client = await CodexAppServerClient.connect(cwd, { reuseExistingBroker: true });
    const accountResponse = await client.request('account/read', { refreshToken: false });
    const account = accountResponse?.account ?? null;
    if (account?.type === 'chatgpt') {
      return {
        available: true,
        loggedIn: true,
        detail: account.email
          ? `ChatGPT login active for ${account.email}`
          : 'ChatGPT login active',
      };
    }
    if (account?.type === 'apiKey') {
      return { available: true, loggedIn: true, detail: 'API key configured' };
    }
    if (accountResponse?.requiresOpenaiAuth === false) {
      return {
        available: true,
        loggedIn: true,
        detail: 'Active provider does not require OpenAI authentication',
      };
    }
    return { available: true, loggedIn: false, detail: 'Not authenticated. Run `codex login`.' };
  } catch (error) {
    // No live broker to ask (ENOENT on the socket) or transport failure: fall
    // back to the codex CLI's own answer instead of surfacing the error.
    const probe = spawnSync('codex', ['login', 'status'], { encoding: 'utf8' });
    const output = `${probe.stdout ?? ''}${probe.stderr ?? ''}`.trim();
    if (probe.status === 0) {
      return { available: true, loggedIn: true, detail: output || 'Logged in' };
    }
    return {
      available: true,
      loggedIn: false,
      detail: output || (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    await client?.close().catch(() => {});
  }
}

export async function interruptTurn(
  _cwd: string,
  {
    endpoint,
    threadId,
    turnId,
  }: { endpoint?: string | null; threadId?: string | null; turnId?: string | null },
): Promise<{ interrupted: boolean; detail: string }> {
  if (!threadId || !turnId) {
    return { interrupted: false, detail: 'missing threadId or turnId' };
  }
  const response = await requestCodexControl(endpoint, 'turn/interrupt', { threadId, turnId });
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
  {
    endpoint,
    threadId,
    turnId,
    text,
    command,
  }: {
    endpoint?: string | null;
    threadId?: string | null;
    turnId?: string | null;
    text: string;
    command?: MailboxKey;
  },
): Promise<{ steered: boolean; retryable: boolean; detail: string }> {
  if (!threadId) {
    return { steered: false, retryable: true, detail: 'missing active threadId' };
  }
  if (!turnId) {
    return { steered: false, retryable: true, detail: 'missing active turnId' };
  }
  const trimmed = text.trim();
  if (!trimmed) {
    return { steered: false, retryable: false, detail: 'empty follow-up' };
  }
  const response = await requestCodexControl(
    endpoint,
    'turn/steer',
    {
      threadId,
      input: [{ type: 'text', text: trimmed, text_elements: [] }],
      expectedTurnId: turnId,
    },
    3000,
    command,
  );
  if (!response.ok) {
    return { steered: false, retryable: response.retryable, detail: response.detail };
  }
  if (response.result?.turnId !== turnId) {
    return {
      steered: false,
      retryable: false,
      detail: `turn/steer returned unexpected turnId ${String(response.result?.turnId ?? '(missing)')}; expected ${turnId}`,
    };
  }
  return {
    steered: true,
    retryable: false,
    detail: `Steered follow-up into ${turnId} on ${threadId}.`,
  };
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
export async function runTurn(
  cwd: string,
  options: RunTurnOptions = {},
  internals: { connect?: typeof CodexAppServerClient.connect } = {},
): Promise<TurnResult> {
  const availability = getCodexAvailability(cwd);
  if (!availability.available) {
    throw new Error(`Codex CLI is not available: ${availability.detail}`);
  }

  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error('A prompt is required.');
  }

  const mcpOverrides = buildCodexMcpOverrides(options.mcpServers ?? []);
  const profile = codexReadOnlyProfile(options.sandbox, options.writableRoots);
  // A permission profile replaces the sandbox mode; codex rejects the two together.
  const sandbox = profile ? {} : { sandbox: options.sandbox ?? 'read-only' };
  const merged = { ...(options.configOverrides ?? {}), ...profile, ...mcpOverrides };
  const configOverrides = Object.keys(merged).length ? merged : null;
  const sandboxPolicy = codexSandboxPolicy(
    options.sandbox,
    options.networkAccess,
    options.writableRoots,
  );

  const turnOn = async (client: AppServerClient): Promise<TurnResult> => {
    let controlServer: Awaited<ReturnType<typeof startCodexControlServer>> | null = null;
    let threadId: string;

    if (options.resumeThreadId) {
      emitProgress(options.onProgress, `Resuming thread ${options.resumeThreadId}.`, 'starting', {
        kind: 'status',
      });
      // Sessions may have been auto-archived since the task stopped; resume
      // rejects archived sessions.
      if (isCodexSessionArchived(options.resumeThreadId)) {
        await unarchiveCodexSession(options.resumeThreadId);
      }
      const response = await client.request('thread/resume', {
        threadId: options.resumeThreadId,
        cwd,
        model: options.model ?? null,
        modelProvider: options.modelProvider ?? null,
        config: configOverrides,
        approvalPolicy: options.approvalPolicy ?? 'never',
        ...sandbox,
        // Only sent when set: older codex builds reject unknown enum-bearing fields.
        ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
      });
      threadId = response.thread.id;
    } else {
      emitProgress(options.onProgress, 'Starting Codex task thread.', 'starting', {
        kind: 'status',
      });
      const response = await client.request('thread/start', {
        cwd,
        model: options.model ?? null,
        modelProvider: options.modelProvider ?? null,
        config: configOverrides,
        approvalPolicy: options.approvalPolicy ?? 'never',
        ...sandbox,
        ...(options.approvalsReviewer ? { approvalsReviewer: options.approvalsReviewer } : {}),
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

    emitProgress(options.onProgress, `Thread ready (${threadId}).`, 'starting', {
      kind: 'status',
      threadId,
    });

    let turnState: TurnCaptureState;
    try {
      turnState = await captureTurn(
        client,
        threadId,
        () =>
          client.request('turn/start', {
            threadId,
            input: [{ type: 'text', text: prompt, text_elements: [] }],
            model: options.model ?? null,
            effort: options.effort ?? null,
            outputSchema: options.outputSchema ?? null,
            ...(sandboxPolicy ? { sandboxPolicy } : {}),
          }),
        {
          cwd,
          onProgress: options.onProgress,
          onHeartbeat: options.onHeartbeat,
          onApprovalRequest: options.onApprovalRequest,
          onTurnStarted: options.onControlReady
            ? async turnId => {
                controlServer = await startCodexControlServer(client, { threadId, turnId });
                options.onControlReady?.(controlServer.endpoint, threadId, turnId);
              }
            : undefined,
        },
      );
      options.onResult?.({
        status: turnState.finalTurn?.status === 'completed' ? 0 : 1,
        threadId,
        turnId: turnState.turnId,
        finalMessage: turnState.lastAgentMessage,
        error: turnState.error ?? null,
      });
    } finally {
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
      touchedFiles: collectTouchedFiles(turnState.fileChanges),
      tokens: collectTokenUsage(turnState),
      model: options.model ?? null,
      commandExecutions: turnState.commandExecutions,
    };
  };

  // A stale login recycles the shared app-server before the client closes.
  const attempt = async (client: AppServerClient): Promise<TurnResult> => {
    client.setNoticeHandler?.((message: string) =>
      emitProgress(options.onProgress, message, 'starting', { kind: 'status' }),
    );
    try {
      const result = await turnOn(client);
      if (isStaleAuthError(result.error?.message)) await recycleAppServer(client);
      return result;
    } catch (error) {
      if (isStaleAuthError(errorText(error))) await recycleAppServer(client);
      throw error;
    }
  };
  const run = () =>
    withAppServer(cwd, attempt, { ...internals, networkAccess: options.networkAccess });

  // Retried once, and only while the turn has done nothing that a rerun could repeat.
  let retried = false;
  const retry = () => {
    retried = true;
    emitProgress(
      options.onProgress,
      'Codex login changed; restarted the Codex app-server and retrying the turn once.',
      'starting',
      { kind: 'status' },
    );
    return run();
  };
  try {
    let result = await run().catch(error => {
      if (!isStaleAuthError(errorText(error))) throw error;
      return retry();
    });
    const didNothing =
      !result.touchedFiles?.length && !(result.commandExecutions as unknown[]).length;
    if (!retried && didNothing && isStaleAuthError(result.error?.message)) {
      result = await retry();
    }
    const hint = describeUnsupportedModel(result.error?.message, options.model);
    return hint ? { ...result, error: { ...result.error, message: hint } } : result;
  } catch (error) {
    const hint = describeUnsupportedModel(errorText(error), options.model);
    throw hint ? new Error(hint) : error;
  }
}

async function recycleAppServer(client: AppServerClient) {
  if (client.transport === 'broker') {
    await client.request(BROKER_RECYCLE_METHOD, {}).catch(() => {});
  }
}

// Narrow test seam for deterministic broker-busy ownership regressions.
export const codexCoreTestInternals = { withAppServer };
