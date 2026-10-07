import { createHmac, randomBytes } from 'node:crypto';

import { decodeJson, encodeJson } from '../../utils/base64url';
import { safeEqual, sha256 } from '../../utils/crypto';
import type { ServerContext } from '../context';

export type NonceKind = 'create' | 'install' | 'link-start' | 'link' | 'link-oauth';

interface NonceClaim {
  kind: NonceKind;
  user: string;
  organization: string;
  target: string;
  nonce: string;
  exp: number;
}

const DEFAULT_TTL_MS = 10 * 60 * 1000;
const keyOf = (token: string) => `nonce:${sha256(token)}`;

function secret(ctx: ServerContext): string {
  const value = ctx.config.encryptionKey ?? ctx.config.adminToken;
  if (!value) throw new Error('A server secret is required to issue browser transactions.');
  return value;
}

function sign(ctx: ServerContext, payload: string): string {
  return createHmac('sha256', secret(ctx)).update(payload).digest('base64url');
}

export async function issueNonce(
  ctx: ServerContext,
  kind: NonceKind,
  user: string,
  target: string,
  ttlMs = DEFAULT_TTL_MS,
): Promise<string> {
  const now = (ctx.now ?? Date.now)();
  const claim: NonceClaim = {
    kind,
    user,
    organization: ctx.organizationId,
    target,
    nonce: randomBytes(18).toString('base64url'),
    exp: now + ttlMs,
  };
  const payload = encodeJson(claim);
  const token = `${payload}.${sign(ctx, payload)}`;
  await ctx.store.put('delivery', keyOf(token), { at: now }, { ttlMs });
  return token;
}

function read(ctx: ServerContext, token: string): NonceClaim | undefined {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return undefined;
  if (!safeEqual(sign(ctx, payload), signature)) return undefined;
  try {
    return decodeJson<NonceClaim>(payload);
  } catch {
    return undefined;
  }
}

/** The organization a transaction was issued in, from its signed claim. */
export function nonceOrganization(ctx: ServerContext, token: string): string | undefined {
  return read(ctx, token)?.organization;
}

/** The user a transaction was issued to, from its signed claim; `*` for an operator's. */
export function nonceUser(ctx: ServerContext, token: string): string | undefined {
  return read(ctx, token)?.user;
}

/** Verify every binding and atomically consume the stored transaction. */
export async function consumeNonce(
  ctx: ServerContext,
  token: string,
  kind: NonceKind,
  user: string,
  target: string,
): Promise<boolean> {
  const claim = read(ctx, token);
  const now = (ctx.now ?? Date.now)();
  if (
    !claim ||
    claim.kind !== kind ||
    claim.user !== user ||
    claim.organization !== ctx.organizationId ||
    claim.target !== target ||
    claim.exp < now
  )
    return false;
  return ctx.store.take('delivery', keyOf(token));
}

export async function consumeBoundNonce(
  ctx: ServerContext,
  token: string,
  kind: NonceKind,
  user: string,
): Promise<string | undefined> {
  const claim = read(ctx, token);
  const now = (ctx.now ?? Date.now)();
  if (
    !claim ||
    claim.kind !== kind ||
    (claim.user !== '*' && claim.user !== user) ||
    claim.organization !== ctx.organizationId ||
    claim.exp < now ||
    !(await ctx.store.take('delivery', keyOf(token)))
  )
    return undefined;
  return claim.target;
}

export async function inspectNonce(
  ctx: ServerContext,
  token: string,
  kind: NonceKind,
  user: string,
): Promise<string | undefined> {
  const claim = read(ctx, token);
  const now = (ctx.now ?? Date.now)();
  if (
    !claim ||
    claim.kind !== kind ||
    (claim.user !== '*' && claim.user !== user) ||
    claim.organization !== ctx.organizationId ||
    claim.exp < now ||
    !(await ctx.store.get('delivery', keyOf(token)))
  )
    return undefined;
  return claim.target;
}
