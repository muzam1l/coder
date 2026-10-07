import type http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type ReadableStream as WebStream } from 'node:stream/web';
import { decodeJson, encodeJson } from '../../utils/base64url';

const ADMIN_ROLES = new Set(['owner', 'admin']);

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

export const notFound = () => new Response('Not found', { status: 404 });

export const notAllowed = () => new Response('Method not allowed', { status: 405 });

export const toLogin = (url: URL) =>
  redirect(`/login?return=${encodeURIComponent(`${url.pathname}${url.search}`)}`);

export const bodyLimit = (path: string): number =>
  path.startsWith('/api/auth') ? 64 * 1024 : 1024 * 1024;

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

async function webRequest(req: http.IncomingMessage, limit: number): Promise<Request> {
  const path = req.url ?? '/';
  const body = await readLimited(req, req.headers['content-length'], limit);
  return new Request(`http://${req.headers.host ?? 'localhost'}${path}`, {
    method: req.method,
    headers: headers(req.headers),
    body: body.byteLength ? Buffer.from(body) : undefined,
  });
}

export function nodeListener(
  handle: (request: Request, clientIp?: string) => Promise<Response>,
  {
    limit,
    admit = () => true,
  }: {
    limit: (path: string) => number;
    admit?: (incoming: http.IncomingMessage) => boolean;
  },
): http.RequestListener {
  return async (incoming, outgoing) => {
    if (!admit(incoming)) return void outgoing.writeHead(404).end('Not found');
    try {
      const result = await handle(
        await webRequest(incoming, limit(incoming.url ?? '/')),
        incoming.socket.remoteAddress?.replace(/^::ffff:/, ''),
      );
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
