/**
 * Per-task approval sidecar: each task gets its own claude reviewer session,
 * stored in the task's task dir and archived/deleted with it. The session is
 * seeded once with the review rules and the task's goal, then each escalated
 * ask is a tiny resumed message (prompt-cached prefix), so cost stays flat
 * under many requests. It is not a live process, just a session id. Every call is a
 * short-lived `claude -p --resume`. Any failure or uncertainty falls back to
 * "escalate" (the existing pending-approval-file human path).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { CLAUDE_SIDECAR_FLAGS } from '../../config';
import { readJsonFile, writeJsonFileAtomic } from '../../../utils/fsx';

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

const SEED_RULES = `You are the approval reviewer for a "coder" background coding task. The task runs inside an OS sandbox; you review only actions that escape it.

Rules:
- git stays read-only: decline any git write (commit/push/checkout/reset/...).
- Decline anything destructive or system-level (sudo, rm -rf outside workspace, killing processes, changing system config, piping downloads to shells).
- Temp locations (/tmp, $TMPDIR, os temp dirs) and paths this task created are workspace scratch. They can be deleted after checking the progress log.
- Accept actions clearly needed for the task goal (package installs in the workspace, running tests/builds/linters, reading system info, network to well-known package registries).
- Escalate when genuinely uncertain, when the action is irreversible beyond the workspace, or when it touches credentials/secrets.

You may Read/Grep workspace files and the task progress log to inform a decision. Do this only when the action line alone is not enough. Most decisions should not need it.

Reply with ONLY one line of JSON: {"decision":"accept"|"decline"|"escalate","reason":"<short>"}. Acknowledge now with {"decision":"escalate","reason":"ready"}.`;

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

// Parallel tool calls from the task can escalate concurrently; serialize them
// so the session transcript stays a clean request/verdict sequence.
async function acquireLock(taskDir: string): Promise<() => void> {
  const lockDir = path.join(taskDir, 'sidecar.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      fs.mkdirSync(lockDir);
      return () => {
        try {
          fs.rmdirSync(lockDir);
        } catch {
          // Already released.
        }
      };
    } catch {
      try {
        const age = Date.now() - fs.statSync(lockDir).mtimeMs;
        if (age > LOCK_STALE_MS) {
          fs.rmdirSync(lockDir);
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('sidecar lock wait timed out');
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
  }
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
  let release: (() => void) | null = null;
  try {
    release = await acquireLock(taskDir);
    const state = loadState(taskDir);

    // Circuit breaker: repeated declines mean the task keeps pushing against
    // policy; hand the stream to a human instead of silently blocking it.
    if (state.declineStreak >= 3) {
      return { decision: 'escalate', reason: 'sidecar decline streak; needs human review' };
    }

    if (!state.sessionId) {
      const sessionId = randomUUID();
      const goal = ask.taskGoal
        ? `\n\nTask goal: ${ask.taskGoal.replace(/\s+/g, ' ').slice(0, 500)}`
        : '';
      const log = `\nTask progress log: ${path.join(taskDir, 'log.jsonl')}`;
      await callClaude(cwd, taskDir, sessionId, false, `${SEED_RULES}${goal}${log}`);
      state.sessionId = sessionId;
      writeJsonFileAtomic(statePath(taskDir), state);
    }

    const text = await callClaude(
      cwd,
      taskDir,
      state.sessionId,
      true,
      `action: ${ask.summary.slice(0, 500)}`,
    );
    const verdict = parseVerdict(text);

    if (verdict?.decision === 'decline') {
      state.declineStreak += 1;
    } else if (verdict?.decision === 'accept') {
      state.declineStreak = 0;
    }
    writeJsonFileAtomic(statePath(taskDir), state);

    return verdict ?? { decision: 'escalate', reason: 'sidecar verdict unparseable' };
  } catch (error) {
    return {
      decision: 'escalate',
      reason: `sidecar unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    release?.();
  }
}
