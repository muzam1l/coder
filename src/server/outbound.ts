// Outbound HTTPS to public addresses only: resolve, refuse private ones, connect to the checked address.
import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import type { ServerContext } from './context';

export type Address = { address: string; family: number };

export function privateAddress(address: string): boolean {
  if (!isIP(address)) return true;
  if (isIP(address) === 6) {
    const normalized = new URL(`https://[${address}]/`).hostname.slice(1, -1);
    const halves = normalized.split('::');
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves[1] ? halves[1].split(':') : [];
    const words = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right].map(
      word => parseInt(word, 16),
    );
    if (
      words.every(word => word === 0) ||
      (words.slice(0, 7).every(word => word === 0) && words[7] === 1)
    )
      return true;
    if (
      (words[0]! & 0xfe00) === 0xfc00 ||
      (words[0]! & 0xffc0) === 0xfe80 ||
      (words[0]! & 0xff00) === 0xff00
    )
      return true;
    let embedded: number[] | undefined;
    if (words.slice(0, 5).every(word => word === 0) && (words[5] === 0 || words[5] === 0xffff))
      embedded = words.slice(6);
    else if (words.slice(0, 4).every(word => word === 0) && words[4] === 0xffff && words[5] === 0)
      embedded = words.slice(6);
    else if ((words[4] === 0 || words[4] === 0x200) && words[5] === 0x5efe)
      embedded = words.slice(6);
    else if (
      words[0] === 0x64 &&
      words[1] === 0xff9b &&
      words.slice(2, 6).every(word => word === 0)
    )
      embedded = words.slice(6);
    else if (words[0] === 0x2002) embedded = words.slice(1, 3);
    else if (
      (words[0] === 0x2001 && (words[1] === 0 || words[1] === 0xdb8)) ||
      (words[0] === 0x64 && words[1] === 0xff9b && words[2] === 1)
    )
      return true;
    if (!embedded) return false;
    address = embedded.flatMap(word => [word >> 8, word & 255]).join('.');
  }
  const parts = address.split('.').map(Number);
  return (
    parts[0] === 0 ||
    parts[0] === 10 ||
    parts[0] === 127 ||
    (parts[0] === 169 && parts[1] === 254) ||
    (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) ||
    (parts[0] === 192 && parts[1] === 168) ||
    (parts[0] === 192 && parts[1] === 0 && (parts[2] === 0 || parts[2] === 2)) ||
    (parts[0] === 198 && parts[1]! >= 18 && parts[1]! <= 19) ||
    (parts[0] === 198 && parts[1] === 51 && parts[2] === 100) ||
    (parts[0] === 203 && parts[1] === 0 && parts[2] === 113) ||
    (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) ||
    parts[0]! >= 224
  );
}

/** The address to connect to; throws when `hostname` resolves to none or to any private one. */
export async function publicAddress(hostname: string, resolver = lookup): Promise<Address> {
  const bare = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(bare)
    ? [{ address: bare, family: isIP(bare) }]
    : await resolver(bare, { all: true });
  if (!addresses.length) throw new Error(`${bare} resolved no address`);
  if (addresses.some(item => privateAddress(item.address)))
    throw new Error('Coder refuses private and metadata addresses');

  return addresses[0]!;
}

/** One HTTPS request connected to `address` only, answered at its headers; redirects come back unfollowed, a body streaming past `limit` bytes errors. */
export function pinnedRequest(
  url: URL,
  init: RequestInit,
  address: Address,
  request = httpsRequest,
  limit = Infinity,
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      {
        method: init.method,
        headers: init.headers as Record<string, string>,
        signal: init.signal ?? undefined,
        agent: false,
        lookup: (_hostname, options, callback) => {
          if (options.all) callback(null, [address]);
          else callback(null, address.address, address.family);
        },
      },
      res => {
        let size = 0;
        let done = false;
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            const fail = (error: Error) => {
              if (done) return;
              done = true;
              controller.error(error);
              req.destroy();
            };
            res.on('data', chunk => {
              size += chunk.length;
              if (size > limit) return fail(new Error(`Response is over ${limit} bytes`));
              controller.enqueue(new Uint8Array(chunk));
            });
            res.on('error', fail);
            res.on('end', () => {
              if (!done) controller.close();
              done = true;
            });
            res.on('close', () => fail(new Error('Response ended early')));
          },
          cancel() {
            done = true;
            req.destroy();
          },
        });
        try {
          const headers = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2)
            headers.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          const empty = [204, 205, 304].includes(res.statusCode!);
          if (empty) void body.cancel();
          resolve(new Response(empty ? null : body, { status: res.statusCode, headers }));
        } catch (error) {
          req.destroy();
          reject(error);
        }
      },
    );
    req.on('error', reject);
    req.end(init.body as string | undefined);
  });
}

/** `fetch` for server probes and discovery: a host override, any address on a local server, else HTTPS to a public address only, redirects unfollowed, bodies capped at `limit` bytes. */
export function publicFetch(
  ctx: Pick<ServerContext, 'fetch' | 'local'>,
  limit = 4_000_000,
): typeof fetch {
  if (ctx.fetch) return ctx.fetch;
  if (ctx.local) return fetch;

  return (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.protocol !== 'https:') throw new Error('Coder reaches other servers over HTTPS only');
    const address = await publicAddress(url.hostname);
    const body = request.body ? await request.text() : undefined;

    return pinnedRequest(
      url,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body,
        signal: init.signal,
      },
      address,
      undefined,
      limit,
    );
  }) as typeof fetch;
}
