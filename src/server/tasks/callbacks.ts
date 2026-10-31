import { type Params } from '../routes/match';
import { usageRecordOf } from './usage';
import { type Approval } from '../../core/types';
import { effectiveSettings } from '../../agent/definition';
import { type TaskStatus, type TaskLogLine } from '../store/types';
import { type ServerContext } from '../context';
import { installationToken, taskContext, taskEngineCredentials, uninstall } from './context';
import { decryptSecret } from '../store/secrets';
import { checkCodexAuth, parseCredentialId } from '../settings/credentials';
import { taskGrants } from './grants';
import { turnStarter } from './access';
import { effectiveConfig, taskConfig } from '../settings/config';
import { splitEngineSpec } from '../../core/config';
import { writeBackCodexAuth } from '../settings/credentials';
import { storeLogs, taskRedactor, taskWarnings } from './logs';
import { stopTaskMachine } from './kick';
import { taskRunner } from '../runners/select';
import { type CallbackState, type InboxAck } from './queue';
import { taskClaims, taskTokenHash } from './access';
import { bearerToken } from '../routes/guards';
import { json } from '../routes/http';
import { type EngineLogin } from '../settings/logins';
import {
  CONVERSATION_TTL_MS,
  deliverWaiting,
  knownPosts,
  rememberPost,
  returnNotice,
  takeNotice,
} from './conversation';
import { syncApprovals } from './approvals';

/** How long a reply or react call id is remembered, so a late retry still posts once. */
const CALL_TTL_MS = 24 * 60 * 60 * 1000;

export async function authorizeTask(
  req: Request,
  ctx: ServerContext,
  id: string,
  allowCompleted = false,
  include?: 'secrets' | 'context',
): Promise<CallbackState | Response> {
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
    (await ctx.queue.authorize(
      id,
      taskTokenHash(token),
      bound.attempt!,
      ctx.organizationId,
      (ctx.now ?? Date.now)(),
      { allowCompleted, include },
    )) ?? new Response('Unauthorized', { status: 401 })
  );
}

type TaskCallback = {
  status?: 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
  result?: unknown;
  error?: string;
  tokens?: unknown;
  approval?: Approval;
  /** The task's escalations so far, answers included. */
  approvals?: Approval[];
  answer?: unknown;
  diff?: string;
  postedMessages?: string[];
  installationRevoked?: true;
  /** Sent by the machine when the task never reported its own outcome. */
  machine?: true;
  /** The model and credential that run the turn now, and each model that failed before them. */
  model?: string;
  credential?: string;
  fallbacks?: TaskStatus['fallbacks'];
};

/** What a runner's report may carry: the task's own row only. A claim about shared state (`installationRevoked`) is checked with the platform here before it lands; nothing else is accepted. */
const TASK_OWNED_FIELDS = new Set<keyof TaskCallback>([
  'status',
  'result',
  'error',
  'tokens',
  'approval',
  'approvals',
  'answer',
  'diff',
  'postedMessages',
  'installationRevoked',
  'machine',
  'model',
  'credential',
  'fallbacks',
]);

export type CallbackContext = ServerContext & {
  callbackTask?: TaskStatus;
  callbackLogin?: EngineLogin;
  /** The workspace's slug and name, read with the task. */
  callbackWorkspace?: { slug?: string; name?: string };
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
  if (accepted === 'cancelled') {
    const current = await ctx.store.get('task', id);
    if (current) await stopTaskMachine(ctx, current);
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
  const authorized = ctx.callbackTask!;
  const runner = authorized.handle ? await taskRunner(ctx, authorized.task) : undefined;
  if (['completed', 'failed', 'cancelled'].includes(authorized.status)) {
    await stopTaskMachine(ctx, authorized, false, runner);
    return json({ ok: true });
  }

  const body = (await req.json().catch(() => undefined)) as TaskCallback | undefined;
  if (
    !body?.status ||
    !['running', 'waiting', 'completed', 'failed', 'cancelled'].includes(body.status) ||
    Object.keys(body).some(key => !TASK_OWNED_FIELDS.has(key as keyof TaskCallback)) ||
    (body.installationRevoked !== undefined && body.installationRevoked !== true) ||
    (body.machine !== undefined && body.machine !== true) ||
    (body.approvals !== undefined &&
      (!Array.isArray(body.approvals) ||
        body.approvals.some(entry => typeof entry?.id !== 'string'))) ||
    (body.postedMessages !== undefined &&
      (!Array.isArray(body.postedMessages) ||
        body.postedMessages.some(id => typeof id !== 'string')))
  )
    return json({ error: 'Invalid task result' }, 400);

  // Only the server records a change request; a runner's report never carries one.
  body.approvals = body.approvals?.map(({ change: _, ...entry }) => entry as Approval);
  const redact = await taskRedactor(ctx, authorized, true);
  Object.assign(
    body,
    JSON.parse(
      JSON.stringify(body, (_key, value) => (typeof value === 'string' ? redact(value) : value)),
    ) as TaskCallback,
  );

  let now = (ctx.now ?? Date.now)();
  const posted = authorized.task.event
    ? knownPosts(authorized.task.event, body.postedMessages ?? [])
    : [];
  if (body.status === 'running' || body.status === 'waiting') {
    if (posted.length) {
      await rememberPost(ctx, authorized.task.event!, body.postedMessages!, now);
      endTyping(ctx, authorized);
    }
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
        ...(body.approvals ? { approvals: body.approvals } : {}),
        ...(body.fallbacks ? { fallbacks: body.fallbacks } : {}),
        ...(body.model ? { resolvedModel: splitEngineSpec(body.model).model ?? body.model } : {}),
      },
      now,
      {
        attempts: authorized.attempts,
        tokenHash: authorized.tokenHash,
        statuses: ['running', 'waiting'],
      },
    );
    if (body.approvals) await announceApprovals(ctx, id);

    return json({ ok: true });
  }
  // The final list lands before the outcome, so a late answer finds every escalation.
  if (body.approvals)
    await ctx.queue.patchTask(ctx.organizationId, id, { approvals: body.approvals }, now, {
      attempts: authorized.attempts,
      tokenHash: authorized.tokenHash,
    });
  if (body.approvals) await announceApprovals(ctx, id);

  const output = typeof body.result === 'string' ? body.result : JSON.stringify(body.result ?? '');
  const result = {
    ok: body.status === 'completed',
    exitCode: body.status === 'completed' ? 0 : 1,
    output,
    ...(typeof body.diff === 'string' ? { diff: body.diff } : {}),
  };
  // Posts, usage and the log marker land with the outcome; a machine that must stop first marks its logs after.
  const stops = !runner || runner.kind === 'vercel-sandbox' || runner.kind === 'local-docker';
  const ran = body.model ? splitEngineSpec(body.model) : undefined;
  const { engine, model } = ran ?? effectiveSettings(authorized.task);
  const completed = await ctx.queue.completeTask(
    ctx.organizationId,
    id,
    {
      attempts: authorized.attempts,
      tokenHash: authorized.tokenHash!,
      known: posted.map(id => ({ id, ttlMs: CONVERSATION_TTL_MS })),
      logsComplete: Boolean(authorized.handle) && !stops,
      outcome: {
        status: body.status,
        result,
        ...(body.error ? { error: body.error } : {}),
        ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
      },
      usage: {
        ...usageRecordOf(authorized, now),
        ...(engine ? { engine } : {}),
        ...(model ? { model } : {}),
        ...(body.credential ? { credential: body.credential } : {}),
        ...(body.tokens !== undefined ? { tokens: body.tokens } : {}),
      },
    },
    now,
  );

  const event = authorized.task.event;
  if (completed && body.status === 'failed' && body.installationRevoked && event)
    await verifyRevoked(ctx, event, now);

  if (completed && body.machine) {
    const { reportTaskFailure } = await import('./events');
    await reportTaskFailure(ctx, authorized, body.error ?? 'The machine failed');
  }
  if (completed) {
    if (!body.machine) endTyping(ctx, authorized);
    deliverWaiting(ctx, authorized.task);
  }

  if (completed)
    await stopTaskMachine(
      ctx,
      stops ? authorized : { ...authorized, logsComplete: true },
      false,
      runner,
    );

  return json({ ok: true });
}

/** A runner's claim that the event's installation was revoked: retired only once the platform, asked on a read token minted here, says so too. */
async function verifyRevoked(
  ctx: CallbackContext,
  event: NonNullable<TaskStatus['task']['event']>,
  now: number,
): Promise<void> {
  const integration = ctx.integrations[event.integration];
  const id = `${event.appId}:${event.installationId}`;
  if (!integration?.isUninstalled) return;
  const [app, installation] = await Promise.all([
    ctx.store.get('app', event.appId),
    ctx.store.get('installation', id),
  ]);
  if (!app || !installation || installation.deletedAt) return;
  try {
    const token = await installationToken(
      ctx,
      integration,
      installation,
      decryptSecret(ctx.config, app.credentials),
      { tools: integration.tools.presets['read-only'] },
    );
    if ((await integration.installed?.(token, ctx.fetch)) !== false) return;
  } catch (error) {
    if (!integration.isUninstalled(error)) return;
  }
  await uninstall(ctx.store, id, now);
}

/** After the runner has its answer: syncs the conversation with the task's approvals the report carried. */
async function announceApprovals(ctx: CallbackContext, id: string): Promise<void> {
  const task = (await ctx.store.get('task', id))?.task;
  if (!task?.context?.approvals) return;

  (ctx.waitUntil ?? (() => {}))(
    syncApprovals(ctx, task, task.context.approvals).catch(error =>
      console.error(`coder server: could not show the approvals of task ${id}`, error),
    ),
  );
}

/** A runner posts its replies itself, so its first post or the turn's end clears the working indicator, after the answer. */
function endTyping(ctx: CallbackContext, status: TaskStatus): void {
  const task = status.task;
  const work = import('../chat')
    .then(chat => chat.endTyping(ctx, status))
    .catch(error =>
      console.error(
        `coder server: could not clear the working indicator of task ${task.id}`,
        error,
      ),
    );
  ctx.waitUntil?.(work);
}

const CALL_ID = /^[a-f0-9-]{36}$/;

/** The task's own conversation, for a tool call from its running attempt. */
async function conversationReplies(ctx: CallbackContext, authorized: TaskStatus) {
  const event = authorized.task.event;
  if (!event || authorized.task.source !== event.integration)
    throw new Error('The task has no conversation');
  const app = await ctx.store.get('app', event.appId);
  if (!app) throw new Error('The conversation app is gone');
  const { eventReplies } = await import('../chat');

  return { event, replies: await eventReplies(ctx, app, event, authorized) };
}

/** Runs `send` once per call id for this attempt; a retry of a sent call is answered without posting. */
async function conversationCall(
  ctx: CallbackContext,
  kind: 'reply' | 'react',
  id: string,
  send: (conversation: Awaited<ReturnType<typeof conversationReplies>>) => Promise<void>,
): Promise<Response> {
  const authorized = ctx.callbackTask!;
  const key = `${kind}:${authorized.task.id}:${authorized.generation ?? 0}:${id}`;
  const now = (ctx.now ?? Date.now)();
  if (!(await ctx.store.create('delivery', key, { at: now }, { ttlMs: CALL_TTL_MS })))
    return json({ ok: true, duplicate: true });
  try {
    await send(await conversationReplies(ctx, authorized));
  } catch (error) {
    await ctx.store.delete('delivery', key);
    return json({ error: error instanceof Error ? error.message : String(error) }, 409);
  }

  return json({ ok: true });
}

export async function sendReply(req: Request, ctx: CallbackContext): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as
    { id?: unknown; text?: unknown } | undefined;
  if (typeof body?.id !== 'string' || !CALL_ID.test(body.id))
    return json({ error: 'Invalid call id' }, 400);
  if (typeof body.text !== 'string' || !body.text.trim())
    return json({ error: 'Reply text is required' }, 400);
  const text = body.text.trim();

  return conversationCall(ctx, 'reply', body.id, async ({ event, replies }) => {
    // The turn's first tool post carries the notice.
    const authorized = ctx.callbackTask!;
    const notice =
      authorized.task.notice && (await takeNotice(ctx, authorized))
        ? authorized.task.notice
        : undefined;
    const sent = await replies.post(text, notice).catch(async error => {
      if (notice) await returnNotice(ctx, authorized);
      throw error;
    });
    if (sent)
      await rememberPost(
        ctx,
        event,
        sent.ids ?? (sent.id ? [sent.id] : []),
        (ctx.now ?? Date.now)(),
      );
  });
}

export async function sendReaction(req: Request, ctx: CallbackContext): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as
    { id?: unknown; emoji?: unknown; message?: unknown } | undefined;
  if (typeof body?.id !== 'string' || !CALL_ID.test(body.id))
    return json({ error: 'Invalid call id' }, 400);
  if (typeof body.emoji !== 'string' || !body.emoji.trim())
    return json({ error: 'Emoji is required' }, 400);
  if (body.message !== undefined && (typeof body.message !== 'string' || !body.message.trim()))
    return json({ error: 'Message id must be a non-empty string' }, 400);
  const { emoji, message } = body;

  return conversationCall(ctx, 'react', body.id, async ({ replies }) => {
    if (!replies.react) throw new Error('The conversation cannot add reactions');
    await replies.react(emoji.trim(), message);
  });
}

export async function refreshCredential(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const authorized = ctx.callbackTask!;
  const body = (await req.json().catch(() => ({}))) as {
    authJson?: unknown;
    credentialId?: unknown;
  };
  const credentialId = body.credentialId;
  const { writeBack } = taskGrants(authorized.task);
  // A rotated auth.json lands only on a credential the runner is granted to rewrite, and only once it works upstream.
  const allowed =
    typeof credentialId === 'string' &&
    (writeBack === 'granted' ||
      (writeBack === 'asker' &&
        parseCredentialId(credentialId).owner === turnStarter(authorized.task)));
  if (
    typeof body.authJson !== 'string' ||
    !allowed ||
    !(
      await taskEngineCredentials(
        ctx,
        authorized.task,
        effectiveConfig(ctx, await taskConfig(ctx.store)),
      )
    ).some(row => row.id === credentialId) ||
    !(await checkCodexAuth(body.authJson, ctx.fetch))
  )
    return json({ error: 'Invalid credential update' }, 400);

  return json({
    kept: await writeBackCodexAuth(ctx.store, ctx.config, credentialId, body.authJson),
  });
}

/** A turn's OAuth connection token or personal key on first use, `refused` naming by fingerprint a token its server refused; the refresh token stays here. A personal one first needs its owner's approval, else is refused with the reason the model reads. One that needs reconnecting answers `needs-auth`, logged once per task. With `git`, only whether the turn acts as the connection now, with its commit identity. */
export async function taskConnection(req: Request, ctx: CallbackContext): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as
    | {
        connection?: unknown;
        refused?: unknown;
        url?: unknown;
        connectionCreatedAt?: unknown;
        git?: unknown;
      }
    | undefined;
  if (typeof body?.connection !== 'string' || !body.connection)
    return json({ error: 'A connection id is required' }, 400);
  const authorized = ctx.callbackTask!;
  const { task } = authorized;
  const { connectionToken, taskAsker, turnConnections } = await import('../connections/resolve');
  const { findConnection } = await import('../connections/records');
  const { actAsRefusal } = await import('./changes');
  const turn = await turnConnections(ctx, task);
  const connection = await findConnection(ctx, body.connection, taskAsker(task), turn.accounts);
  if (!connection || !turn.ids.includes(body.connection))
    return json({ error: 'Unknown connection' }, 404);
  // A turn's git probe answers whether an approved personal connection acts now, with its commit identity, and never asks or mints a token.
  const git = body.git === true;
  try {
    const refusal = connection.owner
      ? await actAsRefusal(ctx, authorized, connection, turn.accounts, !git)
      : undefined;
    if (refusal) return json({ error: refusal }, 403);
    if (git) {
      // The identity comes from the connection's own login and id, with no token to read them by.
      const author =
        connection.login && connection.account !== undefined
          ? await ctx.integrations[connection.provider]?.repos
              ?.commitAuthor?.({ login: connection.login, id: connection.account }, '', ctx.fetch)
              .catch((error: unknown) => {
                console.error('coder server: commit author lookup failed', error);
                return undefined;
              })
          : undefined;

      return json(author ? { author: { name: author.name, email: author.email } } : {});
    }
    const { token, name } = await connectionToken(
      ctx,
      task,
      body.connection,
      typeof body.refused === 'string' ? body.refused : undefined,
      { url: body.url, connectionCreatedAt: body.connectionCreatedAt },
      connection,
    );
    if (token) return json({ token });
    const platform = task.event && ctx.integrations[task.event.integration]?.name;
    await taskWarnings(ctx, task.id, [`${name ?? platform ?? 'A connection'} needs reconnecting.`]);

    return json({ status: 'needs-auth' });
  } catch (error) {
    console.error('coder server: connection token failed', error);
    return json({ error: 'The connection is unavailable' }, 502);
  }
}

export async function readContext(
  req: Request,
  ctx: CallbackContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const authorized = ctx.callbackTask!;

  try {
    const { connectionSecrets: _secrets, ...context } = await taskContext(
      ctx,
      authorized,
      ctx.callbackWorkspace,
    );
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
