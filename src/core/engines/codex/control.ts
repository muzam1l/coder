import { serveControl, requestControl } from '../control';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { mailboxId, type MailboxKey } from '../../mailbox';
import type { ProtocolError } from './app-server';

interface CodexControlClient {
  request(method: string, params?: unknown): Promise<any>;
}

interface CodexControlResult {
  ok: boolean;
  retryable: boolean;
  result?: any;
  detail: string;
}

interface CodexControlError extends Error {
  retryable: boolean;
  rpcCode?: number;
}

function isActiveTurnCompletionRace(error: unknown): boolean {
  const detail = error instanceof Error ? error.message : String(error);
  return /no active turn|active turn.*(?:ended|completed)|turn.*(?:already )?(?:ended|completed)|turn.*not active/i.test(
    detail,
  );
}

function controlError(message: string, retryable: boolean, rpcCode?: number): CodexControlError {
  return Object.assign(new Error(message), {
    retryable,
    ...(rpcCode === undefined ? {} : { rpcCode }),
  });
}

function validateOwnerRequest(
  request: any,
  id: string,
  threadId: string,
  turnId: string,
): {
  method: 'turn/steer' | 'turn/interrupt';
  params: Record<string, unknown>;
} {
  if (
    !request ||
    request.id !== id ||
    (request.method !== 'turn/steer' && request.method !== 'turn/interrupt')
  ) {
    throw controlError('Invalid Codex control request.', false);
  }
  const params = request.params;
  if (!params || typeof params !== 'object' || params.threadId !== threadId) {
    throw controlError('Codex control request does not match its owning thread.', false);
  }
  if (request.method === 'turn/interrupt') {
    if (params.turnId !== turnId) {
      throw controlError(
        'Codex turn/interrupt request does not match its owning active turn.',
        false,
      );
    }
    return { method: request.method, params };
  }
  if (params.expectedTurnId !== turnId) {
    throw controlError('Codex turn/steer request does not match its owning active turn.', false);
  }
  const input = params.input;
  if (
    !Array.isArray(input) ||
    input.length !== 1 ||
    input[0]?.type !== 'text' ||
    typeof input[0]?.text !== 'string' ||
    !input[0].text.trim()
  ) {
    throw controlError('Invalid Codex turn/steer input schema.', false);
  }
  return { method: request.method, params };
}

/**
 * Start a detached-process-safe control mailbox bound to the exact app-server
 * client that owns one active turn. The caller publishes the returned endpoint
 * only after turn/start has returned its active turn id.
 */
export async function startCodexControlServer(
  client: CodexControlClient,
  { threadId, turnId }: { threadId: string; turnId: string },
) {
  return serveControl('coder-codex-control-', async (request, closing) => {
    if (closing) throw controlError('Codex owner endpoint is shutting down.', true);
    const validated = validateOwnerRequest(request, request.id, threadId, turnId);
    try {
      const result = await client.request(validated.method, validated.params);
      // An interrupt leaves the turn's commands running as background terminals.
      if (validated.method === 'turn/interrupt')
        await client.request('thread/backgroundTerminals/clean', { threadId });

      return result;
    } catch (error) {
      throw controlError(
        error instanceof Error ? error.message : String(error),
        isActiveTurnCompletionRace(error),
        (error as ProtocolError).rpcCode,
      );
    }
  });
}

export function removeCodexControlEndpoint(endpoint: string | null | undefined) {
  if (endpoint?.startsWith('file:') && endpoint.length > 'file:'.length) {
    const directory = path.resolve(endpoint.slice('file:'.length));
    const tempRoot = path.resolve(os.tmpdir());
    if (
      path.dirname(directory) === tempRoot &&
      path.basename(directory).startsWith('coder-codex-control-')
    ) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  }
}

/** Send one control request to a running Codex worker's owning app-server. */
export async function requestCodexControl(
  endpoint: string | null | undefined,
  method: 'turn/steer' | 'turn/interrupt',
  params: Record<string, unknown>,
  timeoutMs = 3_000,
  command?: MailboxKey,
): Promise<CodexControlResult> {
  return requestControl(
    endpoint,
    { id: mailboxId(command), method, params, command },
    timeoutMs,
    'Codex control',
  );
}
