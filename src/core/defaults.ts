import type { CoderConfig } from './config';

/** Built-in config every file and flag merges over; import-free so the shipped dashboard can read it. */
export const DEFAULT_CONFIG: CoderConfig = {
  // Agents are tried in order; the next one is the fallback when the previous
  // fails to start (missing binary, auth, quota, rate limit).
  chain: ['codex', 'claude', 'custom'],
  engines: {
    codex: {
      model: 'gpt-6.1-sol',
      effort: 'high',
      permissions: 'auto',
    },
    claude: {
      model: 'opus',
      effort: 'medium',
      permissions: 'auto',
    },
  },
  models: {},
  approvals: {
    allowedNetworkHosts: [],
  },
};

/** The engine an agent runs on when its settings name none. */
export const DEFAULT_ENGINE = DEFAULT_CONFIG.chain[0]!;

/** The final message that posts nothing. */
export const EMPTY_MESSAGE = '__EMPTY__';
/** The task log line when the agent declined to reply. */
export const SKIPPED = 'Skipped: the agent chose not to reply.';
/** What the platform gets when the agent declined a reply that was due. */
export const EMPTY_MESSAGE_NOTICE = 'The agent returned no reply.';

/** The default task list's groups: failed first, then active, then other stopped, then completed. */
export const listRank = (status: string) =>
  status === 'failed' ? 0 : status === 'completed' ? 3 : status === 'cancelled' ? 2 : 1;

/** Whether a task waits on a person: its turn waits, or an escalation is open whatever its turn does. */
export const awaitsApproval = (
  status: string,
  approvals?: ReadonlyArray<{ response?: unknown }> | null,
) => status === 'waiting' || Boolean(approvals?.some(approval => !approval.response));

/** A row's place in the task list, which keyset cursors carry. */
export type ListKey = { rank: number; createdAt: number; id: string };

/** Ids in byte order, as Postgres `collate "C"` compares them. */
export const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The task list order: `listRank` groups, newest start first, ties broken by id. */
export const byListKey = (a: ListKey, b: ListKey) =>
  a.rank - b.rank || b.createdAt - a.createdAt || byId(b.id, a.id);

/** RFC 7396 merge patch: objects merge, null deletes, anything else replaces; `__proto__` stays a plain key. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const result: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target)
      ? Object.fromEntries(Object.entries(target))
      : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else
      Object.defineProperty(result, key, {
        value: mergePatch(Object.hasOwn(result, key) ? result[key] : undefined, value),
        writable: true,
        enumerable: true,
        configurable: true,
      });
  }
  return result as T;
}
