/** One in-memory cache per server for answers fetched from outside: a TTL, a size cap and one request per key in flight. */

export class MemoryCache<T> {
  private readonly entries = new Map<string, { value: T; at: number }>();
  private readonly pending = new Map<string, Promise<T | undefined>>();

  constructor(
    private readonly options: {
      ttlMs: number;
      max: number;
      now?: () => number;
      accept?: (value: T) => boolean;
    },
  ) {}

  /** The fresh value, else one fetch shared by concurrent callers; a failed refresh falls back to the expired value. */
  async get(key: string, fetch: () => Promise<T | undefined>): Promise<T | undefined> {
    const now = this.options.now ?? Date.now;
    const at = now();
    const cached = this.entries.get(key);
    if (cached && at - cached.at < this.options.ttlMs) return cached.value;

    let refresh = this.pending.get(key);
    if (!refresh) {
      refresh = Promise.resolve()
        .then(fetch)
        .then(value => {
          if (value === undefined) return cached?.value;
          if (this.options.accept && !this.options.accept(value)) return cached?.value ?? value;
          this.entries.set(key, { value, at: now() });
          const oldest = this.entries.keys().next().value;
          if (this.entries.size > this.options.max && oldest !== undefined)
            this.entries.delete(oldest);
          return value;
        })
        .catch(error => {
          console.error(`coder server: model probe failed for ${key}`, error);
          return cached?.value;
        })
        .finally(() => this.pending.delete(key));
      this.pending.set(key, refresh);
    }

    return refresh;
  }
}
