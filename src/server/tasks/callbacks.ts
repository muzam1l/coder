import { type Params } from '../routes/match';
import { type AgentTask } from '../../agent/types';
import { type TaskStatus, type UsageRecord } from '../store/types';
import { type ServerContext } from '../context';
import { taskContext } from './context';
import { writeBackCodexAuth } from '../settings/credentials';
import { copyRunnerLogs } from './logs';
import { type InboxAck } from './queue';
import { noteKey, NOTE_TTL_MS } from './thread';
import { taskClaims, taskTokenHash } from './token';
import { bearerToken } from '../routes/guards';
import { json } from '../routes/http';
import { type EngineLogin } from '../settings/logins';

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
  note?: string;
  diff?: string;
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

  return accepted ? json({ ok: true }) : new Response('Unauthorized', { status: 401 });
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
  if (['completed', 'failed', 'cancelled'].includes(authorized.status)) return json({ ok: true });

  const body = (await req.json().catch(() => undefined)) as TaskCallback | undefined;
  if (
    !body?.status ||
    !['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(body.status)
  )
    return json({ error: 'Invalid task result' }, 400);

  let now = (ctx.now ?? Date.now)();
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
  await copyRunnerLogs(ctx, authorized).catch(() => {});
  // Stamped after the log copy, so a reader looking back a fixed time still sees the finish.
  now = (ctx.now ?? Date.now)();

  const output = typeof body.result === 'string' ? body.result : JSON.stringify(body.result ?? '');
  const result = {
    ok: body.status === 'completed',
    exitCode: body.status === 'completed' ? 0 : 1,
    output,
    ...(typeof body.diff === 'string' ? { diff: body.diff } : {}),
  };
  await ctx.queue.completeTask(
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
      ...(typeof body.note === 'string'
        ? { note: { key: noteKey(authorized.task), value: body.note, ttlMs: NOTE_TTL_MS } }
        : {}),
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
    return json({
      ...(await taskContext(ctx, authorized)),
      generation: authorized.generation ?? 0,
    });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }
}
