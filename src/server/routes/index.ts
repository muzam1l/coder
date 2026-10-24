import { localHostAllowed, requestScope } from './guards';
import { dispatch } from './match';
import { bodyLimit, limitBody, notFound, untilSent, withCookies } from './http';
import { type ServerContext } from '../context';
import { dashboard, DashboardHosts } from '../dash/serve';
import { ServerLimits, admit, type Admitted } from '../limits';
import { scheduleKick } from '../tasks/kick';
import { scheduleInbox } from '../tasks/queue';
import { routes } from './routes';
import { LogWatcher, TaskWatcher } from '../tasks/stream';

async function serve(
  req: Request,
  ctx: ServerContext,
  admitted: Admitted,
): Promise<Response> {
  if (!localHostAllowed(req, ctx)) return notFound();
  const url = new URL(req.url);
  if (admitted.scope instanceof Response) return admitted.scope;
  ctx = admitted.scope ?? ctx;
  return (await dispatch(routes, req, ctx, url)) ?? dashboard(req, ctx);
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
    if (
      req.method !== 'GET' &&
      response.ok &&
      !['hooks', 'tasks', 'logins'].includes(parts[1]!) &&
      !(admitted instanceof Response)
    ) {
      const tenant = admitted.scope instanceof Response ? undefined : (admitted.scope ?? scope.ctx);
      if (tenant) scheduleInbox(tenant, tenant.organizationId);
    }
    if (
      req.method !== 'GET' &&
      response.ok &&
      !(task && parts.length === 4 && parts[2] && ['heartbeat', 'logs'].includes(parts[3]!)) &&
      !(
        adminTask &&
        parts.length === 5 &&
        parts[3] &&
        ['steer', 'ask', 'approve', 'archive'].includes(parts[4]!)
      ) &&
      (task ||
        adminTask ||
        (parts[1] === 'admin' &&
          parts[2] === 'flows' &&
          parts.length === 5 &&
          parts[3] &&
          parts[4] === 'run'))
    )
      scheduleKick(ctx, adminTask && parts.length === 3 && req.method === 'POST');
    streamed =
      Boolean(response.body) && (response.headers.get('content-type') ?? '').includes('text/html');
    return streamed ? untilSent(response, scope.end) : response;
  } finally {
    if (!streamed) scope.end();
  }
}
