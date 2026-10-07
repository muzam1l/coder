/** A runner on this machine: listen locally, then register with a server as its `http` runner. */
import { randomBytes, createHmac } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { connect, serverFor, type ServerOptions } from '../core/remote';
import { CoderError } from '../core/dispatch';
import { coderHome } from '../core/state';
import { LocalRunner } from '../server/runners/local';
import type { RunnerRow } from '../client/types';
import { bodyLimit, nodeListener } from '../server/routes/http';
import { safeEqual } from '../utils/crypto';
import type { AgentTask } from '../agent/types';
import type { Runner } from '../server/runners';
import type { InboxEntry } from '../server/tasks/queue';

type Saved = Record<string, { id?: string; organizationId?: string; secret: string }>;

const statePath = () => coderHome('runners.json');

function load(): Saved {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8')) as Saved;
  } catch {
    return {};
  }
}

function save(value: Saved): void {
  fs.mkdirSync(path.dirname(statePath()), { recursive: true });
  fs.writeFileSync(statePath(), JSON.stringify(value, null, 2), { mode: 0o600 });
}

const exposeHints = (port: number) => [
  `cloudflared tunnel --url http://localhost:${port}`,
  `ngrok http ${port}`,
  `tailscale funnel ${port}`,
  `VS Code: forward port ${port} in the Ports view and set its visibility to Public`,
];

export interface RunnerServeOptions extends ServerOptions {
  port?: number;
  /** The public URL a tunnel gives the local port. */
  url?: string;
  name?: string;
  workspace?: boolean;
  runnerUrl?: string;
}

export type RunnerServeResult = RunnerRow & {
  port: number;
  server: string;
  /** Mark the runner offline on the server and stop listening. */
  close(): Promise<void>;
};

/** Serve a server's tasks from this machine; the runner keeps its id and secret per server across restarts. */
export async function serveRunner(options: RunnerServeOptions = {}): Promise<RunnerServeResult> {
  const port = options.port ?? 4100;
  const address = options.token ? (options.runnerUrl ?? process.env.CODER_RUNNER_URL) : options.url;
  if (!address)
    throw new CoderError(
      'invalid-option',
      options.token
        ? 'Expose this runner and set CODER_RUNNER_URL or --runner-url to its public HTTPS address.'
        : 'Expose this runner with a tunnel, then pass its public URL with --url.',
      { hint: exposeHints(port) },
    );

  const target = options.token
    ? serverFor({ ...options, server: options.url ?? options.server, yes: true })
    : serverFor(options);
  const saved = load();
  const mine = saved[target] ?? { secret: randomBytes(32).toString('base64url') };
  const runner = new LocalRunner(coderHome('runner'));
  const handler = runnerController({ secret: mine.secret, server: target, runner });
  const listener = http.createServer(nodeListener(handler, { limit: bodyLimit }));
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  const close = () => new Promise<void>(resolve => listener.close(() => resolve()));
  const name = options.name ?? os.hostname();
  const register = async (token?: string, offline?: boolean) => {
    const response = await fetch(`${target}/runners/register`, {
      method: 'POST',
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...(token ? { token } : { id: mine.id, organizationId: mine.organizationId }),
        name,
        url: address,
        secret: mine.secret,
        ...(offline ? { offline } : {}),
      }),
    });
    if (!response.ok)
      throw new CoderError('server', 'Runner registration failed', { status: response.status });
    return response.json() as Promise<RunnerRow & { organizationId: string }>;
  };
  let registered: RunnerRow;
  try {
    if (options.token) {
      const paired = await register(options.token);
      registered = paired;
      mine.organizationId = paired.organizationId;
    } else {
      const returning =
        mine.id && mine.organizationId
          ? await register().catch(error => {
            if (error instanceof CoderError && error.status === 401) return undefined;
            throw error;
          })
          : undefined;
      if (returning) registered = returning;
      else {
        const api = connect(options);
        const me = await api.me();
        registered = await api.runners.add({
          kind: 'http',
          name,
          scope: options.workspace || !me.user ? 'workspace' : 'personal',
          config: { url: address, secret: mine.secret },
        });
        mine.organizationId = me.organization?.id;
        mine.id = registered.id;
        registered = await register();
      }
    }
    mine.id = registered.id;
    save({ ...saved, [target]: mine });
  } catch (error) {
    await close();
    throw error;
  }
  let pending = Promise.resolve();
  const heartbeat = setInterval(() => {
    pending = pending.then(() => register().then(() => { })).catch(() => { });
  }, 60_000);
  return {
    ...registered,
    port,
    server: target,
    close: async () => {
      clearInterval(heartbeat);
      await pending;
      await register(undefined, true).catch(() => { });
      await close();
    },
  };
}

const WINDOW_MS = 5 * 60 * 1000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The `http` runner's controller: start, status, logs and stop, each signed with the runner's secret. */
export function runnerController(options: {
  secret: string;
  server: string;
  runner: Runner;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const seen = new Map<string, number>();

  const verify = (req: Request, raw: string): boolean => {
    const timestamp = req.headers.get('x-coder-timestamp') ?? '';
    const nonce = req.headers.get('x-coder-nonce') ?? '';
    const given = req.headers.get('x-coder-signature') ?? '';
    const at = Number(timestamp);
    if (!nonce || !Number.isFinite(at) || Math.abs(now() - at) > WINDOW_MS) return false;
    const expected = createHmac('sha256', options.secret)
      .update(`${raw}.${timestamp}.${nonce}`)
      .digest('base64url');
    if (!safeEqual(given, expected)) return false;
    for (const [key, until] of seen) if (until < now()) seen.delete(key);
    if (seen.has(nonce)) return false;
    seen.set(nonce, at + WINDOW_MS);
    return true;
  };

  return async (req: Request): Promise<Response> => {
    const raw = req.method === 'GET' ? '' : await req.text();
    if (!verify(req, raw)) return json({ error: 'Unauthorized' }, 401);
    const url = new URL(req.url);
    const [, action, handle] = url.pathname.split('/').map(decodeURIComponent);
    try {
      if (req.method === 'POST' && action === 'start' && !handle) {
        const body = JSON.parse(raw) as { task?: string; env?: Record<string, string> };
        if (typeof body.task !== 'string' || !body.env)
          return json({ error: 'Invalid start' }, 400);
        const token = body.env.CODER_TASK_TOKEN;
        if (typeof token !== 'string') return json({ error: 'Invalid start' }, 400);
        // Tasks only ever call back to the server this runner registered with.
        const env = {
          CODER_SERVER: options.server,
          CODER_TASK_TOKEN: token,
          CODER_INBOX_MODE: options.runner.push ? 'push' : 'poll',
          ...(body.env.CODER_LOGIN === 'claude' || body.env.CODER_LOGIN === 'codex'
            ? { CODER_LOGIN: body.env.CODER_LOGIN }
            : {}),
        };
        return json({ handle: await options.runner.start({ id: body.task } as AgentTask, env) });
      }
      if (req.method === 'GET' && action === 'health' && !handle) return json({ ok: true });
      if (!handle) return json({ error: 'Not found' }, 404);
      if (req.method === 'POST' && action === 'messages' && options.runner.push) {
        const { entries } = JSON.parse(raw) as { entries?: InboxEntry[] };
        if (!Array.isArray(entries) || !entries.length)
          return json({ error: 'Invalid messages' }, 400);
        return json(await options.runner.push(handle, entries));
      }
      if (req.method === 'GET' && action === 'status')
        return json(await options.runner.status(handle));
      if (req.method === 'GET' && action === 'logs')
        return json(await options.runner.logs(handle, Number(url.searchParams.get('after') ?? -1)));
      if (req.method === 'POST' && action === 'stop') {
        await options.runner.stop(handle);
        return new Response(null, { status: 204 });
      }
      return json({ error: 'Not found' }, 404);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  };
}
