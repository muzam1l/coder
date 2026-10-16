/**
 * Per-task approval sidecar: each task gets its own claude reviewer session,
 * stored in the task's task dir and archived/deleted with it. The session is
 * seeded once with the review rules and the task's goal, then each escalated
 * ask is a tiny resumed message (prompt-cached prefix), so cost stays flat
 * under many requests. It is not a live process, just a session id. Every call is a
 * short-lived `claude -p --resume`. Any failure or uncertainty falls back to
 * "escalate" (the existing pending-approval-file human path).
 */
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { CLAUDE_SIDECAR_FLAGS } from '../../config';
import { readJsonFile, withFileLock, writeJsonFileAtomic } from '../../../utils/fsx';
import { approvalActionPrompt, approvalReviewerPrompt } from '../../prompts';

export interface SidecarAsk {
  /** The task's goal, included in the seed turn. */
  taskGoal?: string | null;
  /** One-line description of the escalated action. */
  summary: string;
}

export interface SidecarVerdict {
  decision: 'accept' | 'decline' | 'escalate';
  reason: string;
}

interface SidecarState {
  sessionId: string | null;
  /** Consecutive declines (circuit breaker). */
  declineStreak: number;
}

const MODEL = 'sonnet';

// Claude CLI cold start alone can take ~45s; the API call itself is seconds.
const CALL_TIMEOUT_MS = 120_000;
const LOCK_STALE_MS = 90_000;
const LOCK_WAIT_MS = 120_000;

function statePath(taskDir: string): string {
  return path.join(taskDir, 'sidecar.json');
}

function loadState(taskDir: string): SidecarState {
  return readJsonFile<SidecarState>(statePath(taskDir)) ?? { sessionId: null, declineStreak: 0 };
}

/** Native CLI args for one reviewer call; shares the class-level sidecar policy. */
export function buildSidecarArgs(
  taskDir: string,
  sessionId: string,
  resume: boolean,
  prompt: string,
): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--model',
    MODEL,
    '--effort',
    'low',
    '--strict-mcp-config',
    '--no-chrome',
    '--mcp-config',
    '{"mcpServers":{}}',
    '--settings',
    '{"disableClaudeAiConnectors":true}',
    resume ? '--resume' : '--session-id',
    sessionId,
    ...CLAUDE_SIDECAR_FLAGS,
    // The task dir sits outside the workspace, and the seed prompt points the
    // reviewer at the progress log inside it; without this the read is denied.
    '--add-dir',
    taskDir,
  ];
}

/** One claude print-mode call; returns the final text or throws. */
function callClaude(
  cwd: string,
  taskDir: string,
  sessionId: string,
  resume: boolean,
  prompt: string,
): Promise<string> {
  const args = buildSidecarArgs(taskDir, sessionId, resume, prompt);
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('sidecar call timed out'));
    }, CALL_TIMEOUT_MS);
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`sidecar claude exited ${code}: ${stderr.trim().slice(0, 200)}`));
        return;
      }
      try {
        const event = JSON.parse(stdout);
        if (event.is_error) {
          reject(new Error(`sidecar turn errored: ${String(event.result ?? '').slice(0, 200)}`));
          return;
        }
        resolve(String(event.result ?? ''));
      } catch {
        reject(new Error('sidecar returned unparseable output'));
      }
    });
  });
}

function parseVerdict(text: string): SidecarVerdict | null {
  const match = text.match(/\{[^{}]*"decision"[^{}]*\}/);
  if (!match) {
    return null;
  }
  try {
    const parsed = JSON.parse(match[0]);
    if (
      parsed.decision === 'accept' ||
      parsed.decision === 'decline' ||
      parsed.decision === 'escalate'
    ) {
      return { decision: parsed.decision, reason: String(parsed.reason ?? '') };
    }
  } catch {
    // Fall through.
  }
  return null;
}

/**
 * Ask the task's sidecar session to decide an escalated permission request.
 * Never throws: any failure resolves to "escalate" so the human path still works.
 */
export async function decideSidecar(
  cwd: string,
  taskDir: string,
  ask: SidecarAsk,
): Promise<SidecarVerdict> {
  try {
    return await withFileLock(
      path.join(taskDir, 'sidecar.lock'),
      async (): Promise<SidecarVerdict> => {
        const state = loadState(taskDir);

        // Circuit breaker: repeated declines mean the task keeps pushing against
        // policy; hand the stream to a human instead of silently blocking it.
        if (state.declineStreak >= 3) {
          return { decision: 'escalate', reason: 'sidecar decline streak; needs human review' };
        }

        if (!state.sessionId) {
          const sessionId = randomUUID();
          await callClaude(
            cwd,
            taskDir,
            sessionId,
            false,
            approvalReviewerPrompt(ask.taskGoal, path.join(taskDir, 'log.jsonl')),
          );
          state.sessionId = sessionId;
          writeJsonFileAtomic(statePath(taskDir), state);
        }

        const text = await callClaude(
          cwd,
          taskDir,
          state.sessionId,
          true,
          approvalActionPrompt(ask.summary),
        );
        const verdict = parseVerdict(text);

        if (verdict?.decision === 'decline') {
          state.declineStreak += 1;
        } else if (verdict?.decision === 'accept') {
          state.declineStreak = 0;
        }
        writeJsonFileAtomic(statePath(taskDir), state);

        return verdict ?? { decision: 'escalate', reason: 'sidecar verdict unparseable' };
      },
      LOCK_STALE_MS,
      LOCK_WAIT_MS,
    );
  } catch (error) {
    return {
      decision: 'escalate',
      reason: `sidecar unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
