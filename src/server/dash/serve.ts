import path from 'node:path';
import { match, type Params } from '../routes/match';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  brotliDecompressSync,
  constants,
  createGzip,
  gunzipSync,
  gzipSync,
  inflateSync,
} from 'node:zlib';
import { type ServerContext } from '../context';
import { INTEGRATIONS } from '../../integrations';
import { sameToken, serverMode } from '../routes/guards';
import { notFound, redirect, safeReturnPath } from '../routes/http';

declare global {
  var __coder: { handle(request: Request): Promise<Response> } | undefined;
}

export type Manifest = {
  root: string;
  appDir?: string;
  outDir?: string;
  routes: Array<{ route: string }>;
  [key: string]: unknown;
};
type RequestHandler = (request: Request) => Promise<Response>;
type DashHost = {
  handler: RequestHandler;
  manifest: Manifest;
};

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  // Create forms post to the platforms themselves, such as GitHub's app manifest.
  `form-action ${["'self'", ...new Set(Object.values(INTEGRATIONS).flatMap(each => each.app.postOrigins ?? []))].join(' ')}`,
];

function packageRoot(moduleUrl: string): string {
  let directory = path.dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const file = path.join(directory, 'package.json');
    if (existsSync(file)) {
      try {
        if (JSON.parse(readFileSync(file, 'utf8')).name === '@wular/coder') return directory;
      } catch {}
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error('Cannot locate the Coder package root.');
}

function resolveDashRoot(moduleUrl = import.meta.url): string | undefined {
  const moduleDirectory = path.dirname(fileURLToPath(moduleUrl));
  const root = packageRoot(moduleUrl);
  // A literal URL beside the bundled chunk, so an app's tracer ships the dash with this package.
  const bundled = fileURLToPath(new URL('./dash/standalone/server/entry.js', import.meta.url));
  const candidates = [
    path.resolve(bundled, '../../..'),
    path.join(root, 'dist/dash'),
    path.join(moduleDirectory, '../dash'),
  ];
  return candidates.find(candidate => existsSync(manifestFile(candidate)));
}

const manifestFile = (dashRoot: string) => path.join(dashRoot, 'standalone/server/manifest.json');

export function serverEntry(root: string): string {
  const entry = path.join(root, 'standalone/server/entry.js');
  if (!existsSync(entry)) throw new Error('The Coder dashboard server bundle is missing.');
  return entry;
}

// The build's standalone folder serves itself; root only scopes .env loading, so it stays inside the build.
async function createDashHost(dashRoot: string): Promise<DashHost> {
  const manifest = JSON.parse(readFileSync(manifestFile(dashRoot), 'utf8')) as Manifest;
  const entry = (await import(pathToFileURL(serverEntry(dashRoot)).href)) as {
    createRequestHandler(options: { root: string }): Promise<RequestHandler>;
  };
  return {
    handler: await entry.createRequestHandler({ root: path.join(dashRoot, 'standalone') }),
    manifest,
  };
}

/** How often a request looks for a newer build. */
const RECHECK_MS = 1000;

/** The dashboard host, replaced once a rebuild lands so a running server serves it. */
export class DashboardHosts {
  private root?: string;
  private loaded?: { host: Promise<DashHost>; build?: number; checked: number };

  constructor(private readonly moduleUrl = import.meta.url) {}

  /** Undefined while no build is complete. */
  host(): Promise<DashHost> | undefined {
    const now = Date.now();
    const loaded = this.loaded;
    if (loaded && now - loaded.checked < RECHECK_MS) return loaded.host;
    this.root ??= resolveDashRoot(this.moduleUrl);
    if (!this.root) return undefined;
    let build: number | undefined;
    try {
      build = statSync(manifestFile(this.root)).mtimeMs;
    } catch {}
    if (loaded) {
      loaded.checked = now;
      if (build === undefined || build === loaded.build) return loaded.host;
    }
    const next = { build, checked: now, host: createDashHost(this.root) };
    next.host.catch(() => {
      if (this.loaded === next) this.loaded = undefined;
    });
    this.loaded = next;
    return next.host;
  }
}

const normalize = (pathname: string) =>
  pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;

export function knownRoute(pathname: string, manifest: Manifest): boolean {
  const normalized = normalize(pathname);
  return Boolean(
    match('/assets/*', normalized) ||
    match('/dash/*', normalized) ||
    manifest.routes.some(route => match(route.route, normalized)),
  );
}

/** Whether `pathname` is a page of the dashboard build being served. */
export async function dashPage(pathname: string, hosts = new DashboardHosts()): Promise<boolean> {
  const host = await hosts.host()?.catch(() => undefined);
  return Boolean(host?.manifest.routes.some(route => match(route.route, normalize(pathname))));
}

const INLINE_SCRIPT = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;

const sha256 = (script: string) =>
  `'sha256-${createHash('sha256').update(script).digest('base64')}'`;

/** A prerendered page's policy: every inline script it carries, by hash. */
function contentSecurityPolicy(html: string): string {
  const hashes = [...html.matchAll(INLINE_SCRIPT)].map(match => sha256(match[1]!));
  return [...CSP, `script-src 'self' ${hashes.join(' ')}`.trim()].join('; ');
}

function decodeBody(bytes: Buffer, encoding: string | null): string {
  if (encoding === 'gzip') return gunzipSync(bytes).toString('utf8');
  if (encoding === 'br') return brotliDecompressSync(bytes).toString('utf8');
  if (encoding === 'deflate') return inflateSync(bytes).toString('utf8');
  return bytes.toString('utf8');
}

/** Whether the client takes gzip, honouring `q=0` refusals. */
const wantsGzip = (request: Request) =>
  (request.headers.get('accept-encoding') ?? '').split(',').some(part => {
    const [name, ...params] = part.split(';').map(piece => piece.trim());
    const q = params.find(param => param.startsWith('q='));
    return name === 'gzip' && (!q || Number(q.slice(2)) > 0);
  });

function markGzip(headers: Headers) {
  headers.set('content-encoding', 'gzip');
  if (!/accept-encoding/i.test(headers.get('vary') ?? ''))
    headers.append('vary', 'accept-encoding');
}

/** Gzip that flushes after every chunk, so each streamed section leaves at once. */
function gzipStream(rest: ReadableStreamDefaultReader<Uint8Array>): ReadableStream<Uint8Array> {
  const gzip = createGzip();
  const write = (chunk: Uint8Array) =>
    new Promise<void>(resolve => {
      gzip.write(chunk);
      gzip.flush(constants.Z_SYNC_FLUSH, () => resolve());
    });
  let ended = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      gzip.on('data', (data: Buffer) => controller.enqueue(new Uint8Array(data)));
      gzip.on('end', () => controller.close());
      gzip.on('error', error => controller.error(error));
    },
    async pull() {
      if (ended) return;
      const { done, value } = await rest.read();
      if (!done) return write(value);
      ended = true;
      gzip.end();
    },
    cancel(reason) {
      gzip.destroy();
      return rest.cancel(reason);
    },
  });
}

/** Streams a rendered page as it comes; pnext stamps the request's nonce on every inline script, streamed sections included. */
function streamPage(
  request: Request,
  response: Response,
  headers: Headers,
  nonce: string,
): Response {
  headers.set('content-security-policy', [...CSP, `script-src 'self' 'nonce-${nonce}'`].join('; '));
  let body: ReadableStream<Uint8Array> = response.body!;
  if (wantsGzip(request)) {
    markGzip(headers);
    body = gzipStream(body.getReader());
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function secure(request: Request, response: Response, nonce: string): Promise<Response> {
  const headers = new Headers(response.headers);
  headers.set('x-content-type-options', 'nosniff');
  if (!(headers.get('content-type') ?? '').includes('text/html'))
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  headers.set('cache-control', 'no-store');
  headers.delete('content-length');
  const encoding = headers.get('content-encoding');
  if (!encoding && response.body) return streamPage(request, response, headers, nonce);

  // Prerendered pages arrive compressed; hash the decoded markup but send the original bytes.
  const bytes = Buffer.from(await response.arrayBuffer());
  const html = decodeBody(bytes, encoding);
  headers.set('content-security-policy', contentSecurityPolicy(html));
  let body: Uint8Array<ArrayBuffer> | string = encoding ? new Uint8Array(bytes) : html;
  if (!encoding && html.length > 1024 && wantsGzip(request)) {
    body = new Uint8Array(gzipSync(html));
    markGzip(headers);
  }
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Render a dashboard route through the package's prebuilt pnext server. */
export async function serveDash(
  req: Request,
  hosts = new DashboardHosts(),
): Promise<Response | undefined> {
  const host = await hosts.host();
  if (!host) return undefined;
  if (!knownRoute(new URL(req.url).pathname, host.manifest)) return undefined;
  // pnext reads the nonce off the request's policy, as Next.js does with middleware.
  const nonce = randomBytes(16).toString('base64');
  const headers = new Headers(req.headers);
  headers.set('content-security-policy', `script-src 'nonce-${nonce}'`);
  return secure(req, await host.handler(new Request(req, { headers })), nonce);
}

const tokenCookie = (req: Request, value: string, clear = false) =>
  `coder_admin=${encodeURIComponent(value)}; HttpOnly; SameSite=Strict; Path=/${new URL(req.url).protocol === 'https:' ? '; Secure' : ''}${clear ? '; Max-Age=0' : ''}`;

function requestOrigin(req: Request, url: URL): string {
  const host = req.headers.get('x-forwarded-host')?.split(',', 1)[0]?.trim();
  if (!host) return url.origin;
  const protocol =
    req.headers.get('x-forwarded-proto')?.split(',', 1)[0]?.trim() ?? url.protocol.slice(0, -1);
  try {
    return new URL(`${protocol}://${host}`).origin;
  } catch {
    return url.origin;
  }
}

export async function dashboardToken(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const form = await req.formData();
  const token = form.get('token');
  const given = form.get('return');
  const back = safeReturnPath(
    typeof given === 'string' && given.startsWith('/') ? given : null,
    new URL(req.url).origin,
  );
  if (typeof token !== 'string') return redirect('/dash?token=rejected', 303);
  if (!token)
    return new Response(null, {
      status: 303,
      headers: {
        location: back,
        'set-cookie': tokenCookie(req, '', true),
      },
    });
  if (!sameToken(token, ctx.config.adminToken)) return redirect('/dash?token=rejected', 303);

  return new Response(null, {
    status: 303,
    headers: { location: back, 'set-cookie': tokenCookie(req, token) },
  });
}

export async function home(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return redirect(
    !ctx.auth || ctx.session
      ? '/dash'
      : url.searchParams.has('signed_out')
        ? '/login?signed_out=1'
        : '/login',
  );
}

/** Starts Wular sign-in, returning to `back` afterwards. */
export async function toSignIn(
  req: Request,
  ctx: ServerContext,
  url: URL,
  back: string | null,
): Promise<Response> {
  const signIn = `/api/auth/sign-in?return=${encodeURIComponent(safeReturnPath(back, url.origin))}`;
  const publicUrl = ctx.config.publicUrl;
  // The flow cookie belongs on PUBLIC_URL's host, where Wular sends the callback.
  if (publicUrl && new URL(requestOrigin(req, url)).host !== new URL(publicUrl).host)
    return redirect(new URL(signIn, publicUrl).href);

  return ctx.auth!.handler(new Request(`${url.origin}${signIn}`));
}

export async function signIn(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  // A memory server keeps no accounts: its dashboard asks for the admin token.
  if (!ctx.auth) return redirect('/dash');
  // Straight to Wular unless the visitor just signed out or a sign-in failed.
  if (!url.searchParams.has('signed_out') && !url.searchParams.has('error'))
    return toSignIn(req, ctx, url, url.searchParams.get('return'));

  return loginPage(req, ctx);
}

function dashRequest(req: Request, ctx: ServerContext): Request {
  const headers = new Headers(req.headers);
  headers.set('x-coder-mode', serverMode(ctx));
  // The page's organization, for its reads.
  const org = ctx.session?.organizations.find(entry => entry.id === ctx.organizationId);
  if (org) headers.set('x-coder-organization', org.slug);
  else headers.delete('x-coder-organization');
  return new Request(req, { headers });
}

export const notBuilt = () => new Response('UI is not built', { status: 503 });

/** A dashboard page, or `miss()` when the build has none at this path. */
const page = (miss: () => Response) => async (req: Request, ctx: ServerContext) =>
  (await serveDash(dashRequest(req, ctx), ctx.dashboardHosts)) ?? miss();

export const loginPage = page(notBuilt);
export const dashboard = page(notFound);
