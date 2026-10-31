import type { lookup } from 'node:dns/promises';
import type { request as httpsRequest } from 'node:https';

import type { AgentTask } from '../../../agent/types';
import { pinnedRequest, publicAddress, type Address } from '../../outbound';
import { readLimited } from '../../routes/http';
import { RunnerCheckError, type Runner, type RunnerStatus } from '..';
import type { InboxEntry, InboxAck } from '../../tasks/queue';
import { sign, startEnv } from '../../../runner/protocol';

/** The most a runner's answer may hold: a handle, a status or an acknowledgement. */
const RESPONSE_LIMIT = 1_000_000;

interface HttpRunnerOptions {
  url: string;
  secret: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  lookup?: typeof lookup;
  request?: typeof httpsRequest;
}

export class HttpRunner implements Runner {
  readonly kind = 'http' as const;
  private readonly base: URL;
  private readonly fetcher?: typeof fetch;
  private readonly resolver?: typeof lookup;

  constructor(private readonly options: HttpRunnerOptions) {
    if (!options?.url) throw new Error('The http runner requires RUNNER_CONFIG.url');
    this.base = new URL(`${options.url.replace(/\/+$/, '')}/`);
    if (this.base.protocol !== 'https:') throw new Error('The http runner requires an HTTPS URL');
    if (this.base.username || this.base.password)
      throw new Error('The http runner URL cannot contain credentials');
    if (!options.secret) throw new Error('RUNNER_CONFIG.secret is required for the http runner');
    this.fetcher = options.fetch;
    this.resolver = options.lookup;
  }

  private send(url: URL, init: RequestInit, address: Address): Promise<Response> {
    if (this.fetcher) return this.fetcher(url, init);
    return pinnedRequest(url, init, address, this.options.request);
  }

  private async request<T>(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const address = await publicAddress(this.base.hostname, this.resolver);
    const raw = body === undefined ? '' : JSON.stringify(body);
    const url = new URL(path.replace(/^\//, ''), this.base);
    const response = await this.send(
      url,
      {
        method,
        redirect: 'manual',
        headers: {
          ...this.options.headers,
          'content-type': 'application/json',
          ...sign(this.options.secret, method, url.pathname, raw),
        },
        ...(raw ? { body: raw } : {}),
        signal: signal ?? AbortSignal.timeout(path === '/start' ? 30_000 : 10_000),
      },
      address,
    );
    if (response.status >= 300 && response.status < 400)
      throw new Error('The http runner refuses redirects');
    if (!response.ok) throw new Error(`HTTP runner request failed: ${response.status}`);
    if (response.status === 204 || !response.body) return undefined as T;
    const text = new TextDecoder().decode(
      await readLimited(
        response.body as unknown as AsyncIterable<Uint8Array>,
        response.headers.get('content-length') ?? 0,
        RESPONSE_LIMIT,
      ),
    );
    return (text ? JSON.parse(text) : undefined) as T;
  }

  health(signal: AbortSignal): Promise<{ ok: boolean }> {
    return this.request('/health', 'GET', undefined, signal);
  }

  async start(task: AgentTask, env: Record<string, string>): Promise<string> {
    const result = await this.request<{ handle: string }>('/start', 'POST', {
      task: task.id,
      env: startEnv(env),
    });
    if (!result.handle) throw new Error('HTTP runner returned no handle');
    return result.handle;
  }

  status(handle: string): Promise<RunnerStatus> {
    return this.request(`/status/${encodeURIComponent(handle)}`);
  }

  async stop(handle: string): Promise<void> {
    await this.request(`/stop/${encodeURIComponent(handle)}`, 'POST', {});
  }

  push(handle: string, entries: InboxEntry[]): Promise<InboxAck> {
    return this.request(`/messages/${encodeURIComponent(handle)}`, 'POST', { entries });
  }
}

export async function checkHttp(runner: Runner | undefined, signal: AbortSignal): Promise<string> {
  if (!(runner instanceof HttpRunner) || !(await runner.health(signal)).ok)
    throw new RunnerCheckError('Runner health check failed');
  return 'Runner is reachable';
}

export function validateHttpConfig(config: Record<string, string>): void {
  if (config.secret!.length < 32) throw new Error('Secret must contain at least 32 characters');
  new HttpRunner({ url: config.url!, secret: config.secret! });
}
