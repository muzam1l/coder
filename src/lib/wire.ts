/**
 * Wire-protocol detection for custom (OpenAI-compatible) models, shared by
 * `coder model add/update` and by the runtime for hand-written entries: POST
 * /responses at each candidate base (a bare host may serve the API under /v1)
 * and see whether the route exists (auth/validation errors still prove it).
 */
import process from 'node:process';

import { endpointCandidates } from './config.js';
import type { CustomModelConfig } from './types.js';

export type WireDetection =
  // The route was found at baseUrl (e.g. with /v1 appended): responses means
  // codex hits `<baseUrl>/responses` directly, chat means the bridge fronts
  // `<baseUrl>/chat/completions`. Persisting both fields pins the endpoint so
  // later turns do no guessing.
  | { wireApi: 'responses' | 'chat'; baseUrl: string }
  // Reachable, but neither route proven (or nothing answered when reachable is
  // false — endpoint down, no network). Don't persist a baseUrl.
  | { wireApi: 'chat'; baseUrl?: undefined }
  | null;

// Does POSTing `route` at some candidate base prove the route exists?
// (404/405/501 = no such route; anything else — auth/validation errors
// included — proves it.) Returns the base it was found at.
async function probeRoute(
  entry: CustomModelConfig,
  route: string,
  body: Record<string, unknown>,
): Promise<{ baseUrl: string } | { reachable: boolean }> {
  const key = entry.envKey ? process.env[entry.envKey] : undefined;
  let reachable = false;
  for (const url of endpointCandidates(entry.baseUrl, route)) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      reachable = true;
      if (response.status !== 404 && response.status !== 405 && response.status !== 501) {
        return { baseUrl: url.slice(0, -(route.length + 1)) };
      }
    } catch {
      // unreachable candidate; keep trying the rest
    }
  }
  return { reachable };
}

export async function detectWireApi(entry: CustomModelConfig): Promise<WireDetection> {
  const responses = await probeRoute(entry, 'responses', {
    model: entry.model,
    input: [],
    stream: false,
  });
  if ('baseUrl' in responses) {
    return { wireApi: 'responses', baseUrl: responses.baseUrl };
  }
  const chat = await probeRoute(entry, 'chat/completions', {
    model: entry.model,
    messages: [],
    stream: false,
  });
  if ('baseUrl' in chat) {
    return { wireApi: 'chat', baseUrl: chat.baseUrl };
  }
  return responses.reachable || chat.reachable ? { wireApi: 'chat' } : null;
}
