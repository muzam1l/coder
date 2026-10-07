/** Sessions `coder auth login` keeps per server, under ~/.coder/session.json. */
import fs from 'node:fs';
import path from 'node:path';

import { coderHome } from '../../core/state';
import { validateUrl } from '..';

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

export const normalizeServer = (url: string) => url.replace(/\/+$/, '');

export const DEFAULT_SERVER = 'https://coder.wular.ai';

export const resolveServer = (option?: string | true) =>
  normalizeServer(
    (option === true ? undefined : option) ?? process.env.CODER_SERVER ?? DEFAULT_SERVER,
  );

export function validateServer(option?: string | true): string {
  return validateUrl(resolveServer(option));
}

/** The hosted service is trusted by construction; any other origin is confirmed on first use. */
export function isKnownServer(server: string): boolean {
  const key = normalizeServer(server);
  return key === DEFAULT_SERVER || Boolean(serverRecords()[key]);
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
