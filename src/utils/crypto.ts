import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison of two strings or byte buffers; different lengths are unequal. */
export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = typeof a === 'string' ? Buffer.from(a) : a;
  const right = typeof b === 'string' ? Buffer.from(b) : b;
  return left.length === right.length && timingSafeEqual(left, right);
}

export const sha256 = (value: string): string =>
  createHash('sha256').update(value).digest('base64url');

export const encodeJson = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

/** Throws on input that is not base64url JSON. */
export const decodeJson = <T>(value: string): T =>
  JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
