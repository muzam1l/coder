/**
 * Small filesystem helpers shared by the task and flow state layers:
 * crash-tolerant JSON reads, atomic JSON writes, and incremental JSONL
 * tailing (so pollers don't re-read a growing file from byte 0 every tick).
 */
import fs from 'node:fs';

/** Parse a JSON file; null when missing, unreadable, or truncated mid-write. */
export function readJsonFile<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

/** Write JSON via a sibling tmp file + rename so readers never see a partial file. */
export function writeJsonFileAtomic(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/**
 * Incremental JSONL reader: each call returns the COMPLETE lines appended
 * since the previous call, reading only the new bytes. A file that shrank
 * (truncated for a fresh attempt) resets to the start. A trailing partial
 * line (append in progress) is carried until its newline lands.
 */
export function createJsonlTail(file: string): () => string[] {
  let pos = 0;
  let carry = '';
  return () => {
    let size: number;
    try {
      size = fs.statSync(file).size;
    } catch {
      return [];
    }
    if (size < pos) {
      pos = 0;
      carry = '';
    }
    if (size === pos) return [];
    let fd: number;
    try {
      fd = fs.openSync(file, 'r');
    } catch {
      return [];
    }
    try {
      const buf = Buffer.alloc(size - pos);
      const read = fs.readSync(fd, buf, 0, buf.length, pos);
      pos += read;
      const chunk = carry + buf.toString('utf8', 0, read);
      const lines = chunk.split('\n');
      carry = lines.pop() ?? '';
      return lines.filter(Boolean);
    } finally {
      fs.closeSync(fd);
    }
  };
}
