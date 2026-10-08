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
