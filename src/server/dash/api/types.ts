import type { Me, AgentRow } from '@coder/client/types';

/** A server on this machine, using its own engine logins and config. */
export const localServer = (me: Me) => me.mode === 'local';

/** A server on this machine that platforms cannot reach yet: no public PUBLIC_URL. */
export const needsTunnel = (me: Me) =>
  localServer(me) && !/^https:\/\/(?!localhost|127\.|\[::1\])/.test(me.server?.url ?? '');

/** A workspace owner or admin, or the admin token, which has no user. */
export const isAdmin = (me: Me) =>
  !me.user || me.organization?.role === 'owner' || me.organization?.role === 'admin';

/** An integration's declared events: a list, or an object keyed by event. */
export const eventNames = (events: unknown): string[] =>
  Array.isArray(events)
    ? events.map(String)
    : events && typeof events === 'object'
      ? Object.keys(events)
      : [];

export const editableAgent = (agent: Pick<AgentRow, 'source' | 'local'>) =>
  agent.source === 'upload' || agent.source === 'home' || (agent.local && agent.source === 'repo');
