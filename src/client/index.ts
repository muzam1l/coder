import { CoderError } from '../core/errors';
import type {
  RunnerSpec,
  RunnerPairing,
  RunnerInput,
  RunnerUpdate,
  RunnerTest,
  ClientTypes,
  PushResult,
  AgentCardRow,
  AgentRow,
  AgentSettings,
  AgentQuery,
  TaskQuery,
  PageQuery,
  ImportAgent,
  Paged,
  TaskRow,
  TasksPage,
  VersionRow,
  IntegrationInfo,
  AppRow,
  InstallationRow,
  StoredRow,
  Me,
  EngineStatus,
  LocalFolder,
  LocalFolders,
  Config,
  ConfigShape,
  ModelsShape,
  ProbeResult,
  McpRows,
  Found,
  UsageQuery,
  UsageReport,
  UsagePage,
  TaskInput,
  TaskLog,
} from './types';

export class ClientError extends CoderError {
  constructor(
    status: number,
    message: string,
    readonly authenticate = '',
    hint?: string,
  ) {
    super('server', message, { status, ...(hint ? { hint } : {}) });
  }
}

export type ClientAuth = { token: string } | { cookie: true };
export interface ClientOptions {
  fetch?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  organization?: string;
  onError?(error: ClientError): void;
  renewal?: { expiresAt(): number; renew(): Promise<string> };
}

export function isLoopbackServer(server: string): boolean {
  try {
    const host = new URL(server).hostname.toLowerCase();
    return host === 'localhost' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
  } catch {
    return false;
  }
}

export function validateUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CoderError(
      'invalid-option',
      'Give the server as a URL, e.g. https://agents.example.com.',
    );
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopbackServer(url.origin)))
    throw new CoderError(
      'invalid-option',
      'Coder servers require HTTPS unless they are loopback.',
      { hint: 'Use https://, or http://localhost for a local server.' },
    );
  if (url.username || url.password || url.search || url.hash)
    throw new CoderError(
      'invalid-option',
      'The server must be an origin without credentials, query, or fragment.',
    );
  return url.toString().replace(/\/+$/, '');
}

const credentialPath = (label: string, suffix: string, workspace?: boolean) =>
  `/admin/credentials/${encodeURIComponent(label)}${suffix}${workspace ? '?workspace' : ''}`;

const queryPath = (path: string, options: object) => {
  const query = new URLSearchParams();
  if ('cursor' in options && typeof options.cursor === 'string')
    query.set('cursor', options.cursor);
  for (const [key, value] of Object.entries(options))
    if (key !== 'cursor' && value !== undefined && value !== false && value !== '')
      query.set(key, value === true ? '1' : Array.isArray(value) ? value.join(',') : String(value));
  return `${path}?${query}`;
};

const DONE = new Set<TaskRow['status']>(['completed', 'failed', 'cancelled']);

/** Typed HTTP routes with bearer or same-origin cookie authentication. */
export class ServerClient<D extends ClientTypes = ClientTypes> {
  readonly url: string;

  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  private readonly organization?: string;
  private readonly renewal?: ClientOptions['renewal'];

  private readonly onError?: ClientOptions['onError'];
  private token?: string;
  private readonly cookie: boolean;

  constructor(url: string, auth: ClientAuth, options: ClientOptions = {}) {
    this.cookie = 'cookie' in auth;
    this.url = url ? validateUrl(url) : '';
    if (!this.cookie && !this.url)
      throw new CoderError('invalid-option', 'Bearer clients need a server URL.');
    this.token = 'token' in auth ? auth.token : undefined;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.organization = options.organization;
    this.renewal = options.renewal;
    this.onError = options.onError;
  }

  private request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const pending = this.read<T>(path, init);
    pending.catch(() => {});
    return pending;
  }

  private async read<T>(path: string, init: RequestInit): Promise<T> {
    if (this.renewal && this.renewal.expiresAt() - Date.now() < 30_000)
      this.token = await this.renewal.renew();
    let response = await this.send(path, init);
    // RFC 6750: an expired or too old token is refreshed once and the call retried.
    if (
      response.status === 401 &&
      this.renewal &&
      /invalid_token/.test(response.headers.get('www-authenticate') ?? '')
    ) {
      this.token = await this.renewal.renew();
      response = await this.send(path, init);
    }
    const text = await response.text().catch(() => '');
    let body = {} as T & { error?: string; message?: string; hint?: string };
    let plain: string | undefined;
    try {
      if (text && response.status !== 204) body = JSON.parse(text);
    } catch {
      if (response.ok)
        throw new CoderError(
          'server',
          `The server answered ${response.status} with a body that is not JSON.`,
        );
      if (this.cookie && text) plain = text;
    }
    if (!response.ok) {
      const error = new ClientError(
        response.status,
        body.error ?? body.message ?? plain ?? `The server answered ${response.status}.`,
        response.headers.get('www-authenticate') ?? '',
        body.hint,
      );
      this.onError?.(error);
      throw error;
    }
    return body;
  }

  private send(path: string, init: RequestInit): Promise<Response> {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    if (!this.cookie) headers.set('authorization', `Bearer ${this.token}`);
    if (this.organization) headers.set('x-coder-organization', this.organization);
    return this.fetchImpl(`${this.url}${path}`, {
      ...init,
      headers,
      ...(this.cookie ? { credentials: 'same-origin' as const } : {}),
    }).catch((error: Error) => {
      if (error instanceof CoderError || error.name === 'AbortError') throw error;
      throw new CoderError(
        'server',
        this.url
          ? `No Coder server answers at ${this.url}: ${error.message}`
          : 'The server did not answer. Check the connection and try again.',
      );
    });
  }

  private post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, {
      method: 'POST',
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  }

  /** `GET /me`: who the token belongs to. */
  me(): Promise<Me> {
    return this.request('/me');
  }
  info(): Promise<{ wular: string | null }> {
    return this.request('/api/auth/capabilities');
  }
  linkAccount(token: string): Promise<{ platform: string; platformUserId: string }> {
    return this.post('/connect', { token });
  }
  signOut(): Promise<{ url?: string }> {
    return this.post('/api/auth/sign-out', {});
  }

  readonly agents = {
    list: <Q extends AgentQuery = AgentQuery>(
      options?: Q,
    ): Promise<
      Q extends { cursor: string }
        ? Paged<AgentCardRow> & {
            connectable?: Array<{ id: string; integration: string }>;
          }
        : D['agent'][]
    > =>
      this.request(
        queryPath('/admin/agents', {
          ...options,
          ...(options?.connect ? { connect: 1 } : {}),
        }),
      ),
    get: <Q extends { versions?: boolean; content?: boolean } = {}>(
      slug: string,
      options?: Q,
    ): Promise<Q extends { versions: false } ? AgentRow : D['detail']> =>
      this.request(
        queryPath(`/admin/agents/${encodeURIComponent(slug)}`, {
          ...(options?.versions === false ? { versions: 0 } : {}),
          ...(options?.content === false ? { content: 0 } : {}),
        }),
      ),
    versions: (slug: string, options: PageQuery = {}): Promise<Paged<VersionRow>> =>
      this.request(queryPath(`/admin/agents/${encodeURIComponent(slug)}/versions`, options)),
    remove: (slug: string): Promise<{ ok: true }> =>
      this.request(`/admin/agents/${encodeURIComponent(slug)}`, {
        method: 'DELETE',
      }),
    preview: (repo: string, ref?: string): Promise<{ agents: ImportAgent[] }> =>
      this.request(queryPath('/admin/agents/import', { repo, ref })),
    version: (slug: string, version: number): Promise<D['version']> =>
      this.request(`/admin/agents/${encodeURIComponent(slug)}/versions/${version}`),
    /** Upload one agent's contents; a new version only when something changed. */
    put: (
      slug: string,
      body: {
        definition: unknown;
        systemPrompt: string;
        files?: Record<string, string>;
        name?: string;
        description?: string;
      },
    ): Promise<PushResult> =>
      this.request<Omit<PushResult, 'id'>>(`/admin/agents/${encodeURIComponent(slug)}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      }).then(result => ({
        id: slug,
        version: result.version,
        unchanged: result.unchanged,
      })),
    settings: (slug: string, settings: AgentSettings): Promise<D['record']> =>
      this.request(`/admin/agents/${encodeURIComponent(slug)}/settings`, {
        method: 'PATCH',
        body: JSON.stringify(settings),
      }),
    import: (repo: string, ref?: string, agents?: string[]): Promise<{ imported: string[] }> =>
      this.post('/admin/agents/import', {
        repo,
        ref,
        ...(agents ? { agents } : {}),
      }),
  };

  readonly folders = {
    list: (): Promise<LocalFolders> => this.request('/admin/folders'),
    check: (
      path: string,
    ): Promise<{ ok: true; folder: LocalFolder } | { ok: false; detail: string }> =>
      this.post('/admin/folders/check', { path }),
    /** Clones an https or ssh git URL with the server machine's git logins, or fetches it again. */
    clone: (
      url: string,
    ): Promise<{ ok: true; folder: LocalFolder } | { ok: false; detail: string }> =>
      this.post('/admin/folders/clone', { url }),
    /** Opens the folder dialog on the server's machine; a closed dialog answers `{ ok: false, detail: "" }`. */
    pick: (): Promise<{ ok: true; folder: LocalFolder } | { ok: false; detail: string }> =>
      this.post('/admin/folders/pick', {}),
  };

  readonly tasks = {
    run: (input: TaskInput): Promise<D['task']> => this.post('/admin/tasks', input),
    list: <Q extends TaskQuery = TaskQuery>(
      options?: Q,
    ): Promise<Q extends { cursor: string } ? TasksPage : D['task'][]> =>
      this.request(
        queryPath('/admin/tasks', {
          limit: 20,
          ...options,
          ...(options?.archived ? { archived: 1 } : {}),
          ...(options?.summary ? { summary: 1 } : {}),
          ...(options?.counts ? { counts: 1 } : {}),
        }),
      ),
    get: (id: string): Promise<D['task']> => this.request(`/admin/tasks/${encodeURIComponent(id)}`),
    logs: (id: string, after = -1, limit?: number): Promise<TaskLog[]> =>
      this.request(
        queryPath(`/admin/tasks/${encodeURIComponent(id)}/logs`, {
          after,
          limit,
        }),
      ),
    stream: (id: string, after = -1, signal?: AbortSignal): Promise<Response> =>
      this.send(`/admin/tasks/${encodeURIComponent(id)}/stream?after=${after}`, {
        headers: { accept: 'text/event-stream' },
        signal,
      }),
    cancel: (id: string): Promise<{ ok: true }> =>
      this.post(`/admin/tasks/${encodeURIComponent(id)}/cancel`),
    steer: (id: string, text: string) =>
      this.post(`/admin/tasks/${encodeURIComponent(id)}/steer`, { text }),
    ask: (id: string, question: string) =>
      this.post(`/admin/tasks/${encodeURIComponent(id)}/ask`, { question }),
    approve: (id: string, approvalId: string, decision: 'accept' | 'decline') =>
      this.post(`/admin/tasks/${encodeURIComponent(id)}/approve`, {
        approvalId,
        decision,
      }),
    archive: (id: string): Promise<{ ok: true }> =>
      this.post(`/admin/tasks/${encodeURIComponent(id)}/archive`),
    delete: (id: string): Promise<{ ok: true }> =>
      this.request(`/admin/tasks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    /** Start a task from a prompt, or a flow with `flow` and `args`. */
    create: <T extends TaskInput | { agent: string; event: D['event'] }>(
      input: T,
    ): Promise<T extends { event: D['event'] } ? { tasks: string[] } : D['task']> =>
      this.post('/admin/tasks', input),
    /** Ask a finished task something new, on the same thread. */
    continue: (
      id: string,
      text: string,
      options: { outputSchema?: object } = {},
    ): Promise<D['task']> =>
      this.post(`/admin/tasks/${encodeURIComponent(id)}/continue`, { text, ...options }),
    /** Follow the task's event stream until it ends; `onLog` sees each log line as it lands. */
    wait: async (
      id: string,
      options: { onLog?: (line: TaskLog) => void } = {},
    ): Promise<D['task']> => {
      let after = -1;
      for (;;) {
        const response = await this.tasks.stream(id, after);
        if (!response.ok || !response.body) {
          // `get` renews an expired token before the stream is asked again.
          const status = await this.tasks.get(id);
          if (DONE.has(status.status)) return status;
          if (response.status === 401) continue;
          throw new CoderError('server', `The task stream answered ${response.status}.`);
        }
        let ended = false;
        for await (const event of serverEvents(response.body)) {
          if (event.event === 'log') {
            const line = JSON.parse(event.data) as TaskLog;
            after = line.seq;
            options.onLog?.(line);
          } else if (event.event === 'end') ended = true;
        }
        if (ended) return this.tasks.get(id);
      }
    },
  };

  readonly credentials = {
    list: <Q extends PageQuery = PageQuery>(
      options?: Q,
    ): Promise<Q extends { cursor: string } ? Paged<D['credential']> : D['credential'][]> =>
      this.request(queryPath('/admin/credentials', options ?? {})),
    add: (input: {
      label?: string;
      env: Record<string, string>;
      engine: 'claude' | 'codex' | 'custom';
      workspace?: boolean;
      noCheck?: boolean;
      default?: boolean;
    }): Promise<{ ok: true; label: string }> => this.post('/admin/credentials', input),
    remove: (label: string, { workspace }: { workspace?: boolean } = {}): Promise<{ ok: true }> =>
      this.request(credentialPath(label, '', workspace), { method: 'DELETE' }),
    setDefault: (
      label: string,
      { workspace }: { workspace?: boolean } = {},
    ): Promise<{ ok: true }> => this.post(credentialPath(label, '/default', workspace)),
    login: (engine: 'claude' | 'codex'): Promise<D['login']> =>
      this.post('/admin/logins', { engine }),
    loginStatus: (id: string): Promise<D['login']> =>
      this.request(`/admin/logins/${encodeURIComponent(id)}`),
    loginCode: (id: string, code: string): Promise<{ ok: true }> =>
      this.post(`/admin/logins/${encodeURIComponent(id)}`, { code }),
    cancelLogin: (id: string): Promise<{ ok: true }> =>
      this.request(`/admin/logins/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  };

  readonly runners = {
    list: (): Promise<{ items: D['runner'][]; catalog: RunnerSpec[] }> =>
      this.request('/admin/runners'),
    add: (input: RunnerInput): Promise<D['runner']> => this.post('/admin/runners', input),
    pair: (input: { name?: string; scope: RunnerInput['scope'] }): Promise<RunnerPairing> =>
      this.post('/admin/runners/pair', input),
    update: (id: string, input: RunnerUpdate): Promise<D['runner']> =>
      this.request(`/admin/runners/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    test: (id: string): Promise<RunnerTest> =>
      this.post(`/admin/runners/${encodeURIComponent(id)}/test`, {}),
    remove: (id: string): Promise<{ ok: true }> =>
      this.request(`/admin/runners/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  };

  readonly integrations = {
    list: (): Promise<IntegrationInfo[]> => this.request('/admin/integrations'),
  };
  readonly repositories = {
    list: (): Promise<Array<{ repo: string; integration: string }>> =>
      this.request('/admin/repositories'),
  };
  readonly engines = {
    status: (): Promise<EngineStatus> => this.request('/admin/engines/status'),
    login: (engine: string): Promise<EngineStatus> =>
      this.post(`/admin/engines/${encodeURIComponent(engine)}/login`, {}),
    logout: (engine: string): Promise<EngineStatus> =>
      this.post(`/admin/engines/${encodeURIComponent(engine)}/logout`, {}),
  };
  readonly apps = {
    list: (agent?: string): Promise<Array<StoredRow<AppRow>>> =>
      this.request(queryPath('/admin/apps', { agent })),
    install: (id: string, back?: string): Promise<{ url: string }> =>
      this.post(queryPath(`/admin/apps/${encodeURIComponent(id)}/install`, { back })),
  };
  readonly installations = {
    list: (agent?: string): Promise<Array<StoredRow<InstallationRow>>> =>
      this.request(queryPath('/admin/installations', { agent })),
  };
  readonly connections = {
    add: (body: {
      installation: string;
      integration: string;
      token: string;
      account?: string;
    }): Promise<{ ok: true }> => this.post('/admin/connections', body),
  };
  readonly config = {
    get: (): Promise<ConfigShape> => this.request('/admin/config'),
    put: (body: Config): Promise<Config> =>
      this.request('/admin/config', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    patch: (body: import('./types').ConfigPatch): Promise<Config> =>
      this.request('/admin/config', {
        method: 'PATCH',
        headers: { 'content-type': 'application/merge-patch+json' },
        body: JSON.stringify(body),
      }),
  };
  readonly models = {
    list: (): Promise<ModelsShape> => this.request('/admin/models'),
    add: (body: {
      name: string;
      baseUrl: string;
      model: string;
      envKey?: string;
    }): Promise<Config> => this.post('/admin/models', body),
    probe: (body: { baseUrl: string; envKey?: string; key?: string }): Promise<ProbeResult> =>
      this.post('/admin/models/probe', body),
    remove: (name: string): Promise<Config> =>
      this.request(`/admin/models/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    alias: (name: string, spec: string): Promise<Config> =>
      this.post(`/admin/models/${encodeURIComponent(name)}/alias`, { spec }),
    enable: (name: string): Promise<Config> =>
      this.post(`/admin/models/${encodeURIComponent(name)}/enable`),
    disable: (name: string): Promise<Config> =>
      this.post(`/admin/models/${encodeURIComponent(name)}/disable`),
  };
  readonly mcp = {
    list: (): Promise<McpRows> => this.request('/admin/mcp'),
    add: (body: { name: string } & McpRows[string]): Promise<Config> =>
      this.post('/admin/mcp', body),
    remove: (name: string): Promise<Config> =>
      this.request(`/admin/mcp/${encodeURIComponent(name)}`, {
        method: 'DELETE',
      }),
    search: (q: string): Promise<Found[]> => this.request(queryPath('/admin/mcp-registry', { q })),
  };
  readonly flows = {
    list: (repo?: string): Promise<Array<{ name: string; scope: string }>> =>
      this.request(queryPath('/admin/flows', { repo })),
    run: (name: string, body: TaskInput): Promise<D['task']> =>
      this.post(`/admin/flows/${encodeURIComponent(name)}/run`, body),
  };
  readonly pulls = {
    list: (repo: string): Promise<Array<{ number: number; title: string }>> =>
      this.request(queryPath('/admin/pulls', { repo })),
  };
  review(body: TaskInput & { repo: string; pr: number; post?: boolean }): Promise<D['task']> {
    return this.post('/admin/review', body);
  }
  usage<Q extends UsageQuery = {}>(
    options: Q = {} as Q,
  ): Promise<
    Q extends { cursor: string }
      ? UsagePage
      : Q extends
            | { until: number }
            | { agent: string }
            | { tz: string }
            | { parts: string[] }
            | { top: number }
            | { by: 'day' }
        ? UsageReport
        : D['usage']
  > {
    return this.request(
      queryPath('/admin/usage/totals', {
        ...options,
        since: options.since ?? Date.now() - 7 * 24 * 60 * 60 * 1000,
      }),
    );
  }
  usageRows(installation?: string): Promise<Array<StoredRow<D['usageRow']>>> {
    return this.request(queryPath('/admin/usage', { installation }));
  }
}

/** Server-Sent Events from a response body, one `{ event, data }` per message. */
export async function* serverEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event: ')) event = line.slice(7);
        else if (line.startsWith('data: ')) data.push(line.slice(6));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}
