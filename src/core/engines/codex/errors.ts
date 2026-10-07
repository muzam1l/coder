/** Codex error classes coder reacts to instead of surfacing raw. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Every refresh failure codex reports starts this way; after an account switch
// a long-lived app-server still holds the old tokens and hits it on every turn.
const STALE_AUTH_PATTERN = /access token could not be refreshed/i;
const UNSUPPORTED_MODEL_PATTERN = /model is not supported|Codex cannot run model/i;

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '');
}

export function isStaleAuthError(message: string | null | undefined): boolean {
  return STALE_AUTH_PATTERN.test(message ?? '');
}

export function isUnsupportedModelError(message: string | null | undefined): boolean {
  return UNSUPPORTED_MODEL_PATTERN.test(message ?? '');
}

/** A clear replacement for an "unsupported model" 400, or null for any other error. */
export function describeUnsupportedModel(
  message: string | null | undefined,
  model?: string | null,
): string | null {
  if (!isUnsupportedModelError(message) || /Codex cannot run model/.test(message ?? '')) {
    return null;
  }
  const named = /'([^']+)' model/.exec(message ?? '')?.[1] ?? model ?? 'this model';
  return `Codex cannot run model ${named} on the signed-in account. Run \`codex login\` with an account that has it, or pick another alias (coder model list).`;
}

function codexAuthFile(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'auth.json');
}

function jwtSubject(token: unknown): string {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf8'),
    );
    return String(payload.sub ?? payload.email ?? '');
  } catch {
    return '';
  }
}

/** Account identity; the caller retains its last value across an incomplete write. */
export function codexAuthFingerprint(
  env: NodeJS.ProcessEnv = process.env,
  state?: { file?: string; mtimeMs?: number; fingerprint?: string },
): string {
  const file = codexAuthFile(env);
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return '';
  }
  if (state?.file === file && state.mtimeMs === mtimeMs) return state.fingerprint ?? '';
  try {
    const auth = JSON.parse(fs.readFileSync(file, 'utf8'));
    const apiKey = auth.OPENAI_API_KEY
      ? createHash('sha256').update(String(auth.OPENAI_API_KEY)).digest('hex')
      : '';
    const fingerprint = [
      auth.auth_mode ?? '',
      auth.tokens?.account_id ?? '',
      jwtSubject(auth.tokens?.id_token),
      apiKey,
    ].join('|');
    if (state) Object.assign(state, { file, mtimeMs, fingerprint });
    return fingerprint;
  } catch {
    return state?.file === file ? (state.fingerprint ?? '') : '';
  }
}
