/** Chat SDK state, one statement per call: `k:` values, `l:` locks and `s:` subscriptions in `chat_state`; `k:` lists and `q:` queues one row per item in `chat_item`. */
import { randomUUID } from 'node:crypto';

import { and, eq, gt, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import type { Lock, QueueEntry, StateAdapter } from 'chat';

import { readQuery, type Db } from './client';
import { chatItem as i, chatState as t } from './schema';

export class PgChatState implements StateAdapter {
  constructor(
    private readonly db: Db,
    private readonly now: () => number = Date.now,
  ) {}

  private at(ttlMs?: number): Date | null {
    return ttlMs ? new Date(this.now() + ttlMs) : null;
  }

  /** An expiry as the ISO text Postgres casts; postgres-js does not serialize a `Date` inside raw SQL. */
  private stamp(ttlMs?: number): string | null {
    return ttlMs === undefined ? null : new Date(this.now() + ttlMs).toISOString();
  }

  // postgres-js answers with the rows, PGlite with `{ rows }`.
  private async rows<T>(statement: SQL): Promise<T[]> {
    const result = (await this.db.execute(statement)) as unknown as T[] | { rows: T[] };
    return Array.isArray(result) ? result : result.rows;
  }

  private live(): SQL {
    return or(isNull(t.expiresAt), gt(t.expiresAt, new Date(this.now())))!;
  }

  private expired(): SQL {
    return lte(t.expiresAt, new Date(this.now()));
  }

  private async read(key: string): Promise<unknown> {
    const [row] = await readQuery(this.db, () =>
      this.db
        .select({ value: sql<unknown>`${t.value}` })
        .from(t)
        .where(and(eq(t.key, key), this.live())),
    );
    return row?.value;
  }

  /** Insert, or take over an expired row; true when this call wrote it. */
  private async claim(key: string, value: unknown, expiresAt: Date | null): Promise<boolean> {
    const rows = await this.db
      .insert(t)
      .values({ key, value, expiresAt })
      .onConflictDoUpdate({ target: t.key, set: { value, expiresAt }, setWhere: this.expired() })
      .returning({ key: t.key });
    return rows.length > 0;
  }

  async connect(): Promise<void> {}

  async disconnect(): Promise<void> {}

  async get<T = unknown>(key: string): Promise<T | null> {
    return ((await this.read(`k:${key}`)) ?? null) as T | null;
  }

  async set<T = unknown>(key: string, value: T, ttlMs?: number): Promise<void> {
    const row = { value, expiresAt: this.at(ttlMs) };
    await this.db
      .insert(t)
      .values({ key: `k:${key}`, ...row })
      .onConflictDoUpdate({ target: t.key, set: row });
  }

  setIfNotExists(key: string, value: unknown, ttlMs?: number): Promise<boolean> {
    return this.claim(`k:${key}`, value, this.at(ttlMs));
  }

  async delete(key: string): Promise<void> {
    await this.db.execute(
      sql`with items as (delete from ${i} where key = ${`k:${key}`}) delete from ${t} where key = ${`k:${key}`}`,
    );
  }

  async appendToList(
    key: string,
    value: unknown,
    options: { maxLength?: number; ttlMs?: number } = {},
  ): Promise<void> {
    const k = `k:${key}`;
    // The newest item carries the list's expiry; an expired list starts over, a long one keeps its newest `maxLength`.
    const trimmed = options.maxLength
      ? sql`or seq <= coalesce((select seq from ${i} where key = ${k} order by seq desc offset ${options.maxLength - 1} limit 1), -1)`
      : sql``;
    await this.db.execute(sql`
      with added as (insert into ${i} (key, value, expires_at) values (${k}, ${JSON.stringify(value)}::jsonb, ${this.stamp(options.ttlMs)}::timestamptz))
      delete from ${i} where key = ${k} and ((select expires_at from ${i} where key = ${k} order by seq desc limit 1) <= ${this.stamp(0)}::timestamptz ${trimmed})`);
  }

  async getList<T = unknown>(key: string): Promise<T[]> {
    const k = `k:${key}`;
    const rows = await readQuery(this.db, () =>
      this.rows<{ value: T }>(sql`
      with newest as (select expires_at from ${i} where key = ${k} order by seq desc limit 1)
      select value from ${i}, newest where key = ${k} and (newest.expires_at is null or newest.expires_at > ${this.stamp(0)}::timestamptz) order by seq`),
    );
    return rows.map(row => row.value);
  }

  async acquireLock(threadId: string, ttlMs: number): Promise<Lock | null> {
    const lock = { threadId, token: randomUUID(), expiresAt: this.now() + ttlMs };
    return (await this.claim(`l:${threadId}`, lock.token, new Date(lock.expiresAt))) ? lock : null;
  }

  async extendLock(lock: Lock, ttlMs: number): Promise<boolean> {
    const rows = await this.db
      .update(t)
      .set({ expiresAt: this.at(ttlMs) })
      .where(and(eq(t.key, `l:${lock.threadId}`), eq(t.value, lock.token), this.live()))
      .returning({ key: t.key });
    return rows.length > 0;
  }

  async releaseLock(lock: Lock): Promise<void> {
    await this.db.delete(t).where(and(eq(t.key, `l:${lock.threadId}`), eq(t.value, lock.token)));
  }

  async forceReleaseLock(threadId: string): Promise<void> {
    await this.db.delete(t).where(eq(t.key, `l:${threadId}`));
  }

  async enqueue(threadId: string, entry: QueueEntry, maxSize: number): Promise<number> {
    const k = `q:${threadId}`;
    const now = this.stamp(0);
    // Expired entries go, and the newest `maxSize` stay, in the same statement.
    const [row] = await this.rows<{ depth: number }>(sql`
      with added as (insert into ${i} (key, value, expires_at) values (${k}, ${JSON.stringify(entry)}::jsonb, ${new Date(entry.expiresAt).toISOString()}::timestamptz)),
      dropped as (delete from ${i} where key = ${k} and (expires_at <= ${now}::timestamptz
        or seq <= coalesce((select seq from ${i} where key = ${k} and expires_at > ${now}::timestamptz order by seq desc offset ${maxSize - 1} limit 1), -1)))
      select least((select count(*) from ${i} where key = ${k} and expires_at > ${now}::timestamptz) + 1, ${maxSize})::int as depth`);
    return Number(row?.depth ?? 0);
  }

  async dequeue(threadId: string): Promise<QueueEntry | null> {
    const k = `q:${threadId}`;
    const now = this.stamp(0);
    // Takes the oldest live entry and drops expired ones in the same statement.
    const rows = await this.rows<{ value: QueueEntry; live: boolean }>(sql`
      delete from ${i} where key = ${k} and (expires_at <= ${now}::timestamptz
        or seq = (select seq from ${i} where key = ${k} and expires_at > ${now}::timestamptz order by seq limit 1 for update skip locked))
      returning value, expires_at > ${now}::timestamptz as live`);
    return rows.find(row => row.live)?.value ?? null;
  }

  async queueDepth(threadId: string): Promise<number> {
    const [row] = await readQuery(this.db, () =>
      this.rows<{ depth: number }>(sql`
      select count(*)::int as depth from ${i} where key = ${`q:${threadId}`} and expires_at > ${this.stamp(0)}::timestamptz`),
    );
    return Number(row?.depth ?? 0);
  }

  async subscribe(threadId: string): Promise<void> {
    const row = { value: true, expiresAt: null };
    await this.db
      .insert(t)
      .values({ key: `s:${threadId}`, ...row })
      .onConflictDoUpdate({ target: t.key, set: row });
  }

  async unsubscribe(threadId: string): Promise<void> {
    await this.db.delete(t).where(eq(t.key, `s:${threadId}`));
  }

  async isSubscribed(threadId: string): Promise<boolean> {
    return (await this.read(`s:${threadId}`)) === true;
  }
}
