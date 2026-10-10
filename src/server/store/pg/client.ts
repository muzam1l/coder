import { AsyncLocalStorage } from 'node:async_hooks';
/** Postgres connection for the server: one driver, drizzle on top. */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import postgres from 'postgres';

import { tables } from './schema';
import { DatabaseProfile } from './profile';

/** Any drizzle Postgres database (postgres-js in production, pglite in tests). */
export type Db = PgDatabase<PgQueryResultHKT, typeof tables>;

export interface Connection {
  db: PostgresJsDatabase<typeof tables>;
  profile: DatabaseProfile;
  /** Runs `work` with Postgres's statement_timeout at `ms` for each statement it sends outside a transaction. */
  statementTimeout<T>(ms: number, work: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export const CASING = 'snake_case';

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

/** Separate statements retain fresh snapshots after the lock; the driver owns rollback and disconnects. */
export async function pipeline<T extends postgres.Row>(
  db: Db,
  locks: SQL[],
  statement: SQL,
): Promise<T[]> {
  const client = (db as Db & { $client?: postgres.Sql }).$client;
  if (!client?.begin)
    return db.transaction(async tx => {
      for (const lock of locks) await tx.execute(lock);
      const result = (await tx.execute(statement)) as unknown as T[] | { rows: T[] };
      return Array.isArray(result) ? result : result.rows;
    });
  const dialect = new PgDialect({ casing: CASING });
  const logger = (db._.session as { logger?: { logQuery(query: string, params: unknown[]): void } })
    .logger;
  const results = await client.begin(tx =>
    Promise.all(
      [...locks, statement].map(query => {
        const compiled = dialect.sqlToQuery(query);
        logger?.logQuery(compiled.sql, compiled.params);
        return tx.unsafe<T[]>(compiled.sql, compiled.params as postgres.ParameterOrJSON<never>[]);
      }),
    ).catch(error => {
      // The driver's onclose rejects begin; its callback must not send rollback on a closed socket.
      if (disconnected(error)) return new Promise<T[][]>(() => {});
      throw error;
    }),
  );
  return results[results.length - 1] as T[];
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
): postgres.Sql {
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
          bounds
            .exit(() =>
              sql.begin(tx => [
                tx.unsafe(`set local statement_timeout = ${Math.ceil(bound)}`),
                modes.reduce(
                  (query, mode) => query[mode](),
                  (tx.unsafe as unknown as (...args: unknown[]) => Query)(...args),
                ),
              ]),
            )
            .then(results => (results as unknown[])[1])
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
  const profile = new DatabaseProfile();
  const reads = new AsyncLocalStorage<boolean>();
  const bounds = new AsyncLocalStorage<number>();
  const sql = Object.assign(retryDead(prepared(raw, raw.options.prepare, profile), reads, bounds), {
    reads,
  });
  return {
    db: drizzle(sql, { schema: tables, casing: CASING }),
    profile,
    statementTimeout: (ms, work) => bounds.run(ms, work),
    close: () => sql.end(),
  };
}
