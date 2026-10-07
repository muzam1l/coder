/**
 * Propagate coder task archive/delete to the underlying codex session (the thread a
 * task created, which the codex/ChatGPT Codex app lists as "Coder Task: ..."):
 * coder's threadId is the Codex session id. Best effort. A missing or already
 * archived/deleted session is not treated as an error.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadBrokerSession } from '../../broker/session';
import { CodexAppServerClient } from './app-server';

// A finished thread stays loaded in the broker's app-server (rollout
// write-locked) for ~30 min, so `codex archive`/`codex delete` from any other
// process fail with "already has an active writer." This is the same error Codex
// app shows. Ask the owning app-server instead: it unloads the thread first.
async function requestViaBroker(cwd: string, method: string, threadId: string): Promise<boolean> {
  for (const networkAccess of [false, true]) {
    if (!loadBrokerSession(cwd, networkAccess)) {
      continue;
    }
    let client: Awaited<ReturnType<typeof CodexAppServerClient.connect>> | null = null;
    try {
      client = await CodexAppServerClient.connect(cwd, {
        networkAccess,
        reuseExistingBroker: true,
      });
      await client.request(method, { threadId });
      return true;
    } catch {
      // Not owned here (or broker busy): try the next broker, then the CLI.
    } finally {
      await client?.close().catch(() => {});
    }
  }
  return false;
}

// Fire-and-forget (detached) so a sweep over many tasks never blocks the CLI.
function spawnCodexCli(args: string[]): void {
  try {
    const child = spawn('codex', args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort.
  }
}

// Moves the session into codex's archived section.
export async function archiveCodexSession(cwd: string, sessionId: string): Promise<void> {
  if (!(await requestViaBroker(cwd, 'thread/archive', sessionId))) {
    spawnCodexCli(['archive', sessionId]);
  }
}

// Archived sessions live as flat rollout-<timestamp>-<id>.jsonl files under
// $CODEX_HOME/archived_sessions; a directory scan beats spawning the CLI to ask.
export function isCodexSessionArchived(sessionId: string): boolean {
  const dir = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), '.codex'),
    'archived_sessions',
  );
  try {
    return fs.readdirSync(dir).some(name => name.endsWith(`-${sessionId}.jsonl`));
  } catch {
    return false;
  }
}

// codex unarchive <id>: moves an archived session back into the active section.
// Awaits completion (unlike archiveCodexSession) so a resume can follow it.
// Best-effort: resolves false on failure (e.g. not archived) rather than throwing.
export function unarchiveCodexSession(sessionId: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn('codex', ['unarchive', sessionId], { stdio: 'ignore' });
      child.on('error', () => resolve(false));
      child.on('close', code => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}

// Permanently removes the session (--force skips the CLI's confirmation prompt).
export async function deleteCodexSession(cwd: string, sessionId: string): Promise<boolean> {
  if (await requestViaBroker(cwd, 'thread/delete', sessionId)) {
    return true;
  }
  return spawnSync('codex', ['delete', '--force', sessionId], { encoding: 'utf8' }).status === 0;
}
