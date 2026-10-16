import type { ServerContext } from './context';
import type { TaskStatus } from './store/types';
import { localTasks } from './tasks/local';
import { json } from './routes/http';

/** Paired and configured runners plus the server's own built-in one, which is always up while the server answers. */
async function runners(ctx: ServerContext) {
  const now = (ctx.now ?? Date.now)();
  const rows = await ctx.store.list('runner');

  return {
    online:
      1 +
      rows.filter(({ value }) => value.lastSeen !== undefined && now - value.lastSeen < 300_000)
        .length,
    total: 1 + rows.length,
  };
}

/** Probes poll this; a pass is reused for 5 s so the database sees one check per interval, a failure is rechecked at once. */
export async function health(ctx: ServerContext): Promise<Response> {
  const now = (ctx.now ?? Date.now)();
  const kept = ctx.healthyAt !== undefined && now - ctx.healthyAt < 5_000;
  const ok = kept || (await probe(ctx));
  ctx.healthyAt = ok ? (kept ? ctx.healthyAt : now) : undefined;
  return json({ ok }, ok ? 200 : 503, { 'cache-control': 'no-store' });
}

/** In postgres mode, a live database query; other modes answer while the server does. */
async function probe(ctx: ServerContext) {
  if (ctx.config.store !== 'postgres') return true;
  if (!ctx.databaseHealth) return false;
  return ctx.databaseHealth().then(
    () => true,
    () => false,
  );
}

export async function metrics(ctx: ServerContext) {
  const now = (ctx.now ?? Date.now)();
  if (!ctx.local) {
    return {
      ...(await ctx.queue.metrics(ctx.organizationId, now - 86_400_000)),
      runnersOnline: (await runners(ctx)).online,
      requests: ctx.limits?.requests ?? 0,
      rateLimitRejections: ctx.limits?.rejections ?? 0,
    };
  }
  const queued = await ctx.queue.list(ctx.organizationId);
  const local = ctx.local
    ? [...localTasks(ctx.local.cwd, false), ...localTasks(ctx.local.cwd, true)]
    : [];
  const rows = new Map(
    [
      ...local,
      ...queued.map(row =>
        row.status === 'queued' ? row : (local.find(item => item.task.id === row.task.id) ?? row),
      ),
    ].map(row => [row.task.id, row]),
  );
  const tasks: Record<TaskStatus['status'], number> = {
    queued: 0,
    running: 0,
    waiting: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  let queueDepth = 0;
  for (const row of rows.values()) {
    if (row.createdAt >= now - 86_400_000) tasks[row.status]++;
    if (row.status === 'queued') queueDepth++;
  }
  return {
    tasks,
    queueDepth,
    runnersOnline: (await runners(ctx)).online,
    requests: ctx.limits?.requests ?? 0,
    rateLimitRejections: ctx.limits?.rejections ?? 0,
  };
}
