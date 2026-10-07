/** Session and client keys, derived with HKDF from SERVER_ENCRYPTION_KEY (and its previous value while rotating). */
import { createECDH, hkdfSync } from 'node:crypto';

import { calculateJwkThumbprint, type JWK } from 'jose';

import type { ServerConfig } from '../context';

const derive = (secret: string, info: string) =>
  new Uint8Array(hkdfSync('sha256', secret, '', info, 32));

// An ES256 key whose private scalar is derived, so every instance signs with the same key.
async function clientKey(secret: string) {
  const d = derive(secret, 'coder oidc client key');
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(d);
  const point = ecdh.getPublicKey();
  const jwk: JWK = {
    kty: 'EC',
    crv: 'P-256',
    x: Buffer.from(point.subarray(1, 33)).toString('base64url'),
    y: Buffer.from(point.subarray(33)).toString('base64url'),
  };
  const key = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, d: Buffer.from(d).toString('base64url') },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const kid = await calculateJwkThumbprint(jwk);
  return { key, kid, jwk: { ...jwk, kid, alg: 'ES256', use: 'sig' } };
}

export interface AuthKeys {
  /** Session cookie keys, current first. */
  cookie: Uint8Array[];
  /** private_key_jwt signing key and the public keys the client metadata publishes. */
  client: { key: CryptoKey; kid: string };
  jwks: { keys: JWK[] };
}

export async function authKeys(
  config: Pick<ServerConfig, 'encryptionKey' | 'previousEncryptionKey'>,
): Promise<AuthKeys> {
  const secrets = [config.encryptionKey!, config.previousEncryptionKey].filter(
    (secret): secret is string => Boolean(secret),
  );
  const clients = await Promise.all(secrets.map(clientKey));
  return {
    cookie: secrets.map(secret => derive(secret, 'coder session cookie')),
    client: clients[0]!,
    jwks: { keys: clients.map(client => client.jwk) },
  };
}
