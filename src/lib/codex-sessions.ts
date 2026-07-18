/**
 * Propagate coder archive/delete to the underlying codex session (the thread a
 * task created, which the codex/ChatGPT Codex app lists as "Coder Task: ..."):
 * coder's threadId is the codex session id. Best-effort — a missing or already
 * archived/deleted session is not treated as an error.
 */
import { spawn, spawnSync } from 'node:child_process';

// codex archive <id>: moves the session into codex's archived section.
// Fire-and-forget (detached) so a sweep over many tasks never blocks the CLI.
export function archiveCodexSession(sessionId: string): void {
  try {
    const child = spawn('codex', ['archive', sessionId], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort.
  }
}

// codex delete --force <id>: permanently removes the session (UUID required;
// --force skips the confirmation prompt).
export function deleteCodexSession(sessionId: string): boolean {
  const result = spawnSync('codex', ['delete', '--force', sessionId], { encoding: 'utf8' });
  return result.status === 0;
}
