/** What a task's runner receives, by who operates its machine: the one policy table behind `taskContext` and the callbacks, in place of checks per call site. */
import type { AgentTask, RunnerTrust } from '../../agent/types';

export interface Grants {
  /** The workspace's engine credentials, beside the asker's own. */
  workspaceCredentials: boolean;
  /** The workspace's connections, beside the asker's own. */
  workspaceConnections: boolean;
  /** Tokens for the agent's other installations and its skill repositories, beside the event's own. */
  otherInstallations: boolean;
  /** The event installation's token: narrowed to the task's tools, or to the integration's read-only preset. */
  eventToken: 'tools' | 'read-only';
  /** A checks-write token on the event's pull request repository. */
  checks: boolean;
  /** Which of its credentials a task's rotated Codex `auth.json` may rewrite. */
  writeBack: 'granted' | 'asker' | 'none';
}

export const GRANTS: Record<RunnerTrust, Grants> = {
  workspace: {
    workspaceCredentials: true,
    workspaceConnections: true,
    otherInstallations: true,
    eventToken: 'tools',
    checks: true,
    writeBack: 'granted',
  },
  member: {
    workspaceCredentials: false,
    workspaceConnections: false,
    otherInstallations: false,
    eventToken: 'read-only',
    checks: false,
    writeBack: 'asker',
  },
  external: {
    workspaceCredentials: false,
    workspaceConnections: false,
    otherInstallations: false,
    eventToken: 'read-only',
    checks: false,
    writeBack: 'none',
  },
};

/** The trust fixed at a task's admission; one admitted on a stored runner before trust existed is a member's. */
export function taskTrust(task: Pick<AgentTask, 'trust' | 'runnerId'>): RunnerTrust {
  return task.trust ?? (task.runnerId ? 'member' : 'workspace');
}

export function taskGrants(task: Pick<AgentTask, 'trust' | 'runnerId'>): Grants {
  return GRANTS[taskTrust(task)];
}

/** The owners whose credentials a task may receive, best first: the asker, then the workspace where granted. */
export function credentialOwners(grants: Grants, asker?: string): Array<string | undefined> {
  return [...(asker ? [asker] : []), ...(grants.workspaceCredentials ? [undefined] : [])];
}

/** Whether a task may receive a connection: the asker's own always, the workspace's where granted. */
export function connectionGranted(
  grants: Grants,
  connection: { owner?: string },
  asker?: string,
): boolean {
  return connection.owner ? connection.owner === asker : grants.workspaceConnections;
}

/** The message a member reads when none of their own credentials runs a task on their runner. */
export const NO_GRANTED_CREDENTIAL =
  'No credential of yours runs this task on your runner. Add one under Settings → Credentials, or use a workspace runner.';
