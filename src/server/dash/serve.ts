import path from 'node:path';
import { match, type Params } from '../routes/match';
import { createHash, randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
import { sameToken, serverMode } from '../routes/guards';
import { notFound, redirect } from '../routes/http';
import { safeReturnPath } from '../auth/sign-in';

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

const DASH_NOT_BUILT = 'The Coder dashboard is not built; run bun run build.';
const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
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
  const candidates = [path.join(root, 'dist/dash'), path.join(moduleDirectory, '../dash')];
  return candidates.find(candidate => existsSync(path.join(candidate, 'manifest.json')));
}

export function serverEntry(root: string): string {
  const directory = path.join(root, 'server');
  if (!existsSync(directory)) throw new Error('The Coder dashboard server bundle is missing.');
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith('bundle-'))
    .map(entry => path.join(directory, entry.name, 'entry.js'))
    .filter(existsSync);
  if (!entries.length) throw new Error('The Coder dashboard server bundle is missing.');
  if (entries.length !== 1) throw new Error('The Coder dashboard has multiple server bundles.');
  return entries[0]!;
}

/** A fresh copy of the source, so a rebuilt dashboard is imported anew; keeps this process's last two. */
function sourceCopy(root: string, generation: number): string {
  const base = path.join(
    tmpdir(),
    'coder-dash',
    createHash('sha256').update(root).digest('hex').slice(0, 12),
  );
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    const [pid, copy] = name.split('-').map(Number);
    let alive = pid === process.pid;
    if (!alive)
      try {
        process.kill(pid!, 0);
        alive = true;
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code === 'EPERM';
      }
    if (!alive || (pid === process.pid && copy! < generation - 1))
      rmSync(path.join(base, name), { recursive: true, force: true });
  }
  const target = path.join(base, `${process.pid}-${generation}`);
  cpSync(path.join(root, 'src'), path.join(target, 'src'), { recursive: true });
  for (const link of ['dist', 'node_modules'])
    symlinkSync(path.join(root, link), path.join(target, link), 'dir');
  // pnext resolves its root through symlinks; the manifest must name the same paths.
  return realpathSync(path.join(target, 'src/server/dash'));
}

async function createDashHost(moduleUrl: string, generation = 0): Promise<DashHost> {
  const root = packageRoot(moduleUrl);
  const dashRoot = resolveDashRoot(moduleUrl);
  if (!dashRoot) throw new Error(DASH_NOT_BUILT);
  const raw = JSON.parse(readFileSync(path.join(dashRoot, 'manifest.json'), 'utf8')) as Manifest;
  const actualRoot = generation ? sourceCopy(root, generation) : path.join(root, 'src/server/dash');
  const manifest = { ...raw, outDir: dashRoot };
  const entryFile = serverEntry(dashRoot);
  const entry = (await import(pathToFileURL(entryFile).href)) as {
    createRequestHandler(options: { root: string; manifest: Manifest }): Promise<RequestHandler>;
  };
  return {
    handler: await entry.createRequestHandler({ root: actualRoot, manifest }),
    manifest,
  };
}

type Loaded = { host: Promise<DashHost>; build?: number; checked: number };
export class DashboardHosts {
  readonly hosts = new Map<string, Loaded>();
  readonly made = new Map<string, number>();
}
/** How often a request looks for a newer build. */
const RECHECK_MS = 1000;

/** When the build in use was written; undefined while none is complete. */
function buildStamp(moduleUrl: string): number | undefined {
  const root = resolveDashRoot(moduleUrl);
  if (!root) return undefined;
  try {
    return statSync(path.join(root, 'manifest.json')).mtimeMs;
  } catch {
    return undefined;
  }
}

/** The dashboard host, replaced once a rebuild lands so a running server serves it. */
function dashHost(moduleUrl: string, { hosts, made }: DashboardHosts): Promise<DashHost> {
  const now = Date.now();
  const loaded = hosts.get(moduleUrl);
  if (loaded && now - loaded.checked < RECHECK_MS) return loaded.host;
  const build = buildStamp(moduleUrl);
  if (loaded) {
    loaded.checked = now;
    if (build === undefined || build === loaded.build) return loaded.host;
  }
  const generation = made.get(moduleUrl) ?? 0;
  made.set(moduleUrl, generation + 1);
  const next = { build, checked: now, host: createDashHost(moduleUrl, generation) };
  hosts.set(moduleUrl, next);
  return next.host;
}

export function knownRoute(pathname: string, manifest: Manifest): boolean {
  const normalized =
    pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  return Boolean(
    match('/assets/*', normalized) ||
    match('/dash/*', normalized) ||
    manifest.routes.some(route => match(route.route, normalized)),
  );
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
  moduleUrl = import.meta.url,
  cache = new DashboardHosts(),
): Promise<Response | undefined> {
  let host: DashHost;
  try {
    host = await dashHost(moduleUrl, cache);
  } catch (error) {
    cache.hosts.delete(moduleUrl);
    if (error instanceof Error && error.message === DASH_NOT_BUILT) return undefined;
    throw error;
  }
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

export async function signIn(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  // Straight to Wular unless the visitor just signed out or a sign-in failed.
  if (ctx.auth && !url.searchParams.has('signed_out') && !url.searchParams.has('error')) {
    const signIn = `/api/auth/sign-in?return=${encodeURIComponent(safeReturnPath(url.searchParams.get('return'), url.origin))}`;
    const publicUrl = ctx.config.publicUrl;
    // The flow cookie belongs on PUBLIC_URL's host, where Wular sends the callback.
    if (publicUrl && new URL(requestOrigin(req, url)).host !== new URL(publicUrl).host)
      return redirect(new URL(signIn, publicUrl).href);

    return ctx.auth.handler(new Request(`${url.origin}${signIn}`));
  }

  return (
    (await serveDash(dashRequest(req, ctx), undefined, ctx.dashboardHosts)) ??
    new Response('UI is not built', { status: 503 })
  );
}

export async function loginPage(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return (
    (await serveDash(dashRequest(req, ctx), undefined, ctx.dashboardHosts)) ??
    new Response('UI is not built', { status: 503 })
  );
}

export async function dashboard(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return (await serveDash(dashRequest(req, ctx), undefined, ctx.dashboardHosts)) ?? notFound();
}

export function dashRequest(req: Request, ctx: ServerContext): Request {
  const headers = new Headers(req.headers);
  headers.set('x-coder-mode', serverMode(ctx));
  return new Request(req, { headers });
}

export async function pagesFallback(req: Request, ctx: ServerContext, url: URL): Promise<Response> {
  return (await serveDash(dashRequest(req, ctx), undefined, ctx.dashboardHosts)) ?? notFound();
}
