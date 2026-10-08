import { type TaskStatus } from '../store/types';
import { decodeCursor, json, page, pageLimit, paged } from '../routes/http';
import {
  TaskInputError,
  continueTask,
  createTask,
  taskCwd,
  taskTurns,
  type NewTask,
} from './create';
import { parseCredentialId } from '../settings/credentials';
import { type Params } from '../routes/match';
import { type ServerContext } from '../context';
import { taskRunner } from '../runners';
import {
  inspectLocalTask,
  localLog,
  localTask,
  localTaskAction,
  localTasks,
  startLocalTask,
} from './local';
import { scheduleKick } from './kick';
import { copyRunnerLogs, readLog } from './logs';
import {
  ACTIVE_STATES,
  addInbox,
  deleteTask,
  matchesTask,
  listOrder,
  afterCursor,
  listCursor,
  type ListCursor,
  pushInbox,
  type TaskFilter,
} from './queue';
import { randomUUID } from 'node:crypto';
import { decryptSecret } from '../store/secrets';
import { type AgentEvent, type TaskSource } from '../../agent/types';
import { eventReplies } from '../chat';
import { dispatchEvent } from './events';
import { start } from './flows';

export const DONE = new Set<TaskStatus['status']>(['completed', 'failed', 'cancelled']);

export function taskError(error: unknown): Response {
  if (error instanceof TaskInputError)
    return json({ error: error.message, ...(error.fix ? { fix: error.fix } : {}) }, error.status);
  throw error;
}

export function summarizeTask(status: TaskStatus) {
  const { id, name, source, agent, flow, event, prompt, cwd } = status.task;
  return {
    task: {
      id,
      ...(name ? { name } : {}),
      source,
      agent,
      flow,
      ...(cwd ? { cwd } : {}),
      ...(prompt ? { prompt } : {}),
      ...(event
        ? { event: { integration: event.integration, type: event.type, text: event.text } }
        : {}),
    },
    status: status.status,
    ...(status.status === 'queued' ? { statusReason: 'Waiting for a task slot' } : {}),
    attempts: status.attempts,
    createdAt: status.createdAt,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
  };
}

export function redactTask(
  status: TaskStatus,
): Omit<TaskStatus, 'tokenHash' | 'handle'> & { handle?: never } {
  const { tokenHash: _tokenHash, handle: _handle, ...safe } = status;
  return {
    ...safe,
    ...(status.status === 'queued' ? { statusReason: 'Waiting for a task slot' } : {}),
    turns: taskTurns(status),
    ...(status.task.credential
      ? { credential: parseCredentialId(status.task.credential).label }
      : {}),
  };
}

export async function readTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const stored = readLog(ctx.store, taskId, cursor, lines ?? 500);
  stored?.catch(() => {});

  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    const local = localTask(cwd, taskId, true);
    if (!local) return json({ error: `No task "${taskId}"` }, 404);

    return json({
      ...local,
      ...(status?.answer ? { answer: status.answer } : {}),
      logs: localLog(cwd, taskId, -1, lines ?? 500),
    });
  }

  const logs =
    status.task.runner === 'github-actions' && status.handle
      ? await copyRunnerLogs(ctx, status, cursor, lines ?? 500).catch(() => stored!)
      : await stored!;

  return json({ ...redactTask(status), logs });
}

export async function removeTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    return localTaskAction(req, cwd, taskId, undefined, ctx);
  }
  if (ctx.local && status.handle?.startsWith('cli:')) {
    const now = (ctx.now ?? Date.now)();
    await ctx.queue.cancel(ctx.organizationId, taskId, now, {
      attempts: status.attempts,
      tokenHash: status.tokenHash,
      generation: status.generation ?? 0,
    });

    const current = await ctx.store.get('task', taskId);
    if (current && ACTIVE_STATES.includes(current.status)) {
      await inspectLocalTask(ctx, current, now);

      const stopped = await ctx.store.get('task', taskId);
      if (stopped && ACTIVE_STATES.includes(stopped.status))
        return json({ error: 'Task is still stopping. Try again.' }, 409);
    }
  } else if (['running', 'waiting'].includes(status.status) && status.handle) {
    try {
      const runner = await taskRunner(ctx, status.task);
      if (!runner) return json({ error: 'Task runner is unavailable. Try again.' }, 409);
      await runner.stop(status.handle);
    } catch {
      return json({ error: 'Task is still stopping. Try again.' }, 409);
    }
  }
  if (!(await deleteTask(ctx, status)))
    return json({ error: 'Task changed while deleting. Try again.' }, 409);
  if (ctx.local) {
    await ctx.store.delete('snapshot', `local-start:${taskId}`);
    await ctx.store.delete('snapshot', `completion:${taskId}`);
  }
  scheduleKick(ctx, true);

  return json({ ok: true });
}

export async function taskLogs(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const stored = readLog(ctx.store, taskId, cursor, lines ?? undefined);
  stored?.catch(() => {});

  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    const local = localTask(cwd, taskId, false);
    if (!local) return json({ error: `No task "${taskId}"` }, 404);

    return json(localLog(cwd, taskId, cursor, lines));
  }

  return json(
    (['running', 'waiting'].includes(status.status) || status.task.runner === 'github-actions') &&
      status.handle
      ? await copyRunnerLogs(ctx, status, cursor, lines).catch(() =>
          readLog(ctx.store, taskId, cursor, lines),
        )
      : await stored!,
  );
}

export async function steerTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    return localTaskAction(req, cwd, taskId, 'steer', ctx);
  }
  if (status.task.flow !== 'default')
    return json({ error: `${'steer'} is available only for default-flow tasks` }, 409);
  if (!['queued', 'running', 'waiting'].includes(status.status))
    return json({ error: `Task "${taskId}" is not active` }, 409);

  const body = await req.json().catch(() => undefined);
  const entry = await addInbox(
    ctx,
    taskId,
    'steer' as 'steer' | 'ask' | 'approve',
    body,
    status.generation ?? 0,
  );

  return entry ? json(entry) : json({ error: `Task "${taskId}" is no longer active` }, 409);
}

export async function askTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    return localTaskAction(req, cwd, taskId, 'ask', ctx);
  }
  if (status.task.flow !== 'default')
    return json({ error: `${'ask'} is available only for default-flow tasks` }, 409);
  if (!['queued', 'running', 'waiting'].includes(status.status))
    return json({ error: `Task "${taskId}" is not active` }, 409);

  const body = await req.json().catch(() => undefined);
  const entry = await addInbox(
    ctx,
    taskId,
    'ask' as 'steer' | 'ask' | 'approve',
    body,
    status.generation ?? 0,
  );

  return entry ? json(entry) : json({ error: `Task "${taskId}" is no longer active` }, 409);
}

export async function continueTaskRequest(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    return localTaskAction(req, cwd, taskId, 'continue', ctx);
  }
  if (status.task.flow !== 'default')
    return json({ error: 'continue is available only for default-flow tasks' }, 409);
  if (!DONE.has(status.status))
    return json({ error: `Task "${taskId}" is still active; steer or ask it instead` }, 409);

  const body = (await req.json().catch(() => ({}))) as {
    text?: unknown;
    outputSchema?: object;
  };

  try {
    return json(
      redactTask(await continueTask(ctx, status, String(body.text ?? ''), body.outputSchema)),
    );
  } catch (error) {
    return taskError(error);
  }
}

export async function approveTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    return localTaskAction(req, cwd, taskId, 'approve', ctx);
  }
  if (status.task.flow !== 'default')
    return json({ error: `${'approve'} is available only for default-flow tasks` }, 409);
  if (!['queued', 'running', 'waiting'].includes(status.status))
    return json({ error: `Task "${taskId}" is not active` }, 409);
  if (!status.approval) return json({ error: `Task "${taskId}" has no pending approval` }, 409);

  const body = await req.json().catch(() => undefined);
  const entry = await addInbox(
    ctx,
    taskId,
    'approve' as 'steer' | 'ask' | 'approve',
    body,
    status.generation ?? 0,
  );

  return entry ? json(entry) : json({ error: `Task "${taskId}" is no longer active` }, 409);
}

export async function cancelTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    return localTaskAction(req, cwd, taskId, 'cancel', ctx);
  }

  const cancelled = await ctx.queue.cancel(ctx.organizationId, taskId, (ctx.now ?? Date.now)(), {
    attempts: status.attempts,
    tokenHash: status.tokenHash ?? null,
    generation: status.generation ?? 0,
  });
  if (cancelled && status.status !== 'queued') await pushInbox(ctx, taskId);

  return cancelled
    ? json({ ok: true })
    : json({ error: `No running or queued task "${taskId}"` }, 404);
}

export async function archiveTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    return localTaskAction(req, cwd, taskId, 'archive', ctx);
  }

  const now = (ctx.now ?? Date.now)();
  await ctx.queue.patchTask(ctx.organizationId, taskId, { archivedAt: now }, now);

  return json({ ok: true });
}

export async function adminEvent(
  body: { agent?: string; event?: AgentEvent },
  ctx: ServerContext,
): Promise<Response> {
  if (!body.agent || !body.event?.integration)
    return json({ error: 'agent and event are required' }, 400);

  const integration = ctx.integrations[body.event.integration];
  if (!integration) return json({ error: `Unknown integration "${body.event.integration}"` }, 400);

  const actor = body.event.actor?.id;
  if (ctx.auth && actor) {
    const linked = await ctx.auth.linkedUser(integration.id, actor);
    if (linked && linked.id !== ctx.session?.user.id)
      return json({ error: "The event's actor is linked to another member" }, 403);
  }

  const apps = (await ctx.store.list('app')).map(entry => entry.value);
  const app = apps.find(
    entry => entry.agent === body.agent && entry.integration === integration.id,
  );
  if (!app)
    return json(
      {
        error: `No ${integration.id} app for agent "${body.agent}" on this server.`,
      },
      404,
    );

  const installations = (await ctx.store.list('installation'))
    .map(entry => entry.value)
    .filter(entry => entry.app === app.id && !entry.deletedAt);
  const installation =
    installations.find(entry => entry.id === `${app.id}:${body.event!.installationId}`) ??
    installations[0];
  if (!installation)
    return json(
      {
        error: `The ${integration.id} app for "${body.agent}" is not installed anywhere yet`,
      },
      404,
    );

  const now = ctx.now ?? Date.now;
  const event: AgentEvent = {
    ...body.event,
    appId: app.id,
    installationId: installation.id.slice(app.id.length + 1),
    deliveryId: `admin-${now()}-${randomUUID()}`,
  };
  const dispatched = await dispatchEvent(
    ctx,
    integration,
    app,
    decryptSecret(ctx.config, app.credentials),
    event,
    now,
    await eventReplies(ctx, app, event),
  );

  return start(
    ctx,
    dispatched.work ?? Promise.resolve(),
    dispatched.taskId ? [dispatched.taskId] : [],
  );
}

const TASK_STATES = new Set<TaskStatus['status']>([
  'queued',
  'running',
  'waiting',
  'completed',
  'failed',
  'cancelled',
]);

export async function adminCreate(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as
    | (NewTask & {
        source?: string;
        event?: AgentEvent;
      })
    | undefined;
  if (!body || typeof body !== 'object') return json({ error: 'A JSON body is required' }, 400);

  try {
    taskCwd(ctx, body);
    if (body.event) return adminEvent(body, ctx);

    const status =
      (body.source !== 'cli' ? await startLocalTask(ctx, body) : undefined) ??
      (await createTask(ctx, body.source === 'cli' ? 'cli' : 'dashboard', body));

    return json(redactTask(status), 201);
  } catch (error) {
    return taskError(error);
  }
}

export async function listTasks(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const status = url.searchParams.get('status');
  if (status && status !== 'active' && !TASK_STATES.has(status as TaskStatus['status']))
    return json({ error: `Unknown status "${status}"` }, 400);

  const source = url.searchParams.get('source');
  if (
    source &&
    !['dashboard', 'cli', 'schedule', ...Object.keys(ctx.integrations)].includes(source)
  )
    return json({ error: `Unknown source "${source}"` }, 400);

  const agent = url.searchParams.get('agent');
  const q = url.searchParams.get('q')?.trim();
  const filter: TaskFilter = {
    ...(agent ? { agent } : {}),
    ...(source ? { source: source as TaskSource } : {}),
    ...(q ? { q } : {}),
    archived: url.searchParams.get('archived') === '1',
  };
  const states =
    status === 'active'
      ? { statuses: ACTIVE_STATES }
      : status
        ? { status: status as TaskStatus['status'] }
        : {};
  const shape = (rows: TaskStatus[]) =>
    url.searchParams.get('summary') === '1' ? rows.map(summarizeTask) : rows.map(redactTask);
  if (ctx.local) {
    const local = new Map(
      localTasks(ctx.local.cwd, filter.archived!).map(row => [row.task.id, row]),
    );
    for (const row of await ctx.queue.list(ctx.organizationId))
      local.set(
        row.task.id,
        row.status === 'queued' || row.status === 'waiting' ? row : (local.get(row.task.id) ?? row),
      );

    const rows = [...local.values()]
      .filter(row => matchesTask(row, { ...filter, ...states }))
      .sort(listOrder);
    const limit = pageLimit(url, paged(url) ? undefined : 20);
    if (!paged(url)) return json(shape(rows.slice(0, limit)));

    const before = decodeCursor<ListCursor>(url);
    const items = rows.filter(row => afterCursor(row, before));
    const result = page(items.slice(0, limit + 1), limit, listCursor);

    return json({
      ...result,
      items: shape(result.items),
      ...(url.searchParams.get('counts') === '1'
        ? {
            counts: {
              all: rows.length,
              active: rows.filter(row => ACTIVE_STATES.includes(row.status)).length,
              waiting: rows.filter(row => row.status === 'waiting').length,
            },
          }
        : {}),
    });
  }
  if (!paged(url)) {
    const limit = pageLimit(url, 20);
    const rows = await ctx.queue.list(ctx.organizationId, {
      ...filter,
      ...states,
      limit,
      summary: url.searchParams.get('summary') === '1',
    });

    return json(shape(rows));
  }

  const limit = pageLimit(url);
  const before = decodeCursor<ListCursor>(url);
  const together =
    url.searchParams.get('counts') === '1' && !status && !before && ctx.queue.listWithCounts
      ? await ctx.queue.listWithCounts(ctx.organizationId, {
          ...filter,
          limit: limit + 1,
          summary: url.searchParams.get('summary') === '1',
        })
      : undefined;
  const [rows, counts] = await Promise.all([
    together
      ? together.items
      : ctx.queue.list(ctx.organizationId, {
          ...filter,
          ...states,
          summary: url.searchParams.get('summary') === '1',
          ...(before ? { before } : {}),
          limit: limit + 1,
        }),
    together
      ? together.counts
      : url.searchParams.get('counts') === '1'
        ? ctx.queue.counts(ctx.organizationId, { ...filter, ...states })
        : undefined,
  ]);
  const result = page(rows, limit, listCursor);

  return json({ ...result, items: shape(result.items), ...(counts ? { counts } : {}) });
}
