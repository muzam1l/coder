import { type Params } from '../routes/match';
import { type AgentTask } from '../../agent/types';
import { type TaskStatus, type TaskLogLine, type UsageRecord } from '../store/types';
import { type ServerContext } from '../context';
import { taskContext, taskLogSecrets } from './context';
import { writeBackCodexAuth } from '../settings/credentials';
import { storeLogs } from './logs';
import { stopTaskMachine } from './kick';
import { taskRunner } from '../runners';
import { type InboxAck } from './queue';
import { taskClaims, taskTokenHash } from './token';
import { bearerToken } from '../routes/guards';
import { json } from '../routes/http';
import { type EngineLogin } from '../settings/logins';
import { decryptSecret } from '../store/secrets';
import { rememberPost } from './conversation';

export async function authorizeTask(
  req: Request,
  ctx: ServerContext,
  id: string,
  allowCompleted = false,
): Promise<TaskStatus | Response> {
  const token = bearerToken(req);
  if (!token) return new Response('Unauthorized', { status: 401 });
  const bound = taskClaims(token);
  if (
    bound.task !== id ||
    bound.organization !== ctx.organizationId ||
    !Number.isInteger(bound.attempt)
  )
    return new Response('Unauthorized', { status: 401 });
  return (
    (await ctx.queue.touch(
      ctx.organizationId,
      id,
      taskTokenHash(token),
      bound.attempt!,
      (ctx.now ?? Date.now)(),
      allowCompleted,
    )) ?? new Response('Unauthorized', { status: 401 })
  );
}

export function target(task: AgentTask): string {
  const event = task.event;
  if (!event) return task.source;
  if (event.repo) return `${event.repo.owner}/${event.repo.name}`;
  return event.chat?.thread.channelId ?? event.integration;
}

type TaskCallback = {
  status?: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
  tokens?: unknown;
  approval?: unknown;
  answer?: unknown;
  diff?: string;
  postedMessages?: string[];
};

export type CallbackContext = ServerContext & {
  callbackTask?: TaskStatus;
  callbackLogin?: EngineLogin;
};

export async function readMessages(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const token = bearerToken(req);
  const claims = taskClaims(token!);
  const hash = taskTokenHash(token!);
  const after = Number(url.searchParams.get('after') ?? -1);
  if (!Number.isInteger(after) || after < -1) return json({ error: 'Invalid cursor' }, 400);

  const entries = await ctx.queue.fetchInbox(ctx.organizationId, id, hash, claims.attempt!, after);

  return entries ? json(entries) : new Response('Unauthorized', { status: 401 });
}

export async function ackMessages(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const token = bearerToken(req);
  const claims = taskClaims(token!);
  const hash = taskTokenHash(token!);
  const ack = (await req.json().catch(() => undefined)) as InboxAck | undefined;
  if (
    !ack ||
    !Number.isInteger(ack.seq) ||
    ack.seq < -1 ||
    !Number.isInteger(ack.generation) ||
    ack.generation < 0 ||
    (ack.answers !== undefined &&
      (!Array.isArray(ack.answers) ||
        ack.answers.some(
          answer =>
            !answer || !Number.isInteger(answer.seq) || answer.seq < 0 || answer.seq > ack.seq,
        )))
  )
    return json({ error: 'Invalid acknowledgement' }, 400);

  const fence = { tokenHash: hash, attempts: claims.attempt!, generation: ack.generation };
  const accepted = await ctx.queue.ackInbox(ctx.organizationId, id, ack, fence);
  if (accepted) {
    const current = await ctx.store.get('task', id);
    if (current?.status === 'cancelled') await stopTaskMachine(ctx, current);
  }

  return accepted ? json({ ok: true }) : new Response('Unauthorized', { status: 401 });
}

export async function reportLogs(
  req: Request,
  ctx: CallbackContext,
  params: Params,
): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as { entries?: TaskLogLine[] } | undefined;
  const entries = body?.entries;
  if (
    !Array.isArray(entries) ||
    entries.length > 100 ||
    entries.some(
      (entry, index) =>
        !entry ||
        !Number.isSafeInteger(entry.seq) ||
        entry.seq < 0 ||
        !Number.isSafeInteger(entry.at) ||
        entry.at < 0 ||
        !['out', 'err'].includes(entry.level) ||
        typeof entry.line !== 'string' ||
        Buffer.byteLength(entry.line) > 64 * 1024 ||
        (index > 0 && entry.seq !== entries[index - 1]!.seq + 1),
    )
  )
    return json({ error: 'Invalid task logs' }, 400);
  const saved = await storeLogs(ctx, ctx.callbackTask!, entries);

  return saved === 'ok'
    ? json({ ok: true })
    : saved === 'gap'
      ? json({ error: 'Task log sequence has a gap' }, 409)
      : new Response('Unauthorized', { status: 401 });
}

export async function heartbeat(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const token = bearerToken(req);
  const claims = taskClaims(token!);
  const hash = taskTokenHash(token!);
  const status = await ctx.queue.touch(
    ctx.organizationId,
    id,
    hash,
    claims.attempt!,
    (ctx.now ?? Date.now)(),
  );

  return status ? json({ ok: true }) : new Response('Unauthorized', { status: 401 });
}

export async function reportResult(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const token = bearerToken(req);
  const authorized = ctx.callbackTask!;
  if (['completed', 'failed', 'cancelled'].includes(authorized.status)) {
    await stopTaskMachine(ctx, authorized);
    return json({ ok: true });
  }

  const runner = authorized.handle ? await taskRunner(ctx, authorized.task) : undefined;
  const body = (await req.json().catch(() => undefined)) as TaskCallback | undefined;
  if (
    !body?.status ||
    !['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(body.status) ||
    (body.postedMessages !== undefined &&
      (!Array.isArray(body.postedMessages) ||
        body.postedMessages.some(id => typeof id !== 'string')))
  )
    return json({ error: 'Invalid task result' }, 400);

  const secrets = (await taskLogSecrets(ctx, authorized)).sort(
    (left, right) => right.length - left.length,
  );
  Object.assign(
    body,
    JSON.parse(
      JSON.stringify(body, (_key, value) =>
        typeof value === 'string'
          ? secrets.reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), value)
          : value,
      ),
    ) as TaskCallback,
  );

  let now = (ctx.now ?? Date.now)();
  if (authorized.task.event)
    await rememberPost(ctx, authorized.task.event, body.postedMessages ?? [], now);

  if (body.status === 'running' || body.status === 'waiting') {
    await ctx.queue.patchTask(
      ctx.organizationId,
      id,
      {
        status: body.status,
        lastSeenAt: now,
        ...(body.approval !== undefined
          ? { approval: body.approval }
          : body.status === 'running'
            ? { approval: undefined }
            : {}),
        ...(body.answer !== undefined ? { answer: body.answer } : {}),
      },
      now,
      {
        attempts: authorized.attempts,
        tokenHash: authorized.tokenHash,
        statuses: ['running', 'waiting'],
      },
    );

    return json({ ok: true });
  }

  const output = typeof body.result === 'string' ? body.result : JSON.stringify(body.result ?? '');
  const result = {
    ok: body.status === 'completed',
    exitCode: body.status === 'completed' ? 0 : 1,
    output,
    ...(typeof body.diff === 'string' ? { diff: body.diff } : {}),
  };
  const completed = await ctx.queue.completeTask(
    ctx.organizationId,
    id,
    {
      attempts: authorized.attempts,
      tokenHash: authorized.tokenHash!,
      outcome: {
        status: body.status,
        result,
        ...(body.error ? { error: body.error } : {}),
        ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
      },
      usage: {
        ...(authorized.task.event
          ? {
              installationId: `${authorized.task.event.appId}:${authorized.task.event.installationId}`,
            }
          : {}),
        taskId: id,
        agent: authorized.task.agent,
        target: target(authorized.task),
        ...((authorized.task.usage?.engine ?? authorized.task.definition.engine)
          ? {
              engine: authorized.task.usage?.engine ?? authorized.task.definition.engine,
            }
          : {}),
        ...((authorized.task.usage?.model ?? authorized.task.definition.model)
          ? {
              model: authorized.task.usage?.model ?? authorized.task.definition.model,
            }
          : {}),
        credential: authorized.task.credential ?? 'unknown',
        runnerElapsedMs: Math.max(0, now - (authorized.startedAt ?? now)),
        ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
        at: now,
      } satisfies UsageRecord,
    },
    now,
  );

  if (completed) await stopTaskMachine(ctx, authorized, false, runner);

  return json({ ok: true });
}

export async function refreshCredential(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const token = bearerToken(req);
  const authorized = ctx.callbackTask!;
  const body = (await req.json().catch(() => ({}))) as {
    authJson?: unknown;
  };
  if (typeof body.authJson !== 'string' || !authorized.task.credential)
    return json({ error: 'Invalid credential update' }, 400);

  return json({
    kept: await writeBackCodexAuth(
      ctx.store,
      ctx.config,
      authorized.task.credential,
      body.authJson,
    ),
  });
}

export async function readContext(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const token = bearerToken(req);
  const authorized = ctx.callbackTask!;

  try {
    const { connectionSecrets: _secrets, ...context } = await taskContext(ctx, authorized);
    return json({
      ...context,
      generation: authorized.generation ?? 0,
      logCursor: authorized.logCursor ?? -1,
      timeoutMs: Math.max(
        1,
        ctx.config.taskTimeoutMs -
          ((ctx.now ?? Date.now)() - (authorized.startedAt ?? (ctx.now ?? Date.now)())),
      ),
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
}
