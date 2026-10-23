import type { AppRow, InstallationRow, Reach } from '@coder/client/types';

/** One agent's platform: its apps there, its live installs, and the install the platform removed. */
export type Step = {
  id: string;
  apps: Array<{ id: string; name: string }>;
  live: Array<{ id: string; app: string; account: string }>;
  /** The app whose every install was removed on the platform; Reinstall puts it back. */
  gone?: string;
  /** Where creating the agent's app starts, from `createUrl`. */
  createUrl: string;
};

/** An agent's step on one platform from its apps and installs. */
export function stepOf(
  id: string,
  apps: AppRow[],
  installations: InstallationRow[],
  createUrl: string,
): Step {
  const own = apps.filter(app => app.integration === id);
  const installs = installations.filter(entry => own.some(app => app.id === entry.app));
  const live = installs.filter(entry => !entry.uninstalled);

  return {
    id,
    apps: own.map(app => ({ id: app.id, name: app.name })),
    live: live.map(entry => ({
      id: entry.id,
      app: own.find(app => app.id === entry.app)!.name,
      account: entry.account.login,
    })),
    gone: live.length ? undefined : installs[0]?.app,
    createUrl,
  };
}

export const reachOf = (step: Step): Reach =>
  !step.apps.length ? 'none' : step.live.length ? 'installed' : 'created';
