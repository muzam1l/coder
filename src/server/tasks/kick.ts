import type { TaskStatus } from '../store/types';
import { SERVER_LIMITS } from '../limits';
import { scoped, type ServerContext } from '../context';
import { taskCredential, taskHosts } from './context';
import type { ClaimedTask, TaskFence } from './queue';
import { taskRunner, type Runner } from '../runners';
import { startQueuedLocalTask, inspectLocalTask, localTasks, sweepLocalQueue } from './local';
import { loadTask } from '../../core/state';

function deadline<T>(work: Promise<T>, ms: number, operation: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${operation} timed out`)), ms);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function stop(
  ctx: ServerContext,
  runner: Runner,
  handle: string,
  taskId: string,
): Promise<boolean> {
  try {
    await deadline(runner.stop(handle), ctx.runnerTimeoutMs ?? 10_000, 'runner stop');
  } catch (error) {
    console.error(`coder server: runner stop ${taskId} failed`, error);
    return false;
  }

  return true;
}

async function fail(
  ctx: ServerContext,
  status: TaskStatus,
  error: string,
  fence: TaskFence = {},
): Promise<boolean> {
  const runner = status.handle ? await taskRunner(ctx, status.task) : undefined;
  const finished = await ctx.queue.finish(
    ctx.organizationId,
    status.task.id,
    { status: 'failed', error },
    (ctx.now ?? Date.now)(),
    {
      attempts: status.attempts,
      tokenHash: status.tokenHash ?? null,
      generation: status.generation ?? 0,
      ...fence,
    },
  );
  if (finished) await stopTaskMachine(ctx, status, true, runner);

  return finished;
}

async function inspect(ctx: ServerContext, status: TaskStatus, now: number): Promise<boolean> {
  if (ctx.local && status.handle?.startsWith('cli:')) return inspectLocalTask(ctx, status, now);
  const runner = status.handle ? await taskRunner(ctx, status.task) : undefined;
  const activity = {
    handle: status.handle ?? null,
    lastSeenAt: status.lastSeenAt ?? null,
    updatedAt: status.updatedAt,
  };
  if (status.cancelRequestedAt !== undefined && now - status.cancelRequestedAt >= 30_000) {
    const finished = await ctx.queue.finish(
      ctx.organizationId,
      status.task.id,
      {
        status: 'cancelled',
        error: 'The runner did not acknowledge cancellation within 30 seconds',
      },
      now,
      {
        attempts: status.attempts,
        tokenHash: status.tokenHash,
        generation: status.generation ?? 0,
      },
    );
    if (finished) await stopTaskMachine(ctx, status, true, runner);
    return finished;
  }
  if (!status.handle) {
    if (
      now - (status.lastSeenAt ?? status.startedAt ?? status.updatedAt) <
      (ctx.config.taskStallMs ?? 5 * 60 * 1000)
    )
      return false;
    if (status.attempts >= (ctx.config.taskAttempts ?? 2))
      return fail(ctx, status, 'runner start was interrupted', activity);
    return ctx.queue.requeue(ctx.organizationId, status.task.id, now, {
      generation: status.generation ?? 0,
      attempts: status.attempts,
      tokenHash: status.tokenHash ?? null,
      ...activity,
    });
  }
  if (status.startedAt !== undefined && now - status.startedAt >= ctx.config.taskTimeoutMs)
    return fail(ctx, status, 'timeout');
  if (!runner) return false;
  const seen = status.lastSeenAt ?? status.startedAt ?? status.updatedAt;
  if (now - seen < Math.min(ctx.config.taskStallMs ?? 60_000, 60_000)) return false;
  const checked = await ctx.store.withAppLock(
    `runner-status:${ctx.organizationId}:${status.task.id}`,
    async store => {
      const key = `runner-status:${status.task.id}:${status.generation ?? 0}:${status.attempts}`;
      const prior = await store.get('delivery', key);
      if (prior && 'at' in prior && prior.at !== undefined && now - prior.at < 30_000) return false;
      await store.put('delivery', key, { at: now }, { ttlMs: 60_000 });
      return true;
    },
  );
  if (!checked) return false;
  const state = await deadline(runner.status(status.handle), ctx.runnerTimeoutMs ?? 10_000, 'runner status');
  if (state.state === 'exited')
    return fail(
      ctx,
      status,
      `runner exited${state.code === undefined ? '' : ` with code ${state.code}`}`,
      { handle: status.handle, lastSeenAt: status.lastSeenAt ?? null },
    );
  return fail(ctx, status, 'The runner stopped reporting heartbeats', {
    handle: status.handle,
    lastSeenAt: status.lastSeenAt ?? null,
  });
}

export async function inspectTask(ctx: ServerContext, status: TaskStatus): Promise<TaskStatus> {
  if (!['running', 'waiting'].includes(status.status)) return status;
  const changed = await inspect(ctx, status, (ctx.now ?? Date.now)()).catch(() => false);

  return changed ? ((await ctx.store.get('task', status.task.id)) ?? status) : status;
}

export async function stopTaskMachine(
  ctx: ServerContext,
  status: TaskStatus,
  force = false,
  captured?: Runner,
): Promise<void> {
  const key = `${ctx.organizationId}:${status.task.id}:${status.attempts}`;
  const check = ctx.settings?.cancelChecks?.get(key);
  if (check) {
    clearTimeout(check.timer);
    check.finish();
    ctx.settings!.cancelChecks!.delete(key);
  }
  if (!status.handle || status.logsComplete) return;
  const runner = captured ?? (await taskRunner(ctx, status.task));
  if (runner && (force || runner.kind === 'vercel-sandbox' || runner.kind === 'local-docker'))
    if (!(await stop(ctx, runner, status.handle, status.task.id))) return;
  await ctx.queue.patchTask(
    ctx.organizationId,
    status.task.id,
    { logsComplete: true },
    (ctx.now ?? Date.now)(),
    {
      attempts: status.attempts,
      tokenHash: status.tokenHash,
      generation: status.generation ?? 0,
      handle: status.handle,
    },
  );
}

export function scheduleCancel(ctx: ServerContext, status: TaskStatus): void {
  const key = `${ctx.organizationId}:${status.task.id}:${status.attempts}`;
  const checks = ((ctx.settings ??= {}).cancelChecks ??= new Map());
  if (checks.has(key)) return;
  const work = new Promise<void>(resolve => {
    const timer = setTimeout(resolve, 30_000);
    checks.set(key, { timer, finish: resolve });
  })
    .then(async () => {
      checks.delete(key);
      const current = await ctx.store.get('task', status.task.id);
      if (current && current.attempts === status.attempts && current.tokenHash === status.tokenHash)
        await inspectTask(ctx, current);
    })
    .catch(error => console.error('coder server: cancellation check failed', error));
  if (ctx.waitUntil) ctx.waitUntil(work);
  else void work;
}

async function run(ctx: ServerContext, sweep: boolean, knownWork: boolean): Promise<void> {
  const now = ctx.now ?? Date.now;
  const concurrentTasks = ctx.config.limits?.concurrentTasks ?? SERVER_LIMITS.concurrentTasks;
  const maxTasks =
    ctx.config.store === 'postgres'
      ? ctx.config.maxTasks
      : Math.min(concurrentTasks, ctx.config.maxTasks ?? concurrentTasks);
  {
    if (sweep && ctx.local) await sweepLocalQueue(ctx, ctx.local.cwd);
    else if (sweep) await ctx.queue.archiveStopped(undefined, now());
    const running = await ctx.queue.running();
    let freed = 0;
    for (const claimed of running) {
      const taskCtx = scoped(ctx, claimed.organizationId);
      if (await inspect(taskCtx, claimed.status, now()).catch(() => false)) freed++;
    }
    if (maxTasks !== undefined && running.length - freed >= maxTasks) return;
  }
  const retries: ClaimedTask[] = [];
  while (true) {
    const local = ctx.local
      ? localTasks(ctx.local.cwd, false).filter(
          row => row.status === 'running' || row.status === 'waiting',
        )
      : [];
    const managed = local.length
      ? new Set(
          (await ctx.queue.running()).flatMap(row => [
            row.status.task.id,
            ...(row.status.handle?.startsWith('cli:') ? [row.status.handle.slice(4)] : []),
          ]),
        )
      : new Set<string>();
    const occupied = local.filter(
      row =>
        !managed.has(row.task.id) &&
        !managed.has(loadTask(row.task.cwd ?? ctx.local!.cwd, row.task.id)?.flowRunId ?? ''),
    ).length;
    const available = maxTasks === undefined ? undefined : maxTasks - occupied;
    if (available !== undefined && available <= 0) break;
    const claimed = await ctx.queue.claim(now(), available, knownWork, concurrentTasks);
    knownWork = false;
    if (!claimed) break;
    const taskCtx = scoped(ctx, claimed.organizationId);
    const status = claimed.status;
    if (await startQueuedLocalTask(taskCtx, status)) {
      knownWork = claimed.more;
      if (!claimed.more) break;
      continue;
    }
    const runner = await taskRunner(taskCtx, status.task);
    if (!runner) {
      await fail(taskCtx, status, `No runner available: ${status.task.runner}`);
      continue;
    }
    const pending = status;
    const active = {
      generation: status.generation ?? 0,
      attempts: status.attempts,
      tokenHash: status.tokenHash ?? null,
      statuses: ['running', 'waiting'] as TaskStatus['status'][],
    };
    let handle: string | undefined;
    try {
      const credential =
        runner.kind === 'vercel-sandbox' ? await taskCredential(taskCtx, status.task) : undefined;
      const start = runner.start(
        status.task,
        {
          CODER_SERVER:
            taskCtx.local && runner.kind === 'local'
              ? `http://localhost:${taskCtx.local.port}`
              : (taskCtx.config.publicUrl ?? ''),
          CODER_TASK_TOKEN: claimed.token,
          CODER_INBOX_MODE: runner.push ? 'push' : 'poll',
        },
        credential?.env,
        {
          timeoutMs: taskCtx.config.taskTimeoutMs + 60_000,
          waitUntil: taskCtx.waitUntil,
          ...(credential ? { hosts: await taskHosts(taskCtx, status.task, credential) } : {}),
        },
      );
      handle = await deadline(start, taskCtx.runnerTimeoutMs ?? 30_000, 'runner start').catch(error => {
        void start.then(
          handle => stop(taskCtx, runner, handle, status.task.id),
          () => {},
        );
        throw error;
      });
      if (
        !(await taskCtx.queue.patchTask(
          claimed.organizationId,
          status.task.id,
          { handle },
          now(),
          active,
        ))
      )
        await stop(taskCtx, runner, handle, status.task.id);
      knownWork = claimed.more;
      if (!claimed.more) break;
    } catch (error) {
      if (handle !== undefined) await stop(taskCtx, runner, handle, status.task.id);
      const message = error instanceof Error ? error.message : String(error);
      if (status.attempts < (taskCtx.config.taskAttempts ?? 2)) {
        retries.push({ ...claimed, status: pending });
        continue;
      } else {
        await fail(taskCtx, pending, message);
      }
    }
  }
  for (const claimed of retries) {
    const taskCtx = scoped(ctx, claimed.organizationId);
    await taskCtx.queue.requeue(claimed.organizationId, claimed.status.task.id, now(), {
      attempts: claimed.status.attempts,
      tokenHash: claimed.status.tokenHash,
    });
  }
}

/** Re-entrant-safe scheduler for request hooks and the serve timer. */
export function kick(
  ctx: ServerContext,
  coalesce = false,
  sweep = false,
  knownWork = false,
): Promise<void> {
  const scheduler = (ctx.queue.scheduler ??= {});
  // A kick that has not started yet sees every later change, so request hooks share it.
  const queued = coalesce ? scheduler.waiting : undefined;
  if (queued) return queued;
  const prior = scheduler.running ?? Promise.resolve();
  const start = () => {
    if (scheduler.waiting === next) delete scheduler.waiting;
    return run(ctx, sweep, knownWork);
  };
  const next: Promise<void> = prior.then(start, start);
  scheduler.waiting = next;
  scheduler.running = next.catch(() => {});
  return next;
}

export function scheduleKick(ctx: ServerContext, knownWork = false): void {
  const work = kick(ctx, true, false, knownWork).catch(() => {});
  if (ctx.waitUntil) ctx.waitUntil(work);
  else void work;
}
