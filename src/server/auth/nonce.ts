import { createHmac, randomBytes } from 'node:crypto';

import { decodeJson, encodeJson } from '../../utils/base64url';
import { safeEqual, sha256 } from '../../utils/crypto';
import type { ServerContext } from '../context';

export type NonceKind =
  'create' | 'install' | 'link-start' | 'link' | 'link-oauth' | 'connection-oauth' | 'native-oauth';

interface NonceClaim {
  kind: NonceKind;
  user: string;
  organization: string;
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
    nonce: randomBytes(18).toString('base64url'),
    exp: now + ttlMs,
  };
  const payload = encodeJson(claim);
  const token = `${payload}.${sign(ctx, payload)}`;
  await ctx.store.put('delivery', keyOf(token), { at: now, target }, { ttlMs });
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

async function storedTarget(ctx: ServerContext, token: string): Promise<string | undefined> {
  const record = await ctx.store.get('delivery', keyOf(token));
  return record && 'target' in record ? record.target : undefined;
}

/** The organization a transaction was issued in, from its signed claim. */
export function nonceOrganization(ctx: ServerContext, token: string): string | undefined {
  return read(ctx, token)?.organization;
}

/** The user a transaction was issued to, from its signed claim; `*` for an operator's. */
export function nonceUser(ctx: ServerContext, token: string): string | undefined {
  return read(ctx, token)?.user;
}

function claimOf(
  ctx: ServerContext,
  token: string,
  kind: NonceKind,
  user: string,
  operator = true,
): NonceClaim | undefined {
  const claim = read(ctx, token);
  return claim &&
    claim.kind === kind &&
    (claim.user === user || (operator && claim.user === '*')) &&
    claim.organization === ctx.organizationId &&
    claim.exp >= (ctx.now ?? Date.now)()
    ? claim
    : undefined;
}

/** Verify every binding and atomically consume the stored transaction. */
export async function consumeNonce(
  ctx: ServerContext,
  token: string,
  kind: NonceKind,
  user: string,
  target: string,
): Promise<boolean> {
  if (!claimOf(ctx, token, kind, user, false)) return false;
  const record = await ctx.store.take('delivery', keyOf(token), { target });
  return !!record && 'target' in record && record.target === target;
}

export async function consumeBoundNonce(
  ctx: ServerContext,
  token: string,
  kind: NonceKind,
  user: string,
): Promise<string | undefined> {
  if (!claimOf(ctx, token, kind, user)) return;
  const record = await ctx.store.take('delivery', keyOf(token));
  return record && 'target' in record ? record.target : undefined;
}

export async function inspectNonce(
  ctx: ServerContext,
  token: string,
  kind: NonceKind,
  user: string,
): Promise<string | undefined> {
  return claimOf(ctx, token, kind, user) ? storedTarget(ctx, token) : undefined;
}
