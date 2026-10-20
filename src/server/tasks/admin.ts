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
import { removeTaskWork, taskRunner } from '../runners';
import {
  answerLocalApproval,
  inspectLocalTask,
  localLog,
  localTask,
  localTaskAction,
  localTasks,
  startLocalTask,
} from './local';
import { scheduleKick } from './kick';
import { readLog } from './logs';
import { inspectTask, scheduleCancel } from './kick';
import {
  ACTIVE_STATES,
  addInbox,
  deleteTask,
  StoreQueue,
  matchesTask,
  listOrder,
  afterCursor,
  listCursor,
  type ListCursor,
  deltaCursor,
  deltaOrder,
  pushInbox,
  taskTimes,
  type TaskFilter,
  withApprovals,
} from './queue';
import { randomUUID } from 'node:crypto';
import { queueRowWins } from '../../core/state';
import { decryptSecret } from '../store/secrets';
import { type AgentEvent, type TaskSource } from '../../agent/types';
import { eventReplies } from '../chat';
import { dispatchEvent } from './events';
import { start } from './flows';
import { ConfigError } from '../settings/config';
import {
  ApprovalRefusedError,
  approvalMessage,
  withDecisions,
  listApprovals,
  closedResponse,
  pendingApprovals,
  stoppedMessage,
} from '../../core/approvals';
import { resolveTaskDir } from '../../core/state';
import { syncApprovals } from './approvals';
import { type Approval } from '../../core/types';
import { awaitsApproval } from '../../core/defaults';

export const DONE = new Set<TaskStatus['status']>(['completed', 'failed', 'cancelled']);

export function taskError(error: unknown): Response {
  if (error instanceof ConfigError) return json({ error: error.message }, 400);
  if (error instanceof TaskInputError)
    return json({ error: error.message, ...(error.fix ? { fix: error.fix } : {}) }, error.status);
  throw error;
}

export function summarizeTask(status: TaskStatus) {
  const { id, name, source, agent, flow, event, cwd } = status.task;
  const { engine, model, effort } = { ...status.task.definition, ...status.task.usage };
  // The first turn's prompt titles the task; a follow-up or a decision is a later turn.
  const prompt = status.task.context?.turns?.[0]?.prompt ?? status.task.prompt;
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
      ...(engine
        ? { usage: { engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}) } }
        : {}),
    },
    status: status.status,
    ...(status.status === 'queued' ? { statusReason: 'Waiting for a task slot' } : {}),
    attempts: status.attempts,
    ...(status.approval !== undefined ? { approval: status.approval } : {}),
    ...((status.approvals ?? status.task.context?.approvals)
      ? { approvals: status.approvals ?? status.task.context?.approvals }
      : {}),
    ...(status.archivedAt !== undefined ? { archivedAt: status.archivedAt } : {}),
    createdAt: status.createdAt,
    startedAt: status.startedAt,
    finishedAt: status.finishedAt,
    updatedAt: status.updatedAt,
    ...taskTimes(status),
  };
}

export function redactTask(
  status: TaskStatus,
): Omit<TaskStatus, 'tokenHash' | 'handle'> & { handle?: never } {
  const { tokenHash: _tokenHash, handle: _handle, ...safe } = status;
  return {
    ...safe,
    ...taskTimes(status),
    ...(status.status === 'queued' ? { statusReason: 'Waiting for a task slot' } : {}),
    ...(status.task.context?.approvals ? { approvals: status.task.context.approvals } : {}),
    turns: withDecisions(taskTurns(status), status.approvals ?? status.task.context?.approvals),
    ...(status.task.credential
      ? { credential: parseCredentialId(status.task.credential).name }
      : {}),
  };
}

async function target(
  ctx: ServerContext,
  id: string,
): Promise<
  | { status: TaskStatus; cwd?: never; answer?: never }
  | { status?: never; cwd: string; answer?: TaskStatus['answer'] }
  | Response
> {
  const status = await ctx.store.get('task', id);
  if (status && !(ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default'))
    return { status };
  const cwd = status?.task.cwd ?? ctx.local?.cwd;

  return cwd ? { cwd, answer: status?.answer } : json({ error: `No task "${id}"` }, 404);
}

export async function readTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const taskId = params.id!;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  const stored = readLog(ctx.store, taskId, cursor, lines ?? 500);
  stored?.catch(() => {});

  const found = await target(ctx, taskId);
  if (found instanceof Response) return found;
  const { status, cwd } = found;
  if (!status) {
    const local = localTask(cwd, taskId, true);
    if (!local) return json({ error: `No task "${taskId}"` }, 404);

    return json({
      ...local,
      ...(found.answer ? { answer: found.answer } : {}),
      logs: localLog(cwd, taskId, -1, lines ?? 500),
    });
  }

  return json({ ...redactTask(await inspectTask(ctx, status)), logs: await stored! });
}

export async function removeTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const taskId = params.id!;
  const found = await target(ctx, taskId);
  if (found instanceof Response) return found;
  const { status, cwd } = found;
  if (!status) {
    const response = await localTaskAction(req, cwd, taskId, undefined, ctx);
    // A CLI task's delete reaches events streams, even once it was archived out of their scans.
    if (response.ok && ctx.queue instanceof StoreQueue) ctx.queue.tombstone(taskId);

    return response;
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
  if (!status.handle?.startsWith('cli:'))
    await removeTaskWork(ctx, status.task, status.handle).catch(error =>
      console.error(`coder server: work folder of ${taskId} not removed`, error),
    );
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
  const taskId = params.id!;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  const stored = readLog(ctx.store, taskId, cursor, lines ?? undefined);
  stored?.catch(() => {});

  const found = await target(ctx, taskId);
  if (found instanceof Response) return found;
  const { status, cwd } = found;
  if (!status) {
    const local = localTask(cwd, taskId, false);
    if (!local) return json({ error: `No task "${taskId}"` }, 404);

    return json(localLog(cwd, taskId, cursor, lines));
  }

  await inspectTask(ctx, status);

  return json(await stored!);
}

export async function steerTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const taskId = params.id!;
  const found = await target(ctx, taskId);
  if (found instanceof Response) return found;
  const { status, cwd } = found;
  if (!status) {
    return localTaskAction(req, cwd, taskId, 'steer', ctx);
  }
  if (status.task.flow !== 'default')
    return json({ error: 'steer is available only for default-flow tasks' }, 409);

  const body = await req.json().catch(() => undefined);
  // A finished task resumes on the same id; a live one takes the follow-up in its inbox.
  if (DONE.has(status.status)) {
    const { text, outputSchema, model, effort, permissions } = (body ?? {}) as Record<string, any>;
    try {
      const next = await continueTask(ctx, status, String(text ?? ''), outputSchema, {
        model,
        effort,
        permissions,
      });
      scheduleKick(ctx, true);
      return json(redactTask(next));
    } catch (error) {
      return taskError(error);
    }
  }
  const entry = await addInbox(ctx, status, 'steer', body);

  return entry ? json(entry) : json({ error: `Task "${taskId}" is no longer active` }, 409);
}

function inboxAction(kind: 'ask' | 'approve') {
  return async (req: Request, ctx: ServerContext, params: Params): Promise<Response> => {
    const id = params.id!;
    const found = await target(ctx, id);
    if (found instanceof Response) return found;
    const { status, cwd } = found;
    if (kind === 'approve') {
      const value = (await req.json().catch(() => undefined)) as
        Record<string, unknown> | undefined;
      return decideApproval(ctx, id, value ?? {}, ctx.session?.user.name);
    }
    if (!status) return localTaskAction(req, cwd, id, kind, ctx);
    if (status.task.flow !== 'default')
      return json({ error: `${kind} is available only for default-flow tasks` }, 409);
    if (!ACTIVE_STATES.includes(status.status))
      return json({ error: `Task "${id}" is not active` }, 409);
    const value = (await req.json().catch(() => undefined)) as Record<string, unknown> | undefined;
    const entry = await addInbox(ctx, status, kind, value);

    return entry ? json(entry) : json({ error: `Task "${id}" is no longer active` }, 409);
  };
}

/** Answers an approval from any surface, then brings the task's conversation in step with it; `by` names who answered. */
export async function decideApproval(
  ctx: ServerContext,
  id: string,
  value: Record<string, unknown>,
  by?: string,
): Promise<Response> {
  const found = await target(ctx, id);
  if (found instanceof Response) return found;
  const { status, cwd } = found;
  if (status && status.task.flow !== 'default')
    return json({ error: 'approve is available only for default-flow tasks' }, 409);
  const approvalId = String(
    value.approvalId ??
      value.id ??
      (status
        ? (status.approval as Approval | undefined)?.id
        : pendingApprovals(resolveTaskDir(cwd, id))[0]?.id) ??
      '',
  );
  const decision = value.decision === 'deny' || value.decision === 'decline' ? 'decline' : 'accept';
  const answer = { ...value, approvalId, decision, ...(by ? { by } : {}) };
  const response = status
    ? await answerApproval(ctx, status, answer)
    : await answerLocalApproval(cwd, id, answer, ctx);
  if (!response.ok) return response;

  const current = await ctx.store.get('task', id);
  const approvals = status
    ? (current?.task.context?.approvals ?? [])
    : listApprovals(resolveTaskDir(cwd, id));
  if (current)
    (ctx.waitUntil ?? (() => {}))(
      syncApprovals(ctx, current.task, approvals).catch(error =>
        console.error(`coder server: could not show the decision on approval ${approvalId}`, error),
      ),
    );

  return response;
}

/** Answer an approval, pending or denied, any time: a live task hears it in its inbox, a finished one resumes with it as a new turn. */
async function answerApproval(
  ctx: ServerContext,
  status: TaskStatus,
  value: Record<string, unknown>,
): Promise<Response> {
  const id = status.task.id;
  const known = status.task.context?.approvals ?? [];
  const pending = status.approval as Approval | undefined;
  const approvalId = String(value.approvalId);
  const approval =
    known.find(entry => entry.id === approvalId) ??
    (pending?.id === approvalId ? pending : undefined);
  if (!approval) return json({ error: `Task "${id}" has no approval "${approvalId}"` }, 409);
  if (approval.response?.decision === 'accept')
    return json({ error: `Approval "${approvalId}" is already approved` }, 409);
  if (approval.response?.decision === 'closed')
    return json({ error: stoppedMessage(approvalId) }, 409);
  const decision = value.decision as 'accept' | 'decline';
  const answered: Approval = {
    ...approval,
    response: {
      decision,
      ...(typeof value.reason === 'string' && value.reason ? { reason: value.reason } : {}),
      answeredAt: new Date((ctx.now ?? Date.now)()).toISOString(),
      ...(typeof value.by === 'string' && value.by ? { by: value.by } : {}),
    },
  };
  if (DONE.has(status.status)) {
    try {
      const next = await continueTask(
        ctx,
        { ...status, task: withApprovals(status.task, [answered]) },
        approvalMessage(answered),
      );
      scheduleKick(ctx, true);
      return json(redactTask(next));
    } catch (error) {
      return taskError(error);
    }
  }
  if (!ACTIVE_STATES.includes(status.status))
    return json({ error: `Task "${id}" is not active` }, 409);
  // The answer and its inbox entry land in one write, checked against the record under the queue's lock.
  let entry;
  try {
    entry = await addInbox(ctx, status, 'approve', value, undefined, [answered]);
  } catch (error) {
    if (error instanceof ApprovalRefusedError) return json({ error: error.message }, 409);
    throw error;
  }
  if (!entry) return json({ error: `Task "${id}" is no longer active` }, 409);

  return json(entry);
}

export const askTask = inboxAction('ask');
export const approveTask = inboxAction('approve');

export async function cancelTask(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const taskId = params.id!;
  const found = await target(ctx, taskId);
  if (found instanceof Response) return found;
  const { status, cwd } = found;
  if (!status) {
    return localTaskAction(req, cwd, taskId, 'cancel', ctx);
  }

  const now = (ctx.now ?? Date.now)();
  const cancelled = await ctx.queue.cancel(ctx.organizationId, taskId, now, {
    attempts: status.attempts,
    tokenHash: status.tokenHash ?? null,
    generation: status.generation ?? 0,
  });
  // Its open approvals close now, even where no runner reports the stop.
  const open = (status.task.context?.approvals ?? []).filter(approval => !approval.response);
  if (cancelled && open.length) {
    const response = closedResponse(new Date(now).toISOString());
    await ctx.queue.patchTask(
      ctx.organizationId,
      taskId,
      { approvals: open.map(approval => ({ ...approval, response })) },
      now,
    );
    const current = await ctx.store.get('task', taskId);
    if (current)
      (ctx.waitUntil ?? (() => {}))(
        syncApprovals(ctx, current.task, current.task.context?.approvals ?? []).catch(error =>
          console.error(`coder server: could not show the stop on ${taskId}`, error),
        ),
      );
  }
  if (cancelled && status.status !== 'queued') {
    await pushInbox(ctx, taskId);
    const current = await ctx.store.get('task', taskId);
    if (current && !DONE.has(current.status)) scheduleCancel(ctx, status);
  }

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
  const taskId = params.id!;
  const found = await target(ctx, taskId);
  if (found instanceof Response) return found;
  const { status, cwd } = found;
  if (!status) {
    return localTaskAction(req, cwd, taskId, 'archive', ctx);
  }

  const now = (ctx.now ?? Date.now)();
  await ctx.queue.patchTask(
    ctx.organizationId,
    taskId,
    { archivedAt: now, autoArchived: undefined },
    now,
  );

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

/** A local server's tasks: the CLI's, with each queue row that is a newer execution (`queueRowWins`) in its job's place. */
export function localRows(cwd: string, cli: TaskStatus[], queued: TaskStatus[]): TaskStatus[] {
  const local = new Map(cli.map(row => [row.task.id, row]));
  for (const row of queued)
    if (queueRowWins(cwd, row, local.has(row.task.id))) local.set(row.task.id, row);

  return [...local.values()];
}

export async function listTasks(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const status = url.searchParams.get('status');
  if (status && status !== 'active' && !TASK_STATES.has(status as TaskStatus['status']))
    return json({ error: `Unknown status "${status}"` }, 400);

  const source = url.searchParams.get('source');
  if (
    source &&
    !['dashboard', 'cli', 'schedule', ...Object.keys(ctx.integrations)].includes(source)
  )
    return json({ error: `Unknown source "${source}"` }, 400);

  const since = url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined;
  if (since !== undefined && (!Number.isFinite(since) || since < 0))
    return json({ error: 'Invalid since' }, 400);
  const agent = url.searchParams.get('agent');
  const q = url.searchParams.get('q')?.trim();
  const filter: TaskFilter = {
    ...(agent ? { agent } : {}),
    ...(source ? { source: source as TaskSource } : {}),
    ...(q ? { q } : {}),
    archived: since === undefined ? url.searchParams.get('archived') === '1' : undefined,
    ...(since !== undefined
      ? {
          since,
          ...(url.searchParams.get('sinceId') ? { sinceId: url.searchParams.get('sinceId')! } : {}),
        }
      : {}),
  };
  const states =
    status === 'active'
      ? { statuses: ACTIVE_STATES }
      : status
        ? { status: status as TaskStatus['status'] }
        : {};
  const summary =
    url.searchParams.get('summary') === '1' ||
    (since !== undefined && !url.searchParams.has('summary'));
  const shape = (rows: TaskStatus[]) => (summary ? rows.map(summarizeTask) : rows.map(redactTask));
  if (ctx.local) {
    const cli =
      since === undefined
        ? localTasks(ctx.local.cwd, filter.archived!)
        : [
            // An auto-archive keeps a CLI job's updatedAt, so a delta dates it by its archive.
            ...localTasks(ctx.local.cwd, true).map(row => ({
              ...row,
              updatedAt: Math.max(row.updatedAt, row.archivedAt!),
            })),
            ...localTasks(ctx.local.cwd, false),
          ];
    const rows = localRows(ctx.local.cwd, cli, await ctx.queue.list(ctx.organizationId))
      .filter(row => matchesTask(row, { ...filter, ...states }))
      .sort(since === undefined ? listOrder : deltaOrder);
    const limit = pageLimit(url, paged(url) ? undefined : 20);
    if (!paged(url)) return json(shape(rows.slice(0, limit)));

    const before = decodeCursor<ListCursor>(url);
    const items = rows.filter(row => afterCursor(row, before));
    const result = page(
      items.slice(0, limit + 1),
      limit,
      since === undefined ? listCursor : deltaCursor,
    );

    return json({
      ...result,
      items: shape(result.items),
      ...(url.searchParams.get('counts') === '1'
        ? {
            counts: {
              all: rows.length,
              active: rows.filter(row => ACTIVE_STATES.includes(row.status)).length,
              waiting: rows.filter(row =>
                awaitsApproval(row.status, row.approvals ?? row.task.context?.approvals),
              ).length,
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
      summary,
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
          summary,
        })
      : undefined;
  const [rows, counts] = await Promise.all([
    together
      ? together.items
      : ctx.queue.list(ctx.organizationId, {
          ...filter,
          ...states,
          summary,
          ...(before ? { before } : {}),
          limit: limit + 1,
        }),
    together
      ? together.counts
      : url.searchParams.get('counts') === '1'
        ? ctx.queue.counts(ctx.organizationId, { ...filter, ...states })
        : undefined,
  ]);
  const result = page(rows, limit, since === undefined ? listCursor : deltaCursor);

  return json({ ...result, items: shape(result.items), ...(counts ? { counts } : {}) });
}
