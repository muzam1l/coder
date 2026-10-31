/** What a runner machine receives at start, and the signature on the server's calls to an `http` runner. Every transport goes through here. */
import { createHmac, randomBytes } from 'node:crypto';
import type { JWTVerifyGetKey } from 'jose';

import { runnerHash, runnerTarball } from '../server/runners/package';
import { safeEqual } from '../utils/crypto';

/** How far a signed call's time may be from the runner's clock. */
export const SIGNATURE_WINDOW_MS = 5 * 60 * 1000;

/** The variables a machine calls the server back with, narrowed from `env`. */
export function taskEnv(env: Record<string, string | undefined>): Record<string, string> {
  return {
    CODER_SERVER: env.CODER_SERVER ?? '',
    CODER_TASK_TOKEN: env.CODER_TASK_TOKEN ?? '',
    CODER_INBOX_MODE: env.CODER_INBOX_MODE === 'push' ? 'push' : 'poll',
    ...(env.CODER_LOGIN === 'claude' || env.CODER_LOGIN === 'codex'
      ? { CODER_LOGIN: env.CODER_LOGIN }
      : {}),
  };
}

/** What a machine starts with: `taskEnv`, the runner package it downloads and the hash that download must match. */
export function startEnv(env: Record<string, string | undefined>): Record<string, string> {
  const task = taskEnv(env);

  return {
    ...task,
    CODER_RUNNER_TARBALL_URL: runnerTarball(task.CODER_SERVER!),
    CODER_RUNNER_HASH: runnerHash(),
  };
}

const signature = (
  secret: string,
  method: string,
  path: string,
  body: string,
  timestamp: string,
  nonce: string,
) =>
  createHmac('sha256', secret)
    .update(`${method}\n${path}\n${body}.${timestamp}.${nonce}`)
    .digest('base64url');

/** The headers that sign one call to an `http` runner over its method, path, body, time and a fresh nonce. */
export function sign(
  secret: string,
  method: string,
  path: string,
  body: string,
  now = Date.now(),
): Record<string, string> {
  const timestamp = String(now);
  const nonce = randomBytes(16).toString('base64url');

  return {
    'x-coder-timestamp': timestamp,
    'x-coder-nonce': nonce,
    'x-coder-signature': signature(secret, method, path, body, timestamp, nonce),
  };
}

/** The nonce and time of `req` when `sign` signed it with `secret` within the window of `now`. The caller refuses a nonce it has seen. */
export function verify(
  secret: string,
  req: Request,
  body: string,
  now: number,
): { nonce: string; at: number } | undefined {
  const timestamp = req.headers.get('x-coder-timestamp') ?? '';
  const nonce = req.headers.get('x-coder-nonce') ?? '';
  const at = Number(timestamp);
  if (!nonce || !Number.isFinite(at) || Math.abs(now - at) > SIGNATURE_WINDOW_MS) return undefined;
  const expected = signature(secret, req.method, new URL(req.url).pathname, body, timestamp, nonce);

  return safeEqual(req.headers.get('x-coder-signature') ?? '', expected)
    ? { nonce, at }
    : undefined;
}

/** Who signs a GitHub Actions job's OIDC token. */
export const ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';

/** A check of GitHub Actions OIDC tokens: the repository and run a token issued for `audience` names, with GitHub's keys fetched through `request` and kept an hour. */
export function actionsJobs(request: typeof fetch) {
  let keys: JWTVerifyGetKey | undefined;

  return async (
    token: string,
    audience: string,
  ): Promise<{ repository: string; run: string } | undefined> => {
    const { createRemoteJWKSet, customFetch, jwtVerify } = await import('jose');
    keys ??= createRemoteJWKSet(new URL('/.well-known/jwks', ACTIONS_ISSUER), {
      [customFetch]: request,
      cacheMaxAge: 60 * 60_000,
    });
    const verified = await jwtVerify(token, keys, {
      issuer: ACTIONS_ISSUER,
      audience,
      algorithms: ['RS256'],
    }).catch(() => undefined);
    const { repository, run_id: run } = verified?.payload ?? {};

    return typeof repository === 'string' && typeof run === 'string'
      ? { repository, run }
      : undefined;
  };
}

/** Trades the claim code an Actions job was dispatched with, and the job's OIDC token as proof of its run, for task `id`'s token, once. Neither stays in `env` for the engine. */
export async function redeemClaim(id: string, env = process.env): Promise<string> {
  const server = env.CODER_SERVER!.replace(/\/+$/, '');
  const proof = await fetch(
    `${env.ACTIONS_ID_TOKEN_REQUEST_URL}&audience=${encodeURIComponent(server)}`,
    {
      headers: { authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!proof.ok) throw new Error(`GitHub gave no OIDC token: HTTP ${proof.status}`);
  const { value: identity } = (await proof.json()) as { value: string };
  const claim = env.CODER_TASK_CLAIM;
  delete env.CODER_TASK_CLAIM;
  delete env.ACTIONS_ID_TOKEN_REQUEST_URL;
  delete env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  // The server learns the run a moment after the job may ask, and answers 409 until then.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${server}/tasks/${encodeURIComponent(id)}/claim`, {
      method: 'POST',
      signal: AbortSignal.timeout(30_000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim, identity }),
    });
    if (response.status === 409 && attempt < 10) {
      await new Promise(resolve => setTimeout(resolve, 3000));
      continue;
    }
    if (!response.ok) throw new Error(`The task claim was refused: HTTP ${response.status}`);

    return ((await response.json()) as { token: string }).token;
  }
}
