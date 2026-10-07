/** Chat SDK state for memory and local servers, and the wrapper that keeps each app's keys apart. */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Lock, QueueEntry, StateAdapter } from 'chat';

type Entry = { value: unknown; expiresAt?: number };

/** Every key in one map: `k:` values and lists, `l:` locks, `q:` queues, `s:` subscriptions. */
export class LocalChatState implements StateAdapter {
  private readonly memory = new Map<string, Entry>();

  /** Without `file` the state lives in this instance, for a throwaway server. */
  constructor(
    private readonly file?: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Read, change and write in one synchronous step, so no other call interleaves. */
  private change<T>(work: (entries: Map<string, Entry>, now: number) => T): T {
    const now = this.now();
    const entries = this.load(now);
    const result = work(entries, now);
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const temp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify(Object.fromEntries(entries)), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    }
    return result;
  }

  private load(now: number): Map<string, Entry> {
    let entries = this.memory;
    if (this.file) {
      try {
        entries = new Map(Object.entries(JSON.parse(fs.readFileSync(this.file, 'utf8'))));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        entries = new Map();
      }
    }
    for (const [key, entry] of entries)
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) entries.delete(key);
    return entries;
  }

  private read(key: string): unknown {
    return this.load(this.now()).get(key)?.value;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async get<T = unknown>(key: string): Promise<T | null> {
    return (this.read(`k:${key}`) ?? null) as T | null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    this.change((entries, now) => entries.set(`k:${key}`, expiring(value, now, ttlMs)));
  }

  async setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.change((entries, now) => {
      if (entries.has(`k:${key}`)) return false;
      entries.set(`k:${key}`, expiring(value, now, ttlMs));
      return true;
    });
  }

  async delete(key: string): Promise<void> {
    this.change(entries => entries.delete(`k:${key}`));
  }

  async appendToList(
    key: string,
    value: unknown,
    options: { maxLength?: number; ttlMs?: number } = {},
  ): Promise<void> {
    this.change((entries, now) => {
      const list = [...asList(entries.get(`k:${key}`)?.value), value];
      const kept = options.maxLength ? list.slice(-options.maxLength) : list;
      entries.set(`k:${key}`, expiring(kept, now, options.ttlMs));
    });
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    return asList(this.read(`k:${key}`)) as T[];
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    return this.change((entries, now) => {
      if (entries.has(`l:${threadId}`)) return null;
      const lock = { threadId, token: randomUUID(), expiresAt: now + ttlMs };
      entries.set(`l:${threadId}`, { value: lock.token, expiresAt: lock.expiresAt });
      return lock;
    });
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    return this.change((entries, now) => {
      if (entries.get(`l:${lock.threadId}`)?.value !== lock.token) return false;
      entries.set(`l:${lock.threadId}`, { value: lock.token, expiresAt: now + ttlMs });
      return true;
    });
  }

  async releaseLock(lock: Lock): Promise<void> {
    this.change(entries => {
      if (entries.get(`l:${lock.threadId}`)?.value === lock.token)
        entries.delete(`l:${lock.threadId}`);
    });
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    this.change(entries => entries.delete(`l:${threadId}`));
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    return this.change((entries, now) => {
      const queue = [...fresh(entries.get(`q:${threadId}`)?.value, now), entry].slice(-maxSize);
      entries.set(`q:${threadId}`, {
        value: queue,
        expiresAt: Math.max(...queue.map(item => item.expiresAt)),
      });
      return queue.length;
    });
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    return this.change((entries, now) => {
      const found = entries.get(`q:${threadId}`);
      const [head, ...rest] = fresh(found?.value, now);
      if (rest.length) entries.set(`q:${threadId}`, { ...found, value: rest });
      else entries.delete(`q:${threadId}`);
      return head ?? null;
    });
  }

  async queueDepth(threadId: string): Promise<number> {
    return fresh(this.read(`q:${threadId}`), this.now()).length;
  }

  async subscribe(threadId: string): Promise<void> {
    this.change(entries => entries.set(`s:${threadId}`, { value: true }));
  }

  async unsubscribe(threadId: string): Promise<void> {
    this.change(entries => entries.delete(`s:${threadId}`));
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return this.read(`s:${threadId}`) === true;
  }
}

const expiring = (value: unknown, now: number, ttlMs?: number): Entry =>
  ttlMs ? { value, expiresAt: now + ttlMs } : { value };

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** A queue's entries that have not expired. */
const fresh = (value: unknown, now: number) =>
  (asList(value) as QueueEntry[]).filter(entry => entry.expiresAt > now);

/** One app's view of a shared state: every key and thread id starts with the app id. */
export function appChatState(state: StateAdapter, app: string): StateAdapter {
  const prefix = `${encodeURIComponent(app)}/`;
  const own = (key: string) => prefix + key;
  const lock = (held: Lock): Lock => ({ ...held, threadId: own(held.threadId) });
  const mine = (held: Lock | null): Lock | null =>
    held && { ...held, threadId: held.threadId.slice(prefix.length) };
  return {
    connect: () => state.connect(),
    disconnect: () => state.disconnect(),
    get: key => state.get(own(key)),
    set: (key, value, ttlMs) => state.set(own(key), value, ttlMs),
    setIfNotExists: (key, value, ttlMs) => state.setIfNotExists(own(key), value, ttlMs),
    delete: key => state.delete(own(key)),
    appendToList: (key, value, options) => state.appendToList(own(key), value, options),
    getList: key => state.getList(own(key)),
    acquireLock: async (threadId, ttlMs) => mine(await state.acquireLock(own(threadId), ttlMs)),
    extendLock: (held, ttlMs) => state.extendLock(lock(held), ttlMs),
    releaseLock: held => state.releaseLock(lock(held)),
    forceReleaseLock: threadId => state.forceReleaseLock(own(threadId)),
    enqueue: (threadId, entry, maxSize) => state.enqueue(own(threadId), entry, maxSize),
    dequeue: threadId => state.dequeue(own(threadId)),
    queueDepth: threadId => state.queueDepth(own(threadId)),
    subscribe: threadId => state.subscribe(own(threadId)),
    unsubscribe: threadId => state.unsubscribe(own(threadId)),
    isSubscribed: threadId => state.isSubscribed(own(threadId)),
  };
}
