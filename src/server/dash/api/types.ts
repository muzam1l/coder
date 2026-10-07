import type { Me, AgentRow } from '@coder/client/types';

/** A server on this machine, using its own engine logins and config. */
export const localServer = (me: Me) => me.mode === 'local';

/** A server on this machine that platforms cannot reach yet: no public PUBLIC_URL. */
export const needsTunnel = (me: Me) =>
  localServer(me) && !/^https:\/\/(?!localhost|127\.|\[::1\])/.test(me.server?.url ?? '');

export const editableAgent = (agent: Pick<AgentRow, 'source' | 'local'>) =>
  agent.source === 'upload' || agent.source === 'home' || (agent.local && agent.source === 'repo');
