/** Platforms' public signing keys, held per server and per trusted endpoint, never per request. */
import { createLocalJWKSet, errors, type JSONWebKeySet, type JWTVerifyGetKey } from 'jose';

const DAY_MS = 24 * 60 * 60 * 1000;
/** An unknown `kid` refetches its endpoint at most this often. */
const COOLDOWN_MS = 30_000;
/** Endpoints held at once; Entra's are per directory. */
const ENDPOINTS = 100;
/** A key fetch, body included, fails after this. */
const FETCH_TIMEOUT_MS = 5000;

interface KeySet {
  resolve: ReturnType<typeof createLocalJWKSet>;
  fetchedAt: number;
  expiresAt: number;
}

export class SigningKeys {
  private readonly sets = new Map<string, KeySet>();
  private readonly pending = new Map<string, Promise<KeySet>>();

  constructor(private readonly now: () => number = Date.now) {}

  /** A key resolver for `url`, an endpoint Coder trusts, never one a token names. */
  resolver(url: string, fetcher: typeof fetch): JWTVerifyGetKey {
    return async (header, token) => {
      const held = this.sets.get(url);
      const set = held && held.expiresAt > this.now() ? held : await this.refresh(url, fetcher);
      try {
        return await set.resolve(header, token);
      } catch (error) {
        if (
          !(error instanceof errors.JWKSNoMatchingKey) ||
          this.now() - set.fetchedAt < COOLDOWN_MS
        )
          throw error;

        return (await this.refresh(url, fetcher)).resolve(header, token);
      }
    };
  }

  /** One fetch per endpoint at a time, bounded by a deadline; it holds for its Cache-Control max-age, at most a day. */
  private refresh(url: string, fetcher: typeof fetch): Promise<KeySet> {
    const running = this.pending.get(url);
    if (running) return running;

    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const deadline = new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
    const load = (async () => {
      const response = await fetcher(url, { headers: { accept: 'application/json' }, signal });
      if (!response.ok) throw new Error(`Signing keys at ${url} answered ${response.status}`);

      const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1];
      const now = this.now();
      const set = {
        resolve: createLocalJWKSet((await response.json()) as JSONWebKeySet),
        fetchedAt: now,
        expiresAt: now + Math.min(maxAge ? Number(maxAge) * 1000 : DAY_MS, DAY_MS),
      };
      this.sets.delete(url);
      this.sets.set(url, set);
      if (this.sets.size > ENDPOINTS) this.sets.delete(this.sets.keys().next().value!);

      return set;
    })();
    const work = Promise.race([load, deadline]).finally(() => this.pending.delete(url));
    this.pending.set(url, work);

    return work;
  }
}
