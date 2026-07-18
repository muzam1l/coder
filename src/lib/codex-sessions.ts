/**
 * Propagate coder archive/delete to the underlying codex session (the thread a
 * task created, which the codex/ChatGPT Codex app lists as "Coder Task: ..."):
 * coder's threadId is the codex session id. Best-effort — a missing or already
 * archived/deleted session is not treated as an error.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

// Archived sessions live as flat rollout-<timestamp>-<id>.jsonl files under
// $CODEX_HOME/archived_sessions; a directory scan beats spawning the CLI to ask.
export function isCodexSessionArchived(sessionId: string): boolean {
  const dir = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'archived_sessions');
  try {
    return fs.readdirSync(dir).some((name) => name.endsWith(`-${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

// codex unarchive <id>: moves an archived session back into the active section.
// Awaits completion (unlike archiveCodexSession) so a resume can follow it.
// Best-effort: resolves false on failure (e.g. not archived) rather than throwing.
export function unarchiveCodexSession(sessionId: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn('codex', ['unarchive', sessionId], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

// codex delete --force <id>: permanently removes the session (UUID required;
// --force skips the confirmation prompt).
export function deleteCodexSession(sessionId: string): boolean {
  const result = spawnSync('codex', ['delete', '--force', sessionId], { encoding: 'utf8' });
  return result.status === 0;
}
