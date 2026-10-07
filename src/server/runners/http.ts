import { createHmac, randomBytes } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpsRequest } from 'node:https';

import type { AgentTask } from '../../agent/types';
import type { Runner, RunnerLogs, RunnerStatus } from '.';
import type { InboxEntry, InboxAck } from '../tasks/queue';

export interface HttpRunnerOptions {
  url: string;
  secret: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  lookup?: typeof lookup;
  request?: typeof httpsRequest;
}

function privateAddress(address: string): boolean {
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

export class HttpRunner implements Runner {
  readonly kind = 'http' as const;
  private readonly base: URL;
  private readonly fetcher?: typeof fetch;
  private readonly resolver: typeof lookup;

  constructor(private readonly options: HttpRunnerOptions) {
    if (!options?.url) throw new Error('The http runner requires RUNNER_CONFIG.url');
    this.base = new URL(`${options.url.replace(/\/+$/, '')}/`);
    if (this.base.protocol !== 'https:') throw new Error('The http runner requires an HTTPS URL');
    if (this.base.username || this.base.password)
      throw new Error('The http runner URL cannot contain credentials');
    if (!options.secret) throw new Error('RUNNER_CONFIG.secret is required for the http runner');
    this.fetcher = options.fetch;
    this.resolver = options.lookup ?? lookup;
  }

  private async safe(): Promise<{ address: string; family: number }> {
    const hostname = this.base.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await this.resolver(hostname, { all: true });
    if (!addresses.length) throw new Error('The http runner resolved no address');
    if (addresses.some(item => privateAddress(item.address)))
      throw new Error('The http runner refuses private and metadata addresses');
    return addresses[0]!;
  }

  private send(
    url: URL,
    init: RequestInit,
    address: { address: string; family: number },
  ): Promise<Response> {
    if (this.fetcher) return this.fetcher(url, init);
    return new Promise((resolve, reject) => {
      const req = (this.options.request ?? httpsRequest)(
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
          const chunks: Buffer[] = [];
          res.on('data', chunk => chunks.push(Buffer.from(chunk)));
          res.on('error', reject);
          res.on('end', () =>
            resolve(
              new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), {
                status: res.statusCode,
              }),
            ),
          );
        },
      );
      req.on('error', reject);
      req.end(init.body as string | undefined);
    });
  }

  private async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const address = await this.safe();
    const raw = body === undefined ? '' : JSON.stringify(body);
    const timestamp = String(Date.now());
    const nonce = randomBytes(16).toString('base64url');
    const signature = createHmac('sha256', this.options.secret)
      .update(`${raw}.${timestamp}.${nonce}`)
      .digest('base64url');
    const response = await this.send(
      new URL(path.replace(/^\//, ''), this.base),
      {
        method,
        redirect: 'manual',
        headers: {
          ...this.options.headers,
          'content-type': 'application/json',
          'x-coder-timestamp': timestamp,
          'x-coder-nonce': nonce,
          'x-coder-signature': signature,
        },
        ...(raw ? { body: raw } : {}),
        signal: signal ?? AbortSignal.timeout(path === '/start' ? 30_000 : 10_000),
      },
      address,
    );
    if (response.status >= 300 && response.status < 400)
      throw new Error('The http runner refuses redirects');
    if (!response.ok) throw new Error(`HTTP runner request failed: ${response.status}`);
    if (response.status === 204) return undefined as T;
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  health(signal: AbortSignal): Promise<{ ok: boolean }> {
    return this.request('/health', 'GET', undefined, signal);
  }

  async start(task: AgentTask, env: Record<string, string>): Promise<string> {
    const result = await this.request<{ handle: string }>('/start', 'POST', {
      task: task.id,
      env,
    });
    if (!result.handle) throw new Error('HTTP runner returned no handle');
    return result.handle;
  }

  status(handle: string): Promise<RunnerStatus> {
    return this.request(`/status/${encodeURIComponent(handle)}`);
  }

  logs(handle: string, after = -1): Promise<RunnerLogs> {
    return this.request(`/logs/${encodeURIComponent(handle)}?after=${after}`);
  }

  async stop(handle: string): Promise<void> {
    await this.request(`/stop/${encodeURIComponent(handle)}`, 'POST', {});
  }

  push(handle: string, entries: InboxEntry[]): Promise<InboxAck> {
    return this.request(`/messages/${encodeURIComponent(handle)}`, 'POST', { entries });
  }
}
