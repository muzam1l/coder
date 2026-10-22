import { ServerClient, ClientError } from '@coder/client';
import { CoderError } from '@coder/core/errors';
import type { AgentRow, AppRow, StoredRow } from '@coder/client/types';
import { DEFAULT_ENGINE } from '@coder/core/types';
import { NO_MODELS, modelsByEngine } from '@/app/dash/[org]/settings/model-options';

export function encodeDefinition(definition: unknown): string {
  return Buffer.from(JSON.stringify(definition), 'utf8').toString('base64url');
}

/** Where creating `agent`'s app on `integration` starts; a repo agent's app follows its apps' branch. */
export function createUrl(agent: AgentRow, apps: AppRow[], integration: string) {
  const params = new URLSearchParams({
    agent: agent.id,
    def: agent.definition ? encodeDefinition(agent.definition) : '',
  });
  if (agent.source === 'repo' && agent.repo) {
    params.set('repo', agent.repo);
    params.set('branch', apps.find(app => app.branch)?.branch ?? 'main');
  }

  return `/create/${encodeURIComponent(integration)}?${params}`;
}

const clientKey = Symbol('coder.dashboard.client');
type RenderRequest = Request & { [clientKey]?: ServerClient };

/** One client per render request, with shared in-process GETs and the caller's cookie, scope and organization. */
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
        const org = request.headers.get('x-coder-organization');
        if (org) headers.set('x-coder-organization', org);
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

/** The organization a dashboard page shows, `/dash/<org>/…`, read from the address so frames render before params resolve. */
export const orgOf = (request: Request) =>
  decodeURIComponent(new URL(request.url).pathname.split('/')[2]!);
export function loadAgent(request: Request, slug: string) {
  const path = new URL(request.url).pathname;
  const content =
    path === `/dash/${encodeURIComponent(orgOf(request))}/agents/${encodeURIComponent(slug)}` ||
    path.endsWith('/edit');
  return load(request).agents.get(slug, { versions: false, content, handles: true });
}

/** Each engine's models, and what an agent runs with when it sets nothing. */
export function loadRunDefaults(request: Request) {
  return Promise.all([
    load(request)
      .models.list()
      .catch(() => NO_MODELS),
    load(request)
      .config.get()
      .catch(() => undefined),
  ]).then(([shape, shown]) => ({
    models: modelsByEngine(shape),
    defaults: {
      engine: shown?.effective.chain?.[0] ?? DEFAULT_ENGINE,
      engines: shown?.effective.engines ?? {},
      builtin: shape.builtin,
    },
  }));
}
