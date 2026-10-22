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
  CodexAppServerClient,
  recycleAppServer,
  withAppServer,
  describeUnsupportedModel,
  errorText,
  isStaleAuthError,
} from './app-server';
import type { MailboxKey } from '../../mailbox';
import { requestCodexControl } from './control';
import { binaryAvailable } from '../../../utils/process';
import { engineEnvironment } from '../../connections';
import type {
  Availability,
  AuthStatus,
  CustomModelConfig,
  Effort,
  McpServerSpec,
  TurnResult,
} from '../../types';
import {
  type ProgressReporter,
  emitProgress,
  threadTurn,
  type AppServerClient,
  type ApprovalRequestHandler,
} from './turn';

export { buildCodexMcpOverrides, codexSandboxPolicy } from './turn';

/** Options accepted by runTurn. */
export interface RunTurnOptions {
  availabilityChecked?: boolean;
  prompt?: string;
  model?: string | null;
  /** A custom OpenAI-compatible model, served through the client's bridge. */
  customModel?: { alias: string; entry: CustomModelConfig };
  /** Per-thread codex config overrides. */
  configOverrides?: Record<string, unknown> | null;
  /** Extra MCP servers (env already resolved) plus the tools the turn may call. */
  mcpServers?: McpServerSpec[];
  nativeMcp?: boolean;
  effort?: Effort | null;
  sandbox?: string;
  /** A policy name, or `{ granular: … }` choosing which approvals Codex asks. */
  approvalPolicy?: string | { granular: Record<string, boolean> };
  networkAccess?: boolean;
  /** Extra writable roots; in a read-only sandbox they are the only writable paths. */
  writableRoots?: string[];
  /** Who answers approval requests; "user" (the client's handler) whenever a policy asks. */
  approvalsReviewer?: string | null;
  onApprovalRequest?: ApprovalRequestHandler;
  resumeThreadId?: string | null;
  /** The thread's developer instructions, sent on start and resume. */
  developerInstructions?: string;
  onProgress?: ProgressReporter;
  onHeartbeat?: () => void;
  onResult?: (result: TurnResult) => void;
  /** Interrupts the turn (`turn/interrupt`) once it has started. */
  signal?: AbortSignal;
  ephemeral?: boolean;
  outputSchema?: unknown;
  /** Publishes control for the exact client only after turn/start returns its active turnId. */
  onControlReady?: (endpoint: string, threadId: string, turnId: string) => void;
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
  const versionStatus = binaryAvailable('codex', ['--version'], { cwd, env: engineEnvironment() });
  if (!versionStatus.available) {
    return versionStatus;
  }
  const appServerStatus = binaryAvailable('codex', ['app-server', '--help'], {
    cwd,
    env: engineEnvironment(),
  });
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
    const probe = spawnSync('codex', ['login', 'status'], {
      encoding: 'utf8',
      env: engineEnvironment(),
    });
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
 * - approvalPolicy: "untrusted" | "on-request" | "never" | { granular }
 * - onApprovalRequest(method, params, state) -> {decision} (required unless approvalPolicy is "never")
 * - resumeThreadId: continue an existing thread (steering)
 * - onProgress: progress reporter
 */
export async function runTurn(
  cwd: string,
  options: RunTurnOptions = {},
  internals: { connect?: typeof CodexAppServerClient.connect } = {},
): Promise<TurnResult> {
  if (!options.availabilityChecked) {
    const availability = getCodexAvailability(cwd);
    if (!availability.available)
      throw new Error(`Codex CLI is not available: ${availability.detail}`);
  }

  const prompt = options.prompt?.trim();
  if (!prompt) {
    throw new Error('A prompt is required.');
  }

  // A stale login recycles the shared app-server before the client closes.
  const attempt = async (client: AppServerClient): Promise<TurnResult> => {
    client.setNoticeHandler?.((message: string) =>
      emitProgress(options.onProgress, message, 'starting', { kind: 'status' }),
    );
    try {
      const result = await threadTurn(client, cwd, prompt, options);
      if (isStaleAuthError(result.error?.message)) await recycleAppServer(client);
      return result;
    } catch (error) {
      if (isStaleAuthError(errorText(error))) await recycleAppServer(client);
      throw error;
    }
  };
  const run = () =>
    withAppServer(cwd, attempt, {
      ...internals,
      networkAccess: options.networkAccess,
      nativeMcp: options.nativeMcp,
    });

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
      !(result.fileChanges as unknown[] | undefined)?.length &&
      !(result.commandExecutions as unknown[]).length;
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

// Narrow test seam for deterministic broker-busy ownership regressions.
export const codexCoreTestInternals = { withAppServer };
