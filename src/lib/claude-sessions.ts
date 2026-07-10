/**
 * Best-effort removal of the claude transcript behind a task. Claude has no
 * archive/delete CLI, so `coder task delete` reaches into claude's own store and
 * removes the session's transcript file. coder's threadId is claude's session
 * id, and transcripts are named `<session-id>.jsonl` under a per-project dir, so
 * we locate the file by id rather than reproducing claude's path encoding.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// Delete the `<sessionId>.jsonl` transcript wherever it lives under projects/.
// Returns true if a file was removed. Claude has no "archive" concept, so there
// is no archive counterpart.
export function deleteClaudeSession(sessionId: string): boolean {
  if (!sessionId) {
    return false;
  }
  const projectsDir = claudeProjectsDir();
  let removed = false;
  try {
    for (const entry of fs.readdirSync(projectsDir)) {
      const file = path.join(projectsDir, entry, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) {
        fs.rmSync(file, { force: true });
        removed = true;
      }
    }
  } catch {
    // projects dir missing or unreadable — nothing to clean up.
  }
  return removed;
}
