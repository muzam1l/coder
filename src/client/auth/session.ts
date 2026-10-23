/** Sessions `coder auth login` keeps per server, under ~/.coder/session.json. */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { CoderError } from '../../core/errors';
import { coderHome } from '../../core/state';
import { withFileLock } from '../../utils/fsx';
import { taskSocket, validateUrl } from '../http';

export interface Session {
  /** Wular Auth access token for this server. */
  token: string;
  refreshToken: string;
  /** When `token` expires, epoch milliseconds. */
  expiresAt: number;
  /** The Wular Auth issuer that signed the tokens. */
  issuer: string;
  user: { name: string; email: string };
  organization?: { id: string; name: string; slug: string };
  at: number;
}

type ServerRecord = Partial<Session> & { confirmedAt?: number };

export function sessionFile(): string {
  return coderHome('session.json');
}

export function savedSessions(): Record<string, Session> {
  try {
    const records = JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as Record<
      string,
      ServerRecord
    >;
    return Object.fromEntries(
      Object.entries(records).filter((entry): entry is [string, Session] =>
        Boolean(entry[1].token && entry[1].refreshToken && entry[1].user),
      ),
    );
  } catch {
    return {};
  }
}

function serverRecords(): Record<string, ServerRecord> {
  try {
    return JSON.parse(fs.readFileSync(sessionFile(), 'utf8')) as Record<string, ServerRecord>;
  } catch {
    return {};
  }
}

const normalizeServer = (url: string) => url.replace(/\/+$/, '');

export const DEFAULT_SERVER = 'https://coder.wular.ai';

export const resolveServer = (option?: string | true) =>
  normalizeServer(
    (option === true ? undefined : option) ?? process.env.CODER_SERVER ?? DEFAULT_SERVER,
  );

export function validateServer(option?: string | true): string {
  const server = resolveServer(option);

  return taskSocket() && server === process.env.CODER_SERVER ? server : validateUrl(server);
}

/** The hosted service and a cloud task's own server are trusted by construction; any other origin is confirmed on first use. */
export function isKnownServer(server: string): boolean {
  const key = normalizeServer(server);
  const own = process.env.CODER_MCP_MODE === 'cloud' && process.env.CODER_SERVER;
  return (
    key === DEFAULT_SERVER || (own && key === normalizeServer(own)) || Boolean(serverRecords()[key])
  );
}

export function rememberServer(server: string): void {
  const records = serverRecords();
  const key = normalizeServer(server);
  const current = records[key] ?? {};
  writeServerRecords({ ...records, [key]: { ...current, confirmedAt: Date.now() } });
}

export function savedSession(server: string): Session | undefined {
  return savedSessions()[normalizeServer(server)];
}

export function writeSessions(logins: Record<string, Session>): void {
  const records = serverRecords();
  const confirmations = Object.fromEntries(
    Object.entries(records).map(([server, record]) => [
      server,
      { confirmedAt: record.confirmedAt ?? Date.now() },
    ]),
  );
  writeServerRecords(
    Object.fromEntries(
      Object.entries({ ...confirmations, ...logins }).map(([server, record]) => [
        server,
        {
          ...record,
          ...(records[server] ? { confirmedAt: records[server].confirmedAt ?? Date.now() } : {}),
        },
      ]),
    ),
  );
}

function writeServerRecords(logins: Record<string, ServerRecord>): void {
  const file = sessionFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(logins, null, 2)}\n`, {
    mode: 0o600,
  });
  fs.chmodSync(file, 0o600);
}

interface Renewal {
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
  const { refreshSignIn } = await import('./sign-in');
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
