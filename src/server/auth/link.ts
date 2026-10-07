/** Signed, short-lived tokens an agent hands a platform user so they can connect their Coder account. */
import type { ServerContext } from '../context';
import { issueNonce } from './nonce';

const TTL_MS = 5 * 60 * 1000;

export interface LinkClaim {
  platform: string;
  platformUserId: string;
}

/** Stored, single-use link token issued for a platform identity. */
export function issueLinkToken(ctx: ServerContext, claim: LinkClaim): Promise<string> {
  return issueNonce(ctx, 'link-start', '*', JSON.stringify(claim), TTL_MS);
}
