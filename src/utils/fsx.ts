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

/** Write via a sibling tmp file + rename so readers never see a partial file. */
export function writeFileAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export function writeJsonFileAtomic(file: string, value: unknown): void {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`);
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
export function createJsonlTail(file: string, from = 0): () => string[] {
  let pos = from;
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

/** Directory watches survive atomic replacements; the latch also accepts process/store signals. */
export function watchChanges(directory?: string, onChange?: (file: string | null) => void) {
  let changed = false;
  let closed = false;
  const waiters = new Set<() => void>();
  const notify = () => {
    changed = true;
    for (const wake of [...waiters]) wake();
  };
  // Native watch registration can lag publications made in the same turn.
  const initial = directory
    ? setImmediate(() => {
        notify();
        onChange?.(null);
      })
    : undefined;
  let watcher: fs.FSWatcher | undefined;
  try {
    if (directory)
      watcher = fs.watch(directory, { persistent: false }, (_event, file) => {
        notify();
        onChange?.(file);
      });
    watcher?.on('error', notify);
  } catch {}
  return {
    notify,
    wait(ms: number, signal?: AbortSignal): Promise<void> {
      if (closed || changed || signal?.aborted || ms <= 0) {
        changed = false;
        return Promise.resolve();
      }
      return new Promise(resolve => {
        const wake = () => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', wake);
          waiters.delete(wake);
          changed = false;
          resolve();
        };
        const timer = setTimeout(wake, ms);
        waiters.add(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    },
    async until<T>(
      read: () => T | undefined | Promise<T | undefined>,
      timeoutMs: number,
      signal?: AbortSignal,
      recoveryMs = 30000,
    ): Promise<T | undefined> {
      const deadline = Date.now() + timeoutMs;
      try {
        for (;;) {
          const value = await read();
          if (value !== undefined || closed || Date.now() >= deadline || signal?.aborted) return value;
          await this.wait(Math.min(recoveryMs, deadline - Date.now()), signal);
        }
      } finally {
        this.close();
      }
    },
    close() {
      closed = true;
      clearImmediate(initial);
      watcher?.close();
      for (const wake of [...waiters]) wake();
    },
  };
}

/** Serialize file-backed state with a fenced owner marker and a recovery lease. */
export async function withFileLock<T>(
  file: string,
  work: () => T,
  staleMs = 30000,
  timeoutMs = Infinity,
): Promise<Awaited<T>> {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const staging = fs.mkdtempSync(`${file}-`);
  const owner = `${process.pid}-${randomUUID()}`;
  fs.mkdirSync(path.join(staging, owner));
  const changes = watchChanges(path.dirname(file));
  const deadline = Date.now() + timeoutMs;
  let acquired = false;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  try {
    while (!acquired) {
      try {
        if (fs.existsSync(file)) throw Object.assign(new Error('Lock is held'), { code: 'EEXIST' });
        fs.renameSync(staging, file);
        acquired = true;
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
        try {
          const legacy = fs.statSync(file).isFile();
          const entries = legacy ? [''] : fs.readdirSync(file);
          for (const entry of entries) {
            const marker = legacy ? file : path.join(file, entry);
            const pid = Number(legacy ? fs.readFileSync(file, 'utf8') : entry.split('-')[0]);
            let stale = (!legacy || !pid) && Date.now() - fs.statSync(marker).mtimeMs > staleMs;
            if (pid) {
              try {
                process.kill(pid, 0);
              } catch (error) {
                stale ||= (error as NodeJS.ErrnoException).code === 'ESRCH';
              }
            }
            if (stale) legacy ? fs.unlinkSync(marker) : fs.rmdirSync(marker);
          }
          if (
            !legacy &&
            (entries.length ||
              staleMs === Infinity ||
              Date.now() - fs.statSync(file).mtimeMs > staleMs)
          )
            fs.rmdirSync(file);
        } catch {}
        if (Date.now() >= deadline) throw new Error('File lock wait timed out');
        await changes.wait(Math.min(30000, staleMs, deadline - Date.now()));
      }
    }
    heartbeat = setInterval(() => {
      try {
        fs.utimesSync(path.join(file, owner), new Date(), new Date());
      } catch {}
    }, 1000);
    heartbeat.unref();
    return await work();
  } finally {
    changes.close();
    clearInterval(heartbeat);
    if (acquired) {
      try {
        fs.rmdirSync(path.join(file, owner));
      } catch {}
      try {
        fs.rmdirSync(file);
      } catch {}
    } else fs.rmSync(staging, { recursive: true, force: true });
  }
}
