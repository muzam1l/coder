import type { CoderConfig } from './config';

/** Built-in config every file and flag merges over; import-free so the shipped dashboard can read it. */
export const DEFAULT_CONFIG: CoderConfig = {
  // Agents are tried in order; the next one is the fallback when the previous
  // fails to start (missing binary, auth, quota, rate limit).
  chain: ['codex', 'claude'],
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
    escalationTimeoutMs: 120_000,
    allowedNetworkHosts: [],
  },
};

/** The default task list's groups: failed first, then active, then other stopped, then completed. */
export const listRank = (status: string) =>
  status === 'failed' ? 0 : status === 'completed' ? 3 : status === 'cancelled' ? 2 : 1;

/** A row's place in the task list, which keyset cursors carry. */
export type ListKey = { rank: number; createdAt: number; id: string };

/** The task list order: `listRank` groups, newest start first, ties broken by id. */
export const byListKey = (a: ListKey, b: ListKey) =>
  a.rank - b.rank || b.createdAt - a.createdAt || (b.id < a.id ? -1 : b.id > a.id ? 1 : 0);
