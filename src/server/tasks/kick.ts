import type { TaskStatus } from '../store/types';
import { checkCpuMinutes, CpuMinutesError, usageLimits } from './usage';
import { scoped, type ServerContext } from '../context';
import { loadedStore } from '../store/primed';
import { firstModel, machineFirewall } from './context';
import { createClaim } from './access';
import type { ClaimedTask, RunningTask, TaskFence } from './queue';
import type { Runner } from '../runners';
import { taskRunner } from '../runners/select';
import {
  startQueuedLocalTask,
  inspectLocalTask,
  localTasks,
  syncLocalApprovals,
  sweepLocalQueue,
} from './local';
import { loadTask } from '../../core/state';
import { syncDuePosts } from './approvals';
import { deliverWaiting } from './conversation';

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
  status: RunningTask,
  error: string | CpuMinutesError,
  fence: TaskFence = {},
): Promise<boolean> {
  const runner = status.handle ? await taskRunner(ctx, status.task) : undefined;
  const finished = await ctx.queue.finish(
    ctx.organizationId,
    status.task.id,
    { status: 'failed', error: error instanceof Error ? error.message : error },
    (ctx.now ?? Date.now)(),
    {
      attempts: status.attempts,
      tokenHash: status.tokenHash ?? null,
      generation: status.generation ?? 0,
      ...fence,
    },
  );
  if (finished) {
    const { reportTaskFailure } = await import('./events');
    const failed = await ctx.store.get('task', status.task.id);
    if (failed) await reportTaskFailure(ctx, failed, error);
    await stopTaskMachine(ctx, status, true, runner);
    if (failed) deliverWaiting(ctx, failed.task);
  }

  return finished;
}

async function inspect(ctx: ServerContext, status: RunningTask, now: number): Promise<boolean> {
  if (ctx.local && status.handle?.startsWith('cli:')) {
    const local = await ctx.store.get('task', status.task.id);
    return local ? inspectLocalTask(ctx, local, now) : false;
  }
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
    if (finished) {
      await stopTaskMachine(ctx, status, true, runner);
      const cancelled = await ctx.store.get('task', status.task.id);
      if (cancelled) deliverWaiting(ctx, cancelled.task);
    }
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
  const state = await deadline(
    runner.status(status.handle),
    ctx.runnerTimeoutMs ?? 10_000,
    'runner status',
  );
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
  status: RunningTask,
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

/** Reads once per organization for one kick run. */
function perOrganization<T>(read: (organizationId: string) => Promise<T>) {
  const known = new Map<string, Promise<T>>();
  return (organizationId: string) => {
    if (!known.has(organizationId)) known.set(organizationId, read(organizationId));
    return known.get(organizationId)!;
  };
}

async function run(ctx: ServerContext, sweep: boolean, knownWork: boolean): Promise<void> {
  const now = ctx.now ?? Date.now;
  const maxTasks = ctx.config.maxTasks;
  let logged = false;
  const limitsOf = perOrganization(organizationId =>
    deadline(usageLimits(scoped(ctx, organizationId)), 5_000, 'usage limits').catch(error => {
      if (!logged) console.error('coder server: usage limits failed', error);
      logged = true;
      throw error;
    }),
  );
  const usageOf = perOrganization(organizationId =>
    scoped(ctx, organizationId).store.serverRunnerUsage(now()),
  );
  const remainingOf = async ({
    organizationId,
    status,
  }: {
    organizationId: string;
    status: RunningTask;
  }) =>
    status.task.vcpus
      ? checkCpuMinutes(
          scoped(ctx, organizationId),
          status.task,
          await limitsOf(organizationId),
          () => usageOf(organizationId),
        )
      : undefined;
  const concurrentTasks =
    ctx.usageLimits || ctx.config.usageLimits?.maxConcurrentTasks !== undefined
      ? (organizationId: string) =>
          // A workspace whose limits are unavailable runs no charged task this pass.
          limitsOf(organizationId).then(
            limits => limits.maxConcurrentTasks,
            () => 0,
          )
      : undefined;
  {
    if (sweep && ctx.local)
      await Promise.all([sweepLocalQueue(ctx, ctx.local.cwd), syncLocalApprovals(ctx)]);
    else if (sweep)
      await Promise.all([ctx.queue.archiveStopped(undefined, now()), syncDuePosts(ctx)]);
    const running = await ctx.queue.running();
    // Charged workspaces' limits load together, so hanging hooks share one deadline.
    for (const { organizationId, status } of running)
      if (status.task.vcpus) void limitsOf(organizationId).catch(() => {});
    let freed = 0;
    for (const claimed of running) {
      const taskCtx = scoped(ctx, claimed.organizationId);
      try {
        await remainingOf(claimed);
      } catch (error) {
        if (error instanceof CpuMinutesError) {
          if (await fail(taskCtx, claimed.status, error).catch(() => false)) freed++;
          continue;
        }
      }
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
    const status = claimed.status;
    const orgCtx = scoped(ctx, claimed.organizationId);
    const taskCtx =
      claimed.loaded && orgCtx.store
        ? { ...orgCtx, store: loadedStore(orgCtx.store, status, claimed.loaded) }
        : orgCtx;
    let timeoutMs = taskCtx.config.taskTimeoutMs + 60_000;
    try {
      const remaining = await remainingOf(claimed);
      if (remaining !== undefined) timeoutMs = Math.min(timeoutMs, remaining + 60_000);
    } catch (error) {
      if (error instanceof CpuMinutesError) await fail(taskCtx, status, error);
      else retries.push(claimed);
      knownWork = claimed.more;
      continue;
    }
    if (await startQueuedLocalTask(taskCtx, status, claimed.token)) {
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
      const firewall =
        runner.kind === 'vercel-sandbox' ? await machineFirewall(taskCtx, status.task) : undefined;
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
        firewall?.credential,
        {
          timeoutMs,
          waitUntil: taskCtx.waitUntil,
          ...(firewall ? { hosts: firewall.hosts, brokered: firewall.brokered } : {}),
          claim: () => createClaim(taskCtx, claimed.token),
        },
      );
      handle = await deadline(start, taskCtx.runnerTimeoutMs ?? 30_000, 'runner start').catch(
        error => {
          void start.then(
            handle => stop(taskCtx, runner, handle, status.task.id),
            () => {},
          );
          throw error;
        },
      );
      // The list shows the model each turn starts with, recorded with its handle.
      const model = firstModel(status.task);
      if (
        !(await taskCtx.queue.patchTask(
          claimed.organizationId,
          status.task.id,
          {
            handle,
            ...(model && model !== status.task.usage?.resolvedModel
              ? { resolvedModel: model }
              : {}),
          },
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
