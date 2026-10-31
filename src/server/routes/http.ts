import type http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type ReadableStream as WebStream } from 'node:stream/web';
import { decodeJson, encodeJson } from '../../utils/crypto';

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export const paged = (url: URL) => url.searchParams.has('cursor');

export function decodeParam<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return decodeJson<T>(value);
  } catch {
    return undefined;
  }
}

export const decodeCursor = <T>(url: URL): T | undefined =>
  decodeParam<T>(url.searchParams.get('cursor'));

export function pageLimit(url: URL, fallback = 50, max = 200): number {
  const limit = Number(url.searchParams.get('limit') ?? fallback);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : fallback;
}

export function page<T>(rows: T[], limit: number, cursor: (last: T) => unknown) {
  const items = rows.slice(0, limit);
  return {
    items,
    ...(rows.length > limit ? { next: encodeJson(cursor(items.at(-1)!)) } : {}),
  };
}

export const redirect = (location: string, status = 302) =>
  new Response(null, { status, headers: { location } });

export const forbidden = () => new Response('Forbidden', { status: 403 });

export const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });

export const notAllowed = () => new Response('Method not allowed', { status: 405 });

export const toLogin = (url: URL) =>
  redirect(`/login?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`);

/** The OIDC prompt a sign-in passes on to Wular Auth; any other value is dropped. */
export function signInPrompt(url: URL): 'login' | 'select_account' | undefined {
  const prompt = url.searchParams.get('prompt');
  return prompt === 'login' || prompt === 'select_account' ? prompt : undefined;
}

export function safeReturnPath(candidate: string | null, origin: string): string {
  const value = candidate ?? '/dash';
  try {
    const target = new URL(value, origin);
    return target.origin === origin && !value.includes('\\') && !/^\/[/\\]/.test(target.pathname)
      ? `${target.pathname}${target.search}${target.hash}`
      : '/dash';
  } catch {
    return '/dash';
  }
}

export const bodyLimit = (path: string): number =>
  path.startsWith('/api/auth')
    ? 64 * 1024
    : /\/tasks\/[^/]+\/history$/.test(path)
      ? 4 * 1024 * 1024
      : 1024 * 1024;

export async function readLimited(
  body: AsyncIterable<Uint8Array>,
  declared: string | number | undefined,
  limit: number,
): Promise<Uint8Array> {
  const length = Number(declared ?? 0);
  if (Number.isFinite(length) && length > limit)
    throw Object.assign(new Error('Payload too large'), { status: 413 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.byteLength;
    if (size > limit) throw Object.assign(new Error('Payload too large'), { status: 413 });
    chunks.push(chunk);
  }

  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function headers(input: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) result.set(key, Array.isArray(value) ? value.join(', ') : value);
  return result;
}

function webRequest(req: http.IncomingMessage, signal: AbortSignal): Request {
  const path = req.url ?? '/';
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : Readable.toWeb(req);
  return new Request(`http://${req.headers.host ?? 'localhost'}${path}`, {
    method: req.method,
    headers: headers(req.headers),
    body,
    duplex: 'half',
    signal,
  } as RequestInit);
}

export function nodeListener(
  handle: (request: Request, clientIp?: string) => Promise<Response>,
  { admit = () => true }: { admit?: (incoming: http.IncomingMessage) => boolean } = {},
): http.RequestListener {
  return async (incoming, outgoing) => {
    if (!admit(incoming)) return void outgoing.writeHead(404).end('Not found');
    // A client that leaves aborts the request, so streams it opened stop.
    const left = new AbortController();
    const check = () => {
      if (incoming.socket.destroyed) left.abort();
    };
    outgoing.once('close', () => left.abort());
    check();
    try {
      const result = await handle(
        webRequest(incoming, left.signal),
        incoming.socket.remoteAddress?.replace(/^::ffff:/, ''),
      );
      check();
      const head: http.OutgoingHttpHeaders = Object.fromEntries(result.headers.entries());
      const cookies = result.headers.getSetCookie();
      if (cookies.length) head['set-cookie'] = cookies;
      outgoing.writeHead(result.status, head);
      // Streamed pages send each section as it is ready.
      if (result.body)
        await pipeline(Readable.fromWeb(result.body as unknown as WebStream), outgoing).catch(
          () => {},
        );
      else outgoing.end();
    } catch (error) {
      if (outgoing.headersSent) return void outgoing.destroy();
      const explicit = typeof error === 'object' && error && 'status' in error;
      if (!explicit) console.error('coder server: request failed', error);
      const message = explicit
        ? error instanceof Error
          ? error.message
          : String(error)
        : 'Internal server error';
      outgoing.writeHead(explicit ? Number(error.status) : 500, {
        'content-type': 'application/json',
      });
      outgoing.end(JSON.stringify({ error: message }));
    }
  };
}

export async function limitBody(req: Request, limit: number): Promise<Request | Response> {
  if (req.method === 'GET' || req.method === 'HEAD' || !req.body) return req;
  try {
    const body = await readLimited(
      req.body as unknown as AsyncIterable<Uint8Array>,
      req.headers.get('content-length') ?? undefined,
      limit,
    );
    return new Request(req.url, {
      method: req.method,
      headers: req.headers,
      body: body.byteLength ? Buffer.from(body) : undefined,
      signal: req.signal,
    });
  } catch (error) {
    if ((error as { status?: number }).status === 413)
      return new Response('Payload too large', { status: 413 });
    throw error;
  }
}

export function withCookies(response: Response, cookies: string[] = []): Response {
  if (!cookies.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export function untilSent(response: Response, end: () => void): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
}
