import { ServerClient, ClientError } from '@coder/client';
import { CoderError } from '@coder/core/errors';
import type { StoredRow } from '@coder/client/types';

declare global {
  var __coder: { handle(request: Request): Promise<Response> } | undefined;
}

export function encodeDefinition(definition: unknown): string {
  return Buffer.from(JSON.stringify(definition), 'utf8').toString('base64url');
}

const clientKey = Symbol('coder.dashboard.client');
type RenderRequest = Request & { [clientKey]?: ServerClient };

/** One client per render request, with shared in-process GETs and the caller's cookie and scope. */
export function load(request: Request): ServerClient {
  const render = request as RenderRequest;
  let client = render[clientKey];
  if (client) return client;
  const reads = new Map<string, Promise<Response>>();
  client = new ServerClient(
    '',
    { cookie: true },
    {
      fetch: async (input, init) => {
        const handle = globalThis.__coder?.handle;
        if (!handle)
          throw new CoderError('server', 'Dashboard server is not ready.', { status: 503 });
        const url = new URL(String(input), request.url).href;
        const headers = new Headers(init?.headers);
        headers.set('cookie', request.headers.get('cookie') ?? '');
        const scope = request.headers.get('x-coder-request-scope');
        if (scope) headers.set('x-coder-request-scope', scope);
        const read = !init?.method || init.method === 'GET';
        let pending = read ? reads.get(url) : undefined;
        if (!pending) {
          pending = handle(new Request(url, { ...init, headers }));
          if (read) reads.set(url, pending);
          pending.catch(error =>
            console.error(`dashboard load failed: ${init?.method ?? 'GET'} ${url}`, error),
          );
        }
        return (await pending).clone();
      },
    },
  );
  render[clientKey] = client;
  return client;
}

export const signedOut = (error: unknown) =>
  error instanceof ClientError &&
  error.status === 401 &&
  !/^Bearer(?:\s|$)/i.test(error.authenticate ?? '');

export const unwrap = <T>(rows: Array<StoredRow<T>>) => rows.map(row => row.value);
export function loadAgent(request: Request, slug: string) {
  const path = new URL(request.url).pathname;
  const content = path === `/dash/agents/${encodeURIComponent(slug)}` || path.endsWith('/edit');
  return load(request).agents.get(slug, { versions: false, content });
}
