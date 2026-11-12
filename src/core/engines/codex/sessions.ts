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

import { listBrokerSessions } from '../../broker/session';
import { CodexAppServerClient, errorText } from './app-server';
import { engineEnvironment } from '../../connections';

export function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

// A finished thread stays loaded in the broker's app-server (rollout
// write-locked) for ~30 min, so `codex archive`/`codex delete` from any other
// process fail with "already has an active writer." This is the same error Codex
// app shows. Ask the owning app-server instead: it unloads the thread first.
async function requestViaBroker(cwd: string, method: string, threadId: string): Promise<boolean> {
  for (const session of listBrokerSessions(cwd)) {
    let client: Awaited<ReturnType<typeof CodexAppServerClient.connect>> | null = null;
    try {
      client = await CodexAppServerClient.connect(cwd, {
        env: engineEnvironment(),
        brokerEndpoint: session.endpoint,
        networkAccess: session.networkAccess ?? false,
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
    const child = spawn('codex', args, {
      detached: true,
      stdio: 'ignore',
      env: engineEnvironment(),
    });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Best-effort.
  }
}

// Moves the threads into codex's archived section.
export async function archiveCodexThreads(cwd: string, threadIds: string[]): Promise<void> {
  if (!threadIds.length) return;

  await Promise.all(
    threadIds.map(async threadId => {
      if (!(await requestViaBroker(cwd, 'thread/archive', threadId)))
        spawnCodexCli(['archive', threadId]);
    }),
  );
  await requestCodexAppRescan();
}

// The Codex app's sidebar keeps its own catalog, which drops a thread archived by
// another process only on a full rescan. It runs one once; clearing the marker
// makes it rescan on its next start.
async function requestCodexAppRescan(): Promise<void> {
  const file = path.join(codexHome(), 'sqlite', 'codex.db');
  if (!fs.existsSync(file)) return;

  try {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(file);
    try {
      db.exec('PRAGMA busy_timeout = 5000');
      db.prepare(
        "UPDATE local_thread_catalog_sync_state SET last_full_reconciled_at = NULL WHERE host_id = 'local'",
      ).run();
    } finally {
      db.close();
    }
  } catch (error) {
    console.error(`coder: asking the Codex app to rescan failed: ${errorText(error)}`);
  }
}

// Archived sessions live as flat rollout-<timestamp>-<id>.jsonl files under
// $CODEX_HOME/archived_sessions; a directory scan beats spawning the CLI to ask.
export function isCodexSessionArchived(sessionId: string): boolean {
  const dir = path.join(codexHome(), 'archived_sessions');
  try {
    return fs
      .readdirSync(dir)
      .some(
        name => name.endsWith(`-${sessionId}.jsonl`) || name.endsWith(`-${sessionId}.jsonl.zst`),
      );
  } catch {
    return false;
  }
}

// Coder's threads (originator "coder") idle past idleMs, except those of keep and
// their subagents. Codex lists a thread until it is archived, so this also retries
// archives that failed when the task was archived.
export async function archiveIdleCoderThreads(
  cwd: string,
  keep: Set<string>,
  idleMs: number,
): Promise<void> {
  const client = await CodexAppServerClient.connect(cwd, {
    env: engineEnvironment(),
    disableBroker: true,
  });
  try {
    const idleBefore = (Date.now() - idleMs) / 1000;
    const idle: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { data: CodexThread[]; nextCursor: string | null } = await client.request(
        'thread/list',
        {
          archived: false,
          cursor,
          limit: 100,
          sourceKinds: THREAD_SOURCE_KINDS,
          useStateDbOnly: true,
        },
      );
      for (const thread of page.data)
        if (
          thread.originator === 'coder' &&
          thread.updatedAt < idleBefore &&
          !keep.has(thread.id) &&
          !(thread.parentThreadId && keep.has(thread.parentThreadId))
        )
          idle.push(thread.id);
      cursor = page.nextCursor;
    } while (cursor);

    for (const threadId of idle)
      await client
        .request('thread/archive', { threadId })
        .catch(error =>
          console.error(`coder: archiving Codex thread ${threadId} failed: ${errorText(error)}`),
        );
    if (idle.length) await requestCodexAppRescan();
  } finally {
    await client.close().catch(() => {});
  }
}

// thread/list returns only interactive threads unless asked for every kind.
const THREAD_SOURCE_KINDS = [
  'cli',
  'vscode',
  'exec',
  'appServer',
  'subAgent',
  'subAgentReview',
  'subAgentCompact',
  'subAgentThreadSpawn',
  'subAgentOther',
  'unknown',
];

interface CodexThread {
  id: string;
  originator?: string;
  parentThreadId?: string | null;
  updatedAt: number;
}

// codex unarchive <id>: moves an archived session back into the active section.
// Awaits completion (unlike archiveCodexThreads) so a resume can follow it.
// Best-effort: resolves false on failure (e.g. not archived) rather than throwing.
export function unarchiveCodexSession(sessionId: string): Promise<boolean> {
  return new Promise(resolve => {
    try {
      const child = spawn('codex', ['unarchive', sessionId], {
        stdio: 'ignore',
        env: engineEnvironment(),
      });
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
  return (
    spawnSync('codex', ['delete', '--force', sessionId], {
      encoding: 'utf8',
      env: engineEnvironment(),
    }).status === 0
  );
}
