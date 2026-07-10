/**
 * Propagate coder archive/delete to the underlying codex session (the thread a
 * task created, which the codex/ChatGPT Codex app lists as "Coder Task: ..."):
 * coder's threadId is the codex session id. Best-effort — a missing or already
 * archived/deleted session is not treated as an error.
 */
import { spawnSync } from 'node:child_process';

// codex archive <id>: moves the session into codex's archived section.
export function archiveCodexSession(sessionId: string): boolean {
  const result = spawnSync('codex', ['archive', sessionId], { encoding: 'utf8' });
  return result.status === 0;
}

// codex delete --force <id>: permanently removes the session (UUID required;
// --force skips the confirmation prompt).
export function deleteCodexSession(sessionId: string): boolean {
  const result = spawnSync('codex', ['delete', '--force', sessionId], { encoding: 'utf8' });
  return result.status === 0;
}
