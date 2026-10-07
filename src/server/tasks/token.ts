/** A task attempt's bearer token: base64url claims, a dot, then random bytes; only its hash is stored. */
import { randomBytes } from 'node:crypto';

import { decodeJson, encodeJson } from '../../utils/base64url';
import { sha256 } from '../../utils/crypto';

export interface TaskClaims {
  task?: string;
  organization?: string;
  attempt?: number;
}

export const taskTokenHash = sha256;

export function createTaskToken(
  task: string,
  organization: string,
  attempt: number,
  nonce = randomBytes(32).toString('base64url'),
): { token: string; hash: string } {
  const token = `${encodeJson({ task, organization, attempt })}.${nonce}`;
  return { token, hash: taskTokenHash(token) };
}

export function taskClaims(token: string): TaskClaims {
  try {
    return decodeJson(token.slice(0, token.indexOf('.')));
  } catch {
    return {};
  }
}
