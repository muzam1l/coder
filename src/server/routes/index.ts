import { localHostAllowed } from './guards';
import { dispatch } from './match';
import { pagesFallback } from '../dash/serve';
import { bodyLimit, limitBody, notFound } from './http';
import { heartbeat } from '../tasks/callbacks';
import { review } from '../tasks/flows';
import { type ServerContext, type SessionInfo } from '../context';
import { DashboardHosts } from '../dash/serve';
import { randomUUID } from 'node:crypto';
import { ServerLimits, admit, type Admitted } from '../limits';
import { scheduleKick } from '../tasks/kick';
import { scheduleInbox } from '../tasks/queue';
import { routes } from './routes';
import { LogWatcher, TaskWatcher } from '../tasks/stream';

export async function serve(
  req: Request,
  ctx: ServerContext,
  admitted: Admitted,
): Promise<Response> {
  if (!localHostAllowed(req, ctx)) return notFound();
  const url = new URL(req.url);
  if (admitted.scope instanceof Response) return admitted.scope;
  ctx = admitted.scope ?? ctx;
  return (await dispatch(routes, req, ctx, url)) ?? pagesFallback(req, ctx, url);
}

export const REQUEST_SCOPE_HEADER = 'x-coder-request-scope';

export type RequestScope = {
  sessions: Map<string, Promise<SessionInfo | undefined>>;
  /** Refreshed or cleared session cookies the response carries. */
  cookies: string[];
};

function shareSessions(ctx: ServerContext, { sessions, cookies }: RequestScope): ServerContext {
  const auth = ctx.auth;
  if (!auth) return ctx;
  return {
    ...ctx,
    auth: {
      ...auth,
      session(headers, fresh) {
        const key = JSON.stringify([
          ...['cookie', 'authorization', 'x-coder-organization'].map(name => headers.get(name)),
          Boolean(fresh),
        ]);
        let found = sessions.get(key);
        if (!found) {
          found = auth.session(headers, fresh, cookies);
          sessions.set(key, found);
        }
        return found;
      },
    },
  };
}

function requestScope(req: Request, ctx: ServerContext, inProcess: boolean) {
  const scopes = (ctx.requestScopes ??= new Map());
  const given = req.headers.get(REQUEST_SCOPE_HEADER);
  const live = inProcess && given ? scopes.get(given) : undefined;
  if (live) return { req, ctx: shareSessions(ctx, live), end() {} };
  const headers = new Headers(req.headers);
  headers.delete(REQUEST_SCOPE_HEADER);
  if (!ctx.auth) return { req: given ? new Request(req, { headers }) : req, ctx, end() {} };
  const id = randomUUID();
  const scope: RequestScope = { sessions: new Map(), cookies: [] };
  scopes.set(id, scope);
  headers.set(REQUEST_SCOPE_HEADER, id);
  return {
    req: new Request(req, { headers }),
    ctx: shareSessions(ctx, scope),
    cookies: scope.cookies,
    end: () => scopes.delete(id),
  };
}

export async function handleRequest(
  req: Request,
  ctx: ServerContext,
  options: { inProcess?: boolean; clientIp?: string } = {},
): Promise<Response> {
  ctx.limits ??= new ServerLimits((ctx.now ?? Date.now)());
  ctx.limits.requests++;
  ctx.settings ??= {};
  ctx.taskWatcher ??= new TaskWatcher();
  ctx.logWatcher ??= new LogWatcher();
  ctx.dashboardHosts ??= new DashboardHosts();
  const work = () => request(req, ctx, options);
  return ctx.dbProfile ? ctx.dbProfile.request(options.inProcess === true, work) : work();
}

async function request(
  req: Request,
  ctx: ServerContext,
  options: { inProcess?: boolean; clientIp?: string },
): Promise<Response> {
  const checked = await limitBody(req, bodyLimit(new URL(req.url).pathname));
  if (checked instanceof Response) return checked;
  const scope = requestScope(checked, ctx, options.inProcess === true);
  let streamed = false;
  try {
    const ip = options.clientIp ?? 'unknown';
    const admitted = await admit(scope.req, scope.ctx, ip);
    const response = withCookies(
      admitted instanceof Response ? admitted : await serve(scope.req, scope.ctx, admitted),
      scope.cookies,
    );
    const parts = new URL(req.url).pathname.split('/');
    const task = parts[1] === 'tasks';
    const adminTask = parts[1] === 'admin' && parts[2] === 'tasks';
    if (req.method !== 'GET' && response.ok && !['hooks', 'tasks', 'logins'].includes(parts[1]!))
      scheduleInbox(ctx);
    if (
      req.method !== 'GET' &&
      response.ok &&
      !(task && parts.length === 4 && parts[2] && parts[3] === 'heartbeat') &&
      !(
        adminTask &&
        parts.length === 5 &&
        parts[3] &&
        ['steer', 'ask', 'approve', 'archive'].includes(parts[4]!)
      ) &&
      (task ||
        adminTask ||
        (parts[1] === 'admin' && parts[2] === 'review') ||
        (parts[1] === 'admin' &&
          parts[2] === 'flows' &&
          parts.length === 5 &&
          parts[3] &&
          parts[4] === 'run'))
    )
      scheduleKick(
        ctx,
        (adminTask && parts.length === 3 && req.method === 'POST') ||
          (adminTask && parts.length === 5 && Boolean(parts[3]) && parts[4] === 'continue'),
      );
    streamed =
      Boolean(response.body) && (response.headers.get('content-type') ?? '').includes('text/html');
    return streamed ? untilSent(response, scope.end) : response;
  } finally {
    if (!streamed) scope.end();
  }
}

function withCookies(response: Response, cookies: string[] = []): Response {
  if (!cookies.length) return response;
  const headers = new Headers(response.headers);
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function untilSent(response: Response, end: () => void): Response {
  const reader = response.body!.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          end();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        end();
        controller.error(error);
      }
    },
    cancel(reason) {
      end();
      return reader.cancel(reason);
    },
  });
  return new Response(body, response);
}
