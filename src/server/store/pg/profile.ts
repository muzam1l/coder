import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

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
