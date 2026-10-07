/**
 * Small filesystem helpers shared by the task and flow state layers:
 * crash-tolerant JSON reads, atomic JSON writes, and incremental JSONL
 * tailing (so pollers don't re-read a growing file from byte 0 every tick).
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

/**
 * A path as the task views should show it: relative to the workspace (already
 * named in the header), absolute only when it lies outside. Keeps every tool
 * line from carrying the same long cwd prefix.
 */
export function shortPath(cwd: string, target: string): string {
  if (!target) return '';
  if (!path.isAbsolute(target)) return target;
  const rel = path.relative(cwd, target);
  return rel && !rel.startsWith('..') ? rel : target;
}

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
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** Move a complete directory, staging a copy when the destination is on another device. */
export function moveDirectory(from: string, to: string): void {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(to))
    throw Object.assign(new Error(`Directory already exists: ${to}`), { code: 'EEXIST' });
  try {
    fs.renameSync(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const staging = `${to}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.cpSync(from, staging, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    fs.renameSync(staging, to);
    fs.rmSync(from, { recursive: true });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export async function moveDirectoryAsync(from: string, to: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(to), { recursive: true });
  if (
    await fs.promises.lstat(to).catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    })
  )
    throw Object.assign(new Error(`Directory already exists: ${to}`), { code: 'EEXIST' });
  try {
    await fs.promises.rename(from, to);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
  }
  const staging = `${to}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.promises.cp(from, staging, {
      recursive: true,
      preserveTimestamps: true,
      verbatimSymlinks: true,
      errorOnExist: true,
      force: false,
    });
    await fs.promises.rename(staging, to);
    await fs.promises.rm(from, { recursive: true });
  } finally {
    await fs.promises.rm(staging, { recursive: true, force: true });
  }
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
