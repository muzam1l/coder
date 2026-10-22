/** A store view over rows one statement read already: those reads answer from the rows, everything else reaches the store. */
import type { AgentApp, Installation } from '../../agent/types';
import type { StoredCredential } from '../settings/credentials';
import type { StoredConfig } from '../settings/config';
import type {
  TokenState,
  DispatchInput,
  DispatchLoaded,
  RunnerRecord,
  Store,
  StoreKind,
  StoreListOptions,
  TaskStatus,
} from './types';

/** Rows read with a task; a key present with `undefined` is a row known not to exist. */
export interface Loaded {
  app?: AgentApp;
  installation?: Installation;
  credential?: StoredCredential;
  /** The credentials the task's engine may fall back to, when it names none. */
  credentials?: Array<{ id: string; value: StoredCredential }>;
  config?: StoredConfig;
  runner?: RunnerRecord;
  /** Sealed secret rows. */
  secrets?: { rows: string[] };
  resolved?: { id: string; value: { resolvedConnections: string; expiresAt?: number } };
  tokens?: TokenState;
}

const MISS = Symbol('miss');
type Hits = Partial<Record<keyof Store, (...args: never[]) => unknown>>;

function primed(store: Store, hits: Hits): Store {
  return new Proxy(store, {
    get(target, property) {
      const value = Reflect.get(target, property, target) as unknown;
      if (typeof value !== 'function') return value;
      const method = value.bind(target) as (...args: unknown[]) => unknown;
      const hit = hits[property as keyof Store] as ((...args: unknown[]) => unknown) | undefined;
      if (!hit) return method;
      return async (...args: unknown[]) => {
        const found = hit(...args);
        return found === MISS ? method(...args) : found;
      };
    },
  });
}

const same = (a: string[], b: Array<string | undefined>) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

/** The store as a task's callback or start sees it, with what its read loaded. */
export function loadedStore(store: Store, status: TaskStatus, loaded: Loaded): Store {
  const task = status.task;
  const event = task.event;
  const has = (key: keyof Loaded) => key in loaded;
  const resolved = `connections:${task.id}:${status.generation ?? 0}:${status.attempts}:`;

  return primed(store, {
    get: (kind: StoreKind, id: string) =>
      kind === 'app' && has('app') && id === event?.appId
        ? loaded.app
        : kind === 'installation' &&
            has('installation') &&
            id === `${event?.appId}:${event?.installationId}`
          ? loaded.installation
          : kind === 'credential' && has('credential') && id === task.credential
            ? loaded.credential
            : kind === 'config' && has('config') && id === 'workspace'
              ? loaded.config
              : kind === 'runner' && has('runner') && id === task.runnerId
                ? loaded.runner
                : kind === 'snapshot' && has('secrets') && id === `connection-secrets:${task.id}`
                  ? undefined
                  : kind === 'snapshot' && has('resolved') && id.startsWith(resolved)
                    ? loaded.resolved?.id === id
                      ? loaded.resolved.value
                      : undefined
                    : MISS,
    list: (kind: StoreKind, opts?: StoreListOptions) =>
      kind === 'snapshot' && has('secrets') && opts?.prefix === `connection-secrets:${task.id}:`
        ? loaded.secrets!.rows.map((secret, index) => ({
            id: `${opts.prefix}${index}`,
            value: { secret },
          }))
        : MISS,
    listCredentials: (opts: { owner?: string; limit?: number }) =>
      has('credentials') && opts.owner === task.requestedBy && opts.limit === undefined
        ? (loaded.credentials ?? [])
        : MISS,
    heldTokens: (installations: string[], apps: string[]) =>
      has('tokens') &&
      loaded.installation &&
      same(installations, [loaded.installation.id]) &&
      same(apps, [loaded.installation.app])
        ? loaded.tokens!
        : MISS,
  });
}

/** The store as an event's dispatch sees it: the workspace's records with the linked member's own, read with the claim. */
export function dispatchStore(store: Store, loaded: DispatchLoaded, input: DispatchInput): Store {
  const own = (owner: string | undefined) => owner === undefined || owner === loaded.member?.id;
  const visible = (row: { owner?: string }, owner: string | undefined) =>
    !row.owner || row.owner === owner;

  return primed(store, {
    get: (kind: StoreKind, id: string) =>
      kind === 'agent' && id === input.agent
        ? loaded.record
        : kind === 'snapshot' && input.files.some(prefix => id.startsWith(prefix))
          ? loaded.files[id]
          : MISS,
    conversationState: (key: string) => (key === input.conversation ? loaded.conversation : MISS),
    listCredentials: (opts: { owner?: string; limit?: number }) =>
      own(opts.owner) && opts.limit === undefined
        ? loaded.credentials.filter(row => visible(row.value, opts.owner))
        : MISS,
    list: (kind: StoreKind, opts?: StoreListOptions) =>
      kind === 'runner' && opts?.defaults && !opts.runner && own(opts.visibleTo)
        ? loaded.runners.filter(row => visible(row.value, opts.visibleTo))
        : kind === 'connection' && !opts?.ids && !opts?.secrets && own(opts?.visibleTo)
          ? loaded.connections
              .filter(value => visible(value, opts?.visibleTo))
              .map(value => ({ id: value.id, value }))
          : MISS,
    heldTokens: (read: string[], drops: string[]) =>
      same(read, [input.installation.id]) && same(drops, [input.installation.app])
        ? loaded.tokens
        : MISS,
  });
}
