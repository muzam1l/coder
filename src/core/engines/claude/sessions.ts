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
import readline from 'node:readline';

export function claudeProjectsDir(): string {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

export async function lastClaudeUsage(sessionId: string, since: number, configDir?: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) return null;
  const projectsDir = configDir ? path.join(configDir, 'projects') : claudeProjectsDir();
  let usage: unknown = null;
  for (const entry of await fs.promises.readdir(projectsDir).catch(() => [])) {
    const file = path.join(projectsDir, entry, `${sessionId}.jsonl`);
    if (!fs.existsSync(file)) continue;
    const input = fs.createReadStream(file, { encoding: 'utf8' });
    const lines = readline.createInterface({ input, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let record: any;
        try {
          record = JSON.parse(line);
        } catch {
          continue;
        }
        if (
          record.type === 'assistant' &&
          !record.isSidechain &&
          Date.parse(record.timestamp) >= since
        )
          usage = record.message?.usage ?? null;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }

  return usage;
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
    // Projects directory is missing or unreadable. There is nothing to clean up.
  }
  return removed;
}
