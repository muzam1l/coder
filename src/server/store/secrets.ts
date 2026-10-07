import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import * as z from 'zod/mini';

import type { EngineCredential } from './types';
import type { ServerConfig } from '../context';

const credentialSchema = z.object({
  env: z.record(z.string(), z.string().check(z.minLength(1))),
});
type CredentialEnv = Pick<EngineCredential, 'env'>;

export type EncryptedCredential = {
  iv: string;
  tag: string;
  ciphertext: string;
};

const PLAIN = 'plain';

function decodeKey(value: string | undefined, name = 'SERVER_ENCRYPTION_KEY'): Buffer | undefined {
  if (!value) return undefined;
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== 32) throw new Error(`${name} must be a base64-encoded 32-byte key`);
  return decoded;
}

function key(config: Pick<ServerConfig, 'encryptionKey'>): Buffer | undefined {
  return decodeKey(config.encryptionKey);
}

export function keyVersion(value: string | undefined): number {
  const decoded = decodeKey(value);
  return decoded ? createHash('sha256').update(decoded).digest().readInt32BE(0) : 0;
}

function keys(config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>) {
  return [
    [config.encryptionKey, 'SERVER_ENCRYPTION_KEY'],
    [config.previousEncryptionKey, 'SERVER_ENCRYPTION_KEY_PREVIOUS'],
  ]
    .filter((entry): entry is [string, string] => Boolean(entry[0]))
    .map(([value, name]) => ({
      value: decodeKey(value, name)!,
      version: keyVersion(value),
    }));
}

function checked(credential: CredentialEnv): CredentialEnv {
  const parsed = credentialSchema.safeParse(credential);
  if (!parsed.success || !Object.keys(parsed.data.env).length)
    throw new Error('Invalid engine credential');
  return parsed.data;
}

export function encryptCredential(
  config: Pick<ServerConfig, 'encryptionKey'>,
  credential: CredentialEnv,
): EncryptedCredential {
  const k = key(config);
  if (!k)
    return {
      iv: PLAIN,
      tag: '',
      ciphertext: Buffer.from(JSON.stringify(checked(credential))).toString('base64'),
    };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(checked(credential)), 'utf8'),
    cipher.final(),
  ]);
  return {
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function decryptCredential(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  value: EncryptedCredential,
): CredentialEnv {
  if (value.iv === PLAIN)
    return checked(JSON.parse(Buffer.from(value.ciphertext, 'base64').toString('utf8')));
  for (const candidate of keys(config)) {
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        candidate.value,
        Buffer.from(value.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
      return checked(
        JSON.parse(
          Buffer.concat([
            decipher.update(Buffer.from(value.ciphertext, 'base64')),
            decipher.final(),
          ]).toString('utf8'),
        ),
      );
    } catch {}
  }
  throw new Error('Stored credential was sealed with an unavailable encryption key');
}

/** Encrypt any JSON value (app credentials, tokens) to an opaque string. */
export function encryptSecret(config: Pick<ServerConfig, 'encryptionKey'>, value: unknown): string {
  const k = key(config);
  if (!k) return `${PLAIN}.${Buffer.from(JSON.stringify(value)).toString('base64')}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map(part => part.toString('base64')).join('.');
}

export function decryptSecret<T = unknown>(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  value: string,
): T {
  if (value.startsWith(`${PLAIN}.`))
    return JSON.parse(Buffer.from(value.slice(PLAIN.length + 1), 'base64').toString('utf8')) as T;
  const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64'));
  for (const candidate of keys(config)) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', candidate.value, iv!);
      decipher.setAuthTag(tag!);
      return JSON.parse(
        Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString('utf8'),
      ) as T;
    } catch {}
  }
  throw new Error('Stored secret was sealed with an unavailable encryption key');
}

export function secretKeyVersion(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
  value: string,
): number {
  if (value.startsWith(`${PLAIN}.`)) return 0;
  const [iv, tag, ciphertext] = value.split('.').map(part => Buffer.from(part, 'base64'));
  for (const candidate of keys(config)) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', candidate.value, iv!);
      decipher.setAuthTag(tag!);
      decipher.update(ciphertext!);
      decipher.final();
      return candidate.version;
    } catch {}
  }
  throw new Error('Stored secret was sealed with an unavailable encryption key');
}
