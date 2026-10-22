/** Postgres connection for the server: one driver, drizzle on top. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';

import { tables } from './schema';

export function sqlShape(query: string): string {
  return query
    .replace(
      /\$(\w*)\$[\s\S]*?\$\1\$|[eE]'(?:\\.|''|[^'])*'|'(?:''|[^'])*'|--[^\n]*|\/\*[\s\S]*?\*\//g,
      value => (value.startsWith('--') || value.startsWith('/*') ? ' ' : '?'),
    )
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim();
}

export class DatabaseProfile {
  private readonly requests = new AsyncLocalStorage<string>();

  request<T>(inProcess: boolean, work: (requestId?: string) => T): T {
    if (process.env.CODER_DB_PROFILE !== '1') return work();
    const id = (inProcess && this.requests.getStore()) || randomUUID();
    return this.requests.run(id, () => work(id));
  }

  statement(statement: string, requestId = this.requests.getStore() ?? 'background') {
    const start = performance.now();
    return (rows: number | null, failed = false, shape = statement) =>
      console.info(
        JSON.stringify({
          type: 'coder.db',
          requestId,
          sql: sqlShape(shape),
          start,
          ms: performance.now() - start,
          rows,
          failed,
        }),
      );
  }

  /** Observes lazy queries without executing them before their caller. */
  query<T extends PromiseLike<unknown>>(query: T, statement: string): T {
    if (process.env.CODER_DB_PROFILE !== '1') return query;
    const profile = this;
    const requestId = this.requests.getStore() ?? 'background';
    let observed: Promise<unknown> | undefined;
    return new Proxy(query, {
      get(target, key, receiver) {
        if (key !== 'then') return Reflect.get(target, key, receiver);
        return (resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          observed ??= (() => {
            const log = profile.statement(statement, requestId);
            return Promise.resolve(target).then(
              result => {
                const rows = result as { count?: number; length?: number } | undefined;
                log(rows?.count ?? rows?.length ?? null);
                return result;
              },
              error => {
                log(null, true);
                throw error;
              },
            );
          })();
          return observed.then(resolve, reject);
        };
      },
    });
  }
}

/** Any drizzle Postgres database (postgres-js in production, pglite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof tables>;

interface RowResult extends PgQueryResultHKT {
  type: this['row'][];
}

export interface Connection {
  db: PgDatabase<RowResult, typeof tables>;
  profile: DatabaseProfile;
  /** Runs `work` with Postgres's statement_timeout at `ms` for each statement it sends outside a transaction. */
  statementTimeout<T>(ms: number, work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const CASING = 'snake_case';

/** Host and database of a connection string, for messages; never the credentials. */
export function describeDatabase(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}${parsed.pathname}`;
  } catch {
    return 'the database';
  }
}

function disconnected(error?: { code?: string; severity?: string }): boolean {
  return (
    error?.severity === 'FATAL' ||
    [
      'CONNECTION_CLOSED',
      'CONNECTION_ENDED',
      'CONNECTION_DESTROYED',
      'ECONNRESET',
      'EPIPE',
    ].includes(error?.code ?? '')
  );
}

/** `BEGIN`, the locks, the statement and `COMMIT` written back to back on one reserved connection, so the driver pipelines them into one network round trip; a failed statement aborts the transaction and its `COMMIT` rolls back. Each statement keeps its own snapshot, taken after the locks. */
export async function pipeline<T extends postgres.Row>(
  db: Db,
  locks: SQL[],
  statement: SQL,
): Promise<T[]> {
  const client = (db as Db & { $client?: Pool }).$client;
  if (!client?.reserve)
    return db.transaction(async tx => {
      for (const lock of locks) await tx.execute(lock);
      const result = (await tx.execute(statement)) as unknown as T[] | { rows: T[] };
      return Array.isArray(result) ? result : result.rows;
    });
  const dialect = new PgDialect({ casing: CASING });
  const logger = (db._.session as { logger?: { logQuery(query: string, params: unknown[]): void } })
    .logger;
  const results = await reservedTransaction(client, client.options.prepare, client.profile, sql =>
    [...locks, statement].map(query => {
      const compiled = dialect.sqlToQuery(query);
      logger?.logQuery(compiled.sql, compiled.params);
      return sql.unsafe<T[]>(compiled.sql, compiled.params as postgres.ParameterOrJSON<never>[]);
    }),
  );

  return results[results.length - 1] as T[];
}

/** Runs `queries` between `BEGIN` and `COMMIT` on one reserved connection in one round trip, resolving to their results. */
async function reservedTransaction(
  pool: postgres.Sql,
  prepare: boolean,
  profile: DatabaseProfile,
  queries: (sql: postgres.ReservedSql) => PromiseLike<unknown>[],
): Promise<unknown[]> {
  const reserved = prepared(await pool.reserve(), prepare, profile);
  // The connection behind the reservation; a drop mid-flight rejects here, since postgres.js forgets the queries still queued on it.
  let connection: { onclose?: (error: Error) => void } | undefined;
  let dropped = false;
  let drop!: (error: Error) => void;
  const closed = new Promise<never>((_, reject) => (drop = reject));
  const begin = reserved.unsafe('begin', [], {
    onexecute: (c: typeof connection & object) => {
      connection = c;
      c.onclose = error => {
        dropped = true;
        drop(error);
      };
      return true;
    },
  } as postgres.UnsafeQueryOptions);
  try {
    const sent = queries(reserved);
    const settled = await Promise.race([
      Promise.allSettled([begin, ...sent, reserved.unsafe('commit')]),
      closed,
    ]);
    const failed = settled.find(result => result.status === 'rejected');
    if (failed) throw failed.reason;

    return settled.slice(1, -1).map(result => (result as PromiseFulfilledResult<unknown>).value);
  } finally {
    if (connection) connection.onclose = undefined;
    // A dropped connection is already back in the pool's closed set; releasing it would hand out a dead socket.
    if (!dropped) reserved.release();
  }
}

// drizzle sends every statement through unsafe(), which postgres.js never prepares: two round trips per query.
export function prepared<T extends postgres.Sql | postgres.TransactionSql>(
  sql: T,
  prepare: boolean,
  profile = new DatabaseProfile(),
): T {
  const unsafe = sql.unsafe;
  sql.unsafe = ((
    query: string,
    args?: postgres.ParameterOrJSON<never>[],
    options?: postgres.UnsafeQueryOptions,
  ) => profile.query(unsafe(query, args, { prepare, ...options }), query)) as T['unsafe'];
  for (const name of ['begin', 'savepoint'] as const) {
    const scope = (sql as unknown as Record<string, ((...args: unknown[]) => unknown) | undefined>)[
      name
    ];
    if (!scope) continue;
    (sql as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      const fn = args.pop() as (tx: postgres.TransactionSql) => unknown;
      if (process.env.CODER_DB_PROFILE === '1') {
        const begin = name === 'savepoint' ? profile.statement('savepoint') : undefined;
        let end: ReturnType<DatabaseProfile['statement']> | undefined;
        return Promise.resolve(
          scope.call(sql, ...args, async (tx: postgres.TransactionSql) => {
            begin?.(null);
            try {
              const result = fn(prepared(tx, prepare, profile));
              return await (Array.isArray(result) ? Promise.all(result) : result);
            } finally {
              end = profile.statement(name === 'begin' ? 'commit' : 'release savepoint');
            }
          }),
        ).then(
          value => {
            end?.(null);
            return value;
          },
          error => {
            if (end) end(null, true, name === 'begin' ? 'rollback' : 'rollback to savepoint');
            else begin?.(null, true);
            throw error;
          },
        );
      }
      return scope.call(sql, ...args, (tx: postgres.TransactionSql) =>
        fn(prepared(tx, prepare, profile)),
      );
    };
  }
  return sql;
}

/** Explicitly permits one retry on this connection when this read loses its socket. */
export function readQuery<T>(db: Db, query: () => PromiseLike<T>): Promise<T> {
  const reads = (db as Db & { $client?: { reads?: AsyncLocalStorage<boolean> } }).$client?.reads;
  return reads ? reads.run(true, async () => query()) : Promise.resolve(query());
}

/** A read on a connection the server dropped runs once more; a write may have reached the server, so it fails. */
function retryDead(
  sql: postgres.Sql,
  reads: AsyncLocalStorage<boolean>,
  bounds: AsyncLocalStorage<number>,
  profile: DatabaseProfile,
): postgres.Sql {
  const begin = sql.begin;
  // An explicit transaction keeps the driver's reserved connection, outside per-statement bounds.
  sql.begin = ((...args: Parameters<typeof begin>) =>
    bounds.exit(() => begin.apply(sql, args))) as typeof begin;
  type Query = PromiseLike<unknown> & Record<'values' | 'raw', () => Query>;
  const unsafe = sql.unsafe as unknown as (...args: unknown[]) => Query;
  sql.unsafe = ((...args: unknown[]) => {
    const retryable = reads.getStore() === true;
    const bound = bounds.getStore();
    const first = unsafe(...args);
    const modes: ('values' | 'raw')[] = [];
    const again = () =>
      bound
        ? // Postgres's own statement_timeout, set for this statement alone in one pipelined round trip.
          reservedTransaction(sql, sql.options.prepare, profile, reserved => [
            reserved.unsafe(`set local statement_timeout = ${Math.ceil(bound)}`),
            modes.reduce(
              (query, mode) => query[mode](),
              (reserved.unsafe as unknown as (...args: unknown[]) => Query)(...args),
            ),
          ]).then(results => results[1])
        : modes.reduce((query, mode) => query[mode](), unsafe(...args));
    // After a macrotask, so postgres.js has closed every connection the same drop took.
    const retry = () => new Promise(resolve => setTimeout(resolve)).then(again);
    const pending: Query = new Proxy(first, {
      get: (target, key, receiver) =>
        key === 'values' || key === 'raw'
          ? () => (modes.push(key), target[key](), pending)
          : key === 'then'
            ? (resolve?: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
                (bound ? again() : target)
                  .then(undefined, (error: { code?: string; severity?: string } | undefined) =>
                    disconnected(error) && retryable ? retry() : Promise.reject(error),
                  )
                  .then(resolve, reject)
            : Reflect.get(target, key, receiver),
    });
    return pending;
  }) as unknown as postgres.Sql['unsafe'];
  return sql;
}

/** The driver pool as `connect` hands it out, with its profile and read-retry scope. */
type Pool = postgres.Sql & { profile: DatabaseProfile; reads: AsyncLocalStorage<boolean> };

export interface PoolOptions {
  max?: number;
  idleTimeout?: number;
}

export function connect(databaseUrl: string, options: PoolOptions = {}): Connection {
  // Idle ones close before Neon's 5 minute cutoff drops them.
  const raw = postgres(databaseUrl, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 240,
    onnotice: () => {},
  });
  const direct = new URL(databaseUrl);
  let listener: postgres.Sql | undefined;
  if (direct.hostname.endsWith('.neon.tech') && direct.hostname.includes('-pooler.')) {
    direct.hostname = direct.hostname.replace('-pooler.', '.');
    raw.listen = (...args) => {
      listener ??= postgres(direct.href, { max: 1, onnotice: () => {} });
      return listener.listen(...args);
    };
  }
  const profile = new DatabaseProfile();
  const reads = new AsyncLocalStorage<boolean>();
  const bounds = new AsyncLocalStorage<number>();
  const sql = Object.assign(
    retryDead(prepared(raw, raw.options.prepare, profile), reads, bounds, profile),
    {
      reads,
      profile,
    },
  );
  return {
    db: drizzle(sql, { schema: tables, casing: CASING }),
    profile,
    statementTimeout: (ms, work) => bounds.run(ms, work),
    close: async () => {
      await Promise.all([sql.end(), listener?.end()]);
    },
  };
}
