import { type Found } from '../../client/types';
import { safeEqual } from '../../utils/crypto';
import { sign } from '../auth/nonce';
import { type ServerContext } from '../context';
import { pinnedRequest, publicAddress } from '../outbound';
import { json, notFound } from '../routes/http';
import { type Params } from '../routes/match';
import { MemoryCache } from './models';

const RUNNERS: Record<string, [string, ...string[]]> = {
  npm: ['npx', '-y'],
  pypi: ['uvx'],
  oci: ['docker', 'run', '-i', '--rm'],
};

type Input = {
  name: string;
  description?: string;
  isRequired?: boolean;
  isSecret?: boolean;
  value?: string;
  default?: string;
};

type Argument = Partial<Input> & {
  type: string;
  valueHint?: string;
  variables?: Record<string, Omit<Input, 'name'>>;
};

type ArgumentInput = {
  name: string;
  label: string;
  description?: string;
  placeholder?: string;
  required: boolean;
  secret: boolean;
};

type Remote = { type: string; url: string; headers?: Input[] };

type Icon = { src: string; mimeType?: string; sizes?: string[]; theme?: 'light' | 'dark' };

export type IconFile = { type: string; bytes: Buffer<ArrayBuffer> };

type Package = {
  registryType: string;
  identifier: string;
  runtimeHint?: string;
  transport?: { type: string };
  environmentVariables?: Input[];
  runtimeArguments?: Argument[];
  packageArguments?: Argument[];
};

type Detail = {
  name: string;
  version?: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
  icons?: Icon[];
  remotes?: Remote[];
  packages?: Package[];
  /** GitHub's registry adds the repository's own display name. */
  _meta?: Record<string, { github?: { displayName?: string } } | undefined>;
};

const inputs = (list: Input[] = []) =>
  list.map(({ name, description, isRequired, isSecret, value, default: fallback }) => ({
    name,
    ...(description ? { description } : {}),
    ...((value ?? fallback) ? { placeholder: value ?? fallback } : {}),
    required: isRequired === true,
    secret: isSecret === true,
  }));

function argumentsOf(list: Argument[] = [], kind: string, fields: ArgumentInput[]): string[] {
  return list.flatMap((argument, index) => {
    const key = `${kind}:${index}`;
    const variables = Object.entries(argument.variables ?? {});
    let value = argument.value ?? argument.default;
    const field = (name: string, label: string, input: Omit<Input, 'name'>) => {
      const [mapped] = inputs([{ ...input, name }]);
      fields.push({ ...mapped!, label });
      return `{${name}}`;
    };
    if (variables.length)
      for (const [name, input] of variables)
        value = value?.replaceAll(`{${name}}`, field(`${key}:${name}`, name, input));
    else if (value === undefined && (argument.valueHint || argument.isRequired))
      value = field(key, argument.valueHint ?? argument.name ?? key, argument);
    return [
      ...(argument.type === 'named' && argument.name ? [argument.name] : []),
      ...(value === undefined ? [] : [value]),
    ];
  });
}

function entryOf(server: Detail) {
  const remote = server.remotes?.find(each => each.type === 'streamable-http');
  if (remote)
    return {
      type: 'http',
      url: remote.url,
      env: [],
      headers: inputs(remote.headers),
    };
  const pkg = server.packages?.find(
    each => RUNNERS[each.registryType] && (each.transport?.type ?? 'stdio') === 'stdio',
  );
  if (!pkg) return undefined;
  const [command, ...args] = RUNNERS[pkg.registryType]!;
  const argumentInputs: ArgumentInput[] = [];
  const runtime = argumentsOf(pkg.runtimeArguments, 'runtime', argumentInputs);
  const binary = argumentsOf(pkg.packageArguments, 'package', argumentInputs);
  return {
    type: 'stdio',
    command: pkg.runtimeHint ?? command,
    args: [
      ...(!pkg.runtimeHint || pkg.runtimeHint === command ? args : []),
      ...runtime,
      pkg.identifier,
      ...binary,
    ],
    ...(argumentInputs.length ? { argumentInputs } : {}),
    env: inputs(pkg.environmentVariables),
    headers: [],
  };
}

const ICON_BYTES = 64 * 1024;
const ICON_SIDE = 2048;
const RASTER = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp'];

/** The image type from its magic bytes, and its width and height from its header; PNG, JPEG and WebP only. */
function sniff(bytes: Buffer): { type: string; width: number; height: number } | undefined {
  if (bytes.length < 32) return undefined;
  if (
    bytes.toString('hex', 0, 8) === '89504e470d0a1a0a' &&
    bytes.toString('latin1', 12, 16) === 'IHDR'
  )
    return { type: 'image/png', width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  if (bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') {
    const chunk = bytes.toString('latin1', 12, 16);
    const bits = bytes.readUInt32LE(21);
    if (chunk === 'VP8X')
      return {
        type: 'image/webp',
        width: 1 + bytes.readUIntLE(24, 3),
        height: 1 + bytes.readUIntLE(27, 3),
      };
    if (chunk === 'VP8L')
      return {
        type: 'image/webp',
        width: 1 + (bits & 0x3fff),
        height: 1 + ((bits >> 14) & 0x3fff),
      };
    if (chunk === 'VP8 ')
      return {
        type: 'image/webp',
        width: bytes.readUInt16LE(26) & 0x3fff,
        height: bytes.readUInt16LE(28) & 0x3fff,
      };
    return undefined;
  }
  if (bytes.toString('hex', 0, 3) !== 'ffd8ff') return undefined;
  // A JPEG's size is in its frame header, after the segments before it.
  for (let at = 2; at + 9 <= bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
    if (bytes[at] !== 0xff) return undefined;
    const marker = bytes[at + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker))
      return {
        type: 'image/jpeg',
        width: bytes.readUInt16BE(at + 7),
        height: bytes.readUInt16BE(at + 5),
      };
  }

  return undefined;
}

function checkIcon(bytes: Buffer<ArrayBuffer>): IconFile | undefined {
  const image = bytes.length <= ICON_BYTES ? sniff(bytes) : undefined;
  if (!image || !image.width || !image.height) return undefined;

  return Math.max(image.width, image.height) <= ICON_SIDE ? { type: image.type, bytes } : undefined;
}

const iconSignature = (ctx: ServerContext, src: string) => sign(ctx, `mcp-icon:${src}`);

const originOf = (value?: string) =>
  value && URL.canParse(value) ? new URL(value).origin : undefined;

/** The server's icon from our own origin: raster, hosted on its remote's or website's origin, nearest 32 to 64 px. */
function iconOf(ctx: ServerContext, server: Detail): string | undefined {
  const origins = new Set(
    [...(server.remotes ?? []).map(remote => remote.url), server.websiteUrl].map(originOf),
  );
  const distance = ({ sizes = [] }: Icon) =>
    Math.min(
      256,
      ...sizes
        .map(size => parseInt(size))
        .filter(side => side > 0)
        .map(side => (side < 32 ? (32 - side) * 8 : Math.max(0, side - 64))),
    );
  const shown = ({ src }: Icon) => {
    if (src.startsWith('data:')) {
      const file = checkIcon(
        Buffer.from(/^data:[^,]*;base64,(.*)$/s.exec(src)?.[1] ?? '', 'base64'),
      );
      return file && `data:${file.type};base64,${file.bytes.toString('base64')}`;
    }
    const url = URL.canParse(src) ? new URL(src) : undefined;
    if (
      url?.protocol !== 'https:' ||
      url.username ||
      url.password ||
      !origins.has(url.origin) ||
      /\.(svg|gif)$/i.test(url.pathname)
    )
      return undefined;

    return `/mcp-icons/${iconSignature(ctx, src)}?${new URLSearchParams({ src })}`;
  };

  return (server.icons ?? [])
    .filter(icon => !icon.mimeType || RASTER.includes(icon.mimeType))
    .sort((a, b) => Number(!!a.theme) - Number(!!b.theme) || distance(a) - distance(b))
    .map(shown)
    .find(Boolean);
}

/** Fetches with no credentials or redirects, from the public address it checked; null when the icon is refused. */
async function fetchIcon(ctx: ServerContext, src: string): Promise<IconFile | null> {
  try {
    const url = new URL(src);
    if (url.protocol !== 'https:') return null;
    const address = await publicAddress(url.hostname);
    const init: RequestInit = {
      headers: { accept: RASTER.join(',') },
      credentials: 'omit',
      redirect: 'manual',
      signal: AbortSignal.timeout(3_000),
    };
    const response = ctx.fetch
      ? await ctx.fetch(url, init)
      : await pinnedRequest(url, init, address, undefined, ICON_BYTES);
    if (response.status !== 200) return null;

    return checkIcon(Buffer.from(await response.arrayBuffer())) ?? null;
  } catch {
    return null;
  }
}

/** An icon the registry search signed, checked and cached; anyone may load it, only the search names new ones. */
export async function mcpIcon(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const src = url.searchParams.get('src') ?? '';
  if (!safeEqual(iconSignature(ctx, src), params.signature ?? '')) return notFound();
  const settings = (ctx.settings ??= {});
  const icons = (settings.mcpIcons ??= new MemoryCache<IconFile | null>({
    ttlMs: 3_600_000,
    max: 300,
    now: ctx.now,
  }));
  const icon = await icons.get(src, () => fetchIcon(ctx, src));
  if (!icon) return notFound();

  return new Response(icon.bytes, {
    headers: {
      'content-type': icon.type,
      'cache-control': 'public, max-age=604800, immutable',
      'x-content-type-options': 'nosniff',
    },
  });
}

type RegistryRow = {
  version: string;
  latest: boolean;
  found?: Found;
};

type RegistrySource = {
  url: string;
  curated: boolean;
  rows: Map<string, RegistryRow>;
  ready: boolean;
  failed: boolean;
};

function compareVersions(a: string, b: string): number {
  const [ac = '', ap] = a.replace(/^v/, '').split('+')[0]!.split(/-(.*)/);
  const [bc = '', bp] = b.replace(/^v/, '').split('+')[0]!.split(/-(.*)/);
  const core = ac.localeCompare(bc, 'en', { numeric: true });
  if (core) return core;
  if (ap === undefined || bp === undefined)
    return Number(ap === undefined) - Number(bp === undefined);
  const aa = ap.split('.');
  const bb = bp.split('.');
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    const av = aa[i];
    const bv = bb[i];
    if (av === undefined || bv === undefined)
      return Number(av !== undefined) - Number(bv !== undefined);
    const an = /^\d+$/.test(av);
    const bn = /^\d+$/.test(bv);
    const order = an !== bn ? Number(bn) - Number(an) : av.localeCompare(bv, 'en', { numeric: an });
    if (order) return order;
  }

  return 0;
}

export class RegistryIndex {
  private sources: RegistrySource[] = [
    {
      url: 'https://api.mcp.github.com/v0.1/servers',
      curated: true,
      rows: new Map(),
      ready: false,
      failed: false,
    },
    {
      url: 'https://registry.modelcontextprotocol.io/v0.1/servers',
      curated: false,
      rows: new Map(),
      ready: false,
      failed: false,
    },
  ];
  private refreshAt = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private controller?: AbortController;
  private closed = false;
  inFlight?: Promise<void>;

  response(ctx: ServerContext, search: string): Response {
    if ((ctx.now ?? Date.now)() >= this.refreshAt) this.refresh(ctx);
    if (
      !this.inFlight &&
      this.sources.some(source => source.failed) &&
      !this.sources.some(source => [...source.rows.values()].some(row => row.found))
    )
      return json({ error: 'The MCP registry did not answer. Try again.' }, 502);
    const q = search.trim().toLowerCase();
    const seen = new Set<string>();
    const found = this.sources.flatMap(source =>
      [...source.rows].flatMap(([name, { found }], order) => {
        if (seen.has(name)) return [];
        seen.add(name);
        if (!found) return [];
        // The server's own name and title, never its namespace, which is often io.github.<user>.
        const names = [found.name.split('/').pop()!, found.title].map(value => value.toLowerCase());
        const quality =
          !q || names.includes(q)
            ? 0
            : names.some(value => value.startsWith(q))
              ? 1
              : names.some(value => value.includes(q))
                ? 2
                : found.description.toLowerCase().includes(q)
                  ? 3
                  : 4;
        if (quality === 4) return [];
        const vendor = q && found.verified && quality < 3 ? 0 : 1;

        return [{ found, curated: source.curated, order, vendor, quality }];
      }),
    );
    // Name or title matches before description-only ones; within each, GitHub's curated order, then vendors.
    const tier = (quality: number) => Number(quality === 3);
    found.sort(
      (a, b) =>
        tier(a.quality) - tier(b.quality) ||
        Number(b.curated) - Number(a.curated) ||
        (a.curated
          ? a.order - b.order
          : a.vendor - b.vendor ||
            a.quality - b.quality ||
            a.found.name.localeCompare(b.found.name)),
    );

    return json(
      found.slice(0, 30).map(({ found }) => found),
      200,
      this.sources.every(source => source.ready) ? {} : { partial: 'true' },
    );
  }

  private refresh(ctx: ServerContext): void {
    if (this.inFlight || this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    const controller = (this.controller = new AbortController());
    this.inFlight = Promise.all(
      this.sources.map(source => this.fill(ctx, source, controller.signal)),
    )
      .then(() => {})
      .finally(() => {
        this.inFlight = undefined;
        this.refreshAt = (ctx.now ?? Date.now)() + 3_600_000;
        if (!this.closed) {
          this.timer = setTimeout(() => this.refresh(ctx), 3_600_000);
          this.timer.unref();
        }
      });
    ctx.waitUntil?.(this.inFlight);
  }

  private async fill(
    ctx: ServerContext,
    source: RegistrySource,
    signal: AbortSignal,
  ): Promise<void> {
    const rows = new Map<string, RegistryRow>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    try {
      do {
        const query = new URLSearchParams({ limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const response = await (ctx.fetch ?? fetch)(`${source.url}?${query}`, {
          headers: { accept: 'application/json' },
          signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
        });
        if (!response.ok) throw new Error('Registry unavailable');
        const { servers, metadata } = (await response.json()) as {
          servers: Array<{
            server: Detail;
            _meta?: { 'io.modelcontextprotocol.registry/official'?: { isLatest?: boolean } };
          }>;
          metadata?: { nextCursor?: string };
        };
        for (const { server, _meta } of servers) {
          const latest = _meta?.['io.modelcontextprotocol.registry/official']?.isLatest === true;
          const version = server.version ?? '';
          const previous = rows.get(server.name);
          if (
            previous &&
            (previous.latest !== latest
              ? previous.latest
              : compareVersions(previous.version, version) >= 0)
          )
            continue;
          const entry = entryOf(server);
          const icon = entry && iconOf(ctx, server);
          const verified =
            /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//i.test(server.name) &&
            !/^io\.github(?:\.|\/)/i.test(server.name);
          rows.set(server.name, {
            version,
            latest,
            found: entry
              ? {
                  name: server.name,
                  title:
                    server._meta?.['io.modelcontextprotocol.registry/publisher-provided']?.github
                      ?.displayName ??
                    server.title ??
                    server.name.split('/').pop() ??
                    server.name,
                  description: server.description ?? '',
                  ...(verified ? { verified: true } : {}),
                  ...(source.curated ? { curated: true } : {}),
                  ...(icon ? { icon } : {}),
                  ...entry,
                }
              : undefined,
          });
        }
        if (!source.ready) source.rows = new Map(rows);
        cursor = metadata?.nextCursor;
        if (cursor && cursors.has(cursor)) throw new Error('Registry cursor repeated');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      source.rows = rows;
      source.ready = true;
      source.failed = false;
    } catch {
      source.failed = true;
    }
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.controller?.abort();
  }
}

export async function mcpRegistry(req: Request, ctx: ServerContext, url: URL): Promise<Response> {
  const settings = (ctx.settings ??= {});
  const index = (settings.registry ??= new RegistryIndex());

  return index.response(ctx, url.searchParams.get('q') ?? '');
}
