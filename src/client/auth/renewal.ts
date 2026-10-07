import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

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
        pending = rotateLocked(server, current).finally(() => {
          pending = undefined;
        });
      }
      current = await pending;
      return current.token;
    },
  };
}

async function rotateLocked(server: string, login: Session): Promise<Session> {
  const key = createHash('sha256').update(server).digest('hex');
  const file = `${sessionFile()}.${key}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, String(process.pid));
      } catch (error) {
        fs.unlinkSync(file);
        throw error;
      } finally {
        fs.closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(fs.readFileSync(file, 'utf8'));
        if (pid) process.kill(pid, 0);
        else if (Date.now() - fs.statSync(file).mtimeMs > 30_000) fs.unlinkSync(file);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          try {
            fs.unlinkSync(file);
          } catch {}
        }
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  try {
    return await rotate(server, login);
  } finally {
    fs.unlinkSync(file);
  }
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
