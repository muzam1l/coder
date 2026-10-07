import type { ServerContext } from './context';
import type { TaskStatus } from './store/types';
import { readVersion } from '../core/runtime';
import { localTasks } from './tasks/local';
import {json} from './routes/http';

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

/** Probes poll this; a healthy answer is reused for 5 s so the database sees one check per interval, a failure is rechecked at once. */
export async function health(ctx: ServerContext): Promise<Response> {
  const now = (ctx.now ?? Date.now)();
  const kept = ctx.health;
  const { body, status } = kept && now - kept.at < 5_000 ? kept : await probe(ctx);
  ctx.health =
    status === 200
      ? { at: kept && now - kept.at < 5_000 ? kept.at : now, body, status }
      : undefined;

  const uptime = Math.max(0, now - (ctx.limits?.startedAt ?? now)) / 1000;
  return json({ ...(body as object), uptime }, status, { 'cache-control': 'no-store' });
}

async function probe(ctx: ServerContext) {
  let db: 'ok' | 'down' | 'none' = ctx.config.store === 'postgres' ? 'down' : 'none';
  let counts = { online: 0, total: 0 };
  let ok = true;
  try {
    if (ctx.config.store === 'postgres') {
      if (!ctx.databaseHealth) throw new Error('Database health probe is unavailable');
      await ctx.databaseHealth();
      db = 'ok';
    }
    counts = ctx.healthRunners ? await ctx.healthRunners() : await runners(ctx);
  } catch {
    ok = false;
    if (ctx.config.store === 'postgres') db = 'down';
  }
  return { body: { ok, version: readVersion(), db, runners: counts }, status: ok ? 200 : 503 };
}

export async function metrics(ctx: ServerContext) {
  const now = (ctx.now ?? Date.now)();
  if (ctx.queue.metrics && !ctx.local) {
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
