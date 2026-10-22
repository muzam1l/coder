import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import type { Task } from '../types';
import { resolveTaskDir } from '../state';
import { readJsonFile, writeJsonFileAtomic } from '../../utils/fsx';
import { codexHome } from './codex/sessions';

/** Claude's transcripts: `<session-id>.jsonl` (coder's threadId) under a per-project dir, found by id. */
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

export const HISTORY_CONVERSATION = /^[A-Za-z0-9-]{1,128}$/;

type HistoryTask = Pick<Task, 'engine'> & Partial<Pick<Task, 'id' | 'cwd'>>;

interface TranscriptMessage {
  speaker: string;
  time: string;
  text: string;
  /** A tool call or its result, not conversation. */
  tooling: boolean;
}

export function conversationIds(task: Pick<Task, 'threadId' | 'previousThreadIds'>): string[] {
  return [
    ...new Set([...(task.previousThreadIds ?? []), ...(task.threadId ? [task.threadId] : [])]),
  ];
}

export async function transcriptFiles(task: HistoryTask, id: string): Promise<string[]> {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) return [];
  const claude = task.engine === 'claude';
  const home = claude ? claudeProjectsDir() : codexHome();
  const cacheFile = task.id
    ? path.join(resolveTaskDir(task.cwd ?? '', task.id), 'history-files.json')
    : undefined;
  const key = JSON.stringify([task.engine, home, id]);
  const cache = cacheFile ? (readJsonFile<Record<string, string[]>>(cacheFile) ?? {}) : {};
  const cached = cache[key];
  if (
    cached?.length &&
    cached.every(file => file.startsWith(`${home}${path.sep}`) && fs.existsSync(file))
  )
    return cached;
  const files: string[] = [];
  const visit = async (dir: string, depth: number) => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory() && depth) await visit(file, depth - 1);
      else if (
        entry.isFile() &&
        (claude ? entry.name === `${id}.jsonl` : entry.name.endsWith(`-${id}.jsonl`))
      )
        files.push(file);
    }
  };
  if (claude) await visit(home, 1);
  else {
    await visit(path.join(home, 'sessions'), 3);
    await visit(path.join(home, 'archived_sessions'), 0);
  }

  if (cacheFile && files.length) writeJsonFileAtomic(cacheFile, { ...cache, [key]: files });

  return files;
}

function transcriptMessage(record: any, claude: boolean): TranscriptMessage | undefined {
  const item = claude
    ? record.message
    : record.type === 'response_item'
      ? record.payload
      : undefined;
  if (!item) return;
  if (!claude && item.type === 'reasoning') return;
  const content = item.content;
  const blocks = Array.isArray(content) ? content : [];
  const speaker = item.role ?? (item.type?.endsWith('_output') ? 'tool' : 'assistant');
  const calls =
    blocks.some(block => block.type === 'tool_use') ||
    ['function_call', 'custom_tool_call'].includes(item.type);
  const results =
    blocks.some(block => block.type === 'tool_result') ||
    ['function_call_output', 'custom_tool_call_output'].includes(item.type);
  const text =
    typeof content === 'string'
      ? content
      : blocks.length
        ? blocks
            .map(block => (typeof block.text === 'string' ? block.text : JSON.stringify(block)))
            .join('\n')
        : JSON.stringify(item);

  return {
    speaker: results && !calls ? 'tool' : speaker,
    time: String(record.timestamp ?? ''),
    text,
    tooling: calls || results,
  };
}

async function* transcript(task: HistoryTask, id: string) {
  for (const file of await transcriptFiles(task, id)) {
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
        const message = transcriptMessage(record, task.engine === 'claude');
        if (message) yield message;
      }
    } finally {
      lines.close();
      input.destroy();
    }
  }
}

export async function history(
  task: HistoryTask & Pick<Task, 'threadId' | 'previousThreadIds'>,
  {
    query,
    from = 0,
    limit = 10,
    role = 'all',
  }: { query?: string; from?: number; limit?: number; role?: 'all' | 'conversation' } = {},
) {
  if (role !== 'all' && role !== 'conversation') throw new Error('role is all or conversation');
  if (query !== undefined && (typeof query !== 'string' || !query.length || query.length > 500))
    throw new Error('Provide a query of 1 to 500 characters');
  if (!Number.isSafeInteger(from) || from < 0)
    throw new Error('Provide from as a nonnegative message index');
  if (!Number.isInteger(limit) || limit < 1 || limit > 20)
    throw new Error('Provide a limit of 1 to 20 messages');

  const messages: { index: number; speaker: string; time: string; text: string }[] = [];
  const needle = query?.toLowerCase();
  let index = 0;
  for (const id of conversationIds(task)) {
    for await (const message of transcript(task, id)) {
      if (role === 'conversation' && message.tooling) continue;
      const current = index++;
      if (current < from) continue;
      const at = needle === undefined ? 0 : message.text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      if (messages.length === limit)
        return { messages, next: messages[messages.length - 1]!.index + 1 };
      const start = Math.max(0, at - 200);
      messages.push({
        index: current,
        speaker: message.speaker,
        time: message.time,
        text: message.text.slice(start, start + 1200),
      });
    }
  }

  return { messages };
}
