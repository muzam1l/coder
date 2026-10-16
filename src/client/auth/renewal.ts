import { createHash } from 'node:crypto';
import { withFileLock } from '../../utils/fsx';

import { CoderError } from '../../core/dispatch';
import { savedSessions, sessionFile, writeSessions, type Session } from './session';
import { refreshSignIn } from './sign-in';

export interface Renewal {
  expiresAt(): number;
  renew(): Promise<string>;
}

/** Keeps a saved login's access token fresh, saving every rotation. */
export function renewal(server: string, login: Session): Renewal {
  let current = login;
  let pending: Promise<Session> | undefined;
  return {
    expiresAt: () => current.expiresAt,
    async renew() {
      if (!pending) {
        pending = withFileLock(
          `${sessionFile()}.${createHash('sha256').update(server).digest('hex')}.lock`,
          () => rotate(server, current),
        ).finally(() => {
          pending = undefined;
        });
      }
      current = await pending;
      return current.token;
    },
  };
}

/** A login another process already rotated is used as is; a refused refresh forgets the login. */
async function rotate(server: string, login: Session): Promise<Session> {
  const newer = (saved?: Session) =>
    saved && saved.refreshToken !== login.refreshToken ? saved : undefined;
  const saved = newer(savedSessions()[server]);
  if (saved && saved.expiresAt > login.expiresAt) return saved;
  const next = await refreshSignIn(server, login);
  const logins = savedSessions();
  if (next) {
    const renewed = { ...login, ...next };
    writeSessions({ ...logins, [server]: renewed });
    return renewed;
  }
  const rotated = newer(logins[server]);
  if (rotated) return rotated;
  delete logins[server];
  writeSessions(logins);
  throw new CoderError('login-failed', `Signed out of ${server}.`, {
    hint: 'Sign in again: coder auth login',
  });
}
