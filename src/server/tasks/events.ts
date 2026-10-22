/** A platform event becomes a task: dedupe, installation, linked member, agent match, credential, then the queue. */
import { secretRows, taskConnectionSecrets } from '../connections/resolve';
import { connectionGrants } from '../connections/records';
import { dispatchFilePrefixes } from '../agents/repo';
import { randomUUID } from 'node:crypto';
import { effectiveSettings, matchAgent, agentAccess } from '../../agent/definition';
import type { Integration } from '../../integrations/types';
import type { AgentApp, AgentEvent, AgentTask, Installation, TaskSource } from '../../agent/types';
import { forInstallation, type ServerContext } from '../context';
import type { DispatchLoaded, FailedDelivery, Store, TaskStatus } from '../store/types';
import { AgentLoadError } from '../../agent/load';
import { dispatchStore } from '../store/primed';
import { runLocalTask } from './local';
import { syncLocalAgents } from '../store/local';
import { credentialFix, resolveEngine } from '../settings/credentials';
import { dispatchTokens } from './context';
import { chooseRunner } from '../runners/select';
import {
  buildContext,
  conversationKey,
  conversationRecord,
  conversationState,
  everyMessageDelivered,
  describe,
  directAsk,
  forgetUnseen,
  recordUnseen,
  rememberConversation,
  steerConversation,
  unseenAcknowledgement,
} from './conversation';
import { eventPrompt } from '../../agent/context/turn';
import { generateTaskId } from '../../core/state';
import { generateRunId } from '../../flow/runs';
import type { PendingDelivery } from './queue';
import { answerInConversation, openApprovals, readApprovalCommand } from './approvals';
import { dashPath, organizationSlug } from '../auth/members';
import { eventSpace, syncMembers } from './access';

const PENDING_TTL_MS = 60_000;

export const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const CONTEXT_LIMIT = 256 * 1024;
/** A thread hears that no model is configured once in this long. */
const SETUP_NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Public and private replies to an event. */
export interface Replies {
  post(text: string, progress?: boolean): Promise<{ id?: string; ids?: string[] } | null | void>;
  react?(emoji: string, message?: string): Promise<void>;
  /** A reply that reports a failure; Linear marks the session failed, elsewhere it is a plain reply. */
  problem(text: string): ReturnType<Replies['post']>;
  /** Resolves without posting where the platform has no private messages. */
  whisper(text: string): Promise<unknown>;
}

/** Installs are bound from the dashboard; an unbound or removed one runs nothing. */
async function loadInstallation(
  ctx: ServerContext,
  app: AgentApp,
  event: AgentEvent,
): Promise<Installation | undefined> {
  const key = `${app.id}:${event.installationId}`;
  const existing =
    ctx.boundInstallation?.installation.id === key
      ? ctx.boundInstallation.installation
      : await ctx.store.get('installation', key);

  return existing && !existing.deletedAt ? existing : undefined;
}

/** Logs why an event starts nothing: `error` for a fault or a gap in setup, `info` for the routine. */
export function dropped(event: AgentEvent, reason: string, level: 'error' | 'info' = 'info'): void {
  console[level](
    `coder server: ${event.appId} dropped ${event.type} event ${event.deliveryId}: ${reason}`,
  );
}

/** The Coder user linked to the event's actor, when they belong to this workspace. */
export async function linkedMember(
  ctx: ServerContext,
  integration: Integration,
  event: Pick<AgentEvent, 'actor'>,
) {
  const user = await ctx.auth!.linkedUser(integration.id, event.actor.id).catch(() => undefined);
  return user?.organizations?.includes(ctx.organizationId) ? user : undefined;
}

export const ACCESS_UNCHECKED = 'Coder could not check your access to this conversation.';

/** Whether the actor may write where the event happened, as the platform says; `null` when the check failed, which counts as no, and a platform without one answers nothing. */
export async function writeCheck(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  token: () => Promise<string | undefined>,
): Promise<boolean | null | undefined> {
  if (!integration.auth.canWrite) return undefined;

  return integration.auth.canWrite(event, (await token())!, ctx.fetch).catch((error: unknown) => {
    console.error(
      `coder server: ${integration.id} write check failed for ${event.appId} event ${event.deliveryId}`,
      error,
    );

    return null;
  });
}

async function setupText(ctx: ServerContext, engine: string, slug?: string): Promise<string> {
  return `No model is configured yet. If you have access to it, [Add a model](${await credentialFix(ctx, engine, slug)}).`;
}

/** What the thread gets when a run fails without an answer. */
async function failureText(ctx: ServerContext, engine: string, slug?: string): Promise<string> {
  return `There was a problem with your connected model. If you have access to it, [Check the model](${await credentialFix(ctx, engine, slug)}).`;
}

/** A dashboard page at `path`, linked from the thread: the task's own when no reply came, the agent's settings when its model can't run. */
function dashPage(ctx: ServerContext, slug: string, path: string): string | undefined {
  const base = ctx.config.publicUrl?.replace(/\/$/, '');

  return base ? `${base}${dashPath(slug, path)}` : undefined;
}

/** Starts an interrupted local handoff before steering its conversation. */
async function reservedConversation(
  ctx: ServerContext,
  event: AgentEvent,
  agent: string,
): Promise<TaskStatus | undefined> {
  const thread = event.chat?.thread.id;
  if (!ctx.local || event.repo || !thread) return undefined;
  const receipts = await ctx.store.list<{ pending?: PendingHandoff }>('delivery', {
    prefix: 'delivery:',
  });
  const reserved = receipts.find(({ value }) => {
    const task = value.pending?.task;
    return (
      task?.flow === 'default' &&
      task.agent === agent &&
      task.event?.appId === event.appId &&
      task.event.installationId === event.installationId &&
      task.event.chat?.thread.id === thread &&
      value.pending?.taskId
    );
  })?.value.pending;
  if (!reserved?.task) return undefined;
  const started = await runLocalTask(ctx, reserved.task, reserved.taskId);
  await rememberConversation(ctx, reserved.task.event!, started.task.id, (ctx.now ?? Date.now)());

  return (await ctx.store.get('task', started.task.id)) ?? started;
}

/** One parsed event through dedupe, installation, tokens, agent match, and a task. */
export async function dispatchEvent(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  event: AgentEvent,
  now: () => number,
  replies: Replies,
): Promise<{ taskId?: string; work?: Promise<void> }> {
  const delivery = `delivery:${integration.id}:${app.id}:${event.installationId}:${event.chat?.thread.id ?? ''}:${event.deliveryId}`;
  const installation = await loadInstallation(ctx, app, event);
  if (!installation) {
    dropped(event, `installation ${event.installationId} is not bound or was removed`, 'error');
    return {};
  }
  if (ctx.local)
    await (
      ctx.syncAgent?.(app.agent) ??
      syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations, app.agent)
    ).catch(error => console.error('coder server: local agent sync failed', error));
  if (!ctx.local) {
    // One read claims the delivery, before any platform call, and loads what dispatch needs; a done or in-flight delivery costs nothing more.
    const owner = randomUUID();
    const input = {
      delivery: { key: delivery, owner, at: now(), ttlMs: PENDING_TTL_MS },
      agent: app.agent,
      ...(event.chat
        ? { conversation: conversationKey(event.appId, event.installationId, event.chat.thread.id) }
        : {}),
      ...(event.actor.id ? { actor: { platform: integration.id, id: event.actor.id } } : {}),
      installation,
      files: dispatchFilePrefixes(installation, event),
    };
    const { claimed: mine, loaded } = await ctx.store.dispatchState(input);
    if (!mine) {
      dropped(event, 'another request holds or finished its delivery');
      return {};
    }
    const primed = loaded ? { ...ctx, store: dispatchStore(ctx.store, loaded, input) } : ctx;
    if ((await primed.store.get('agent', app.agent))?.settings?.disabled) {
      await ctx.store.updateDelivery(delivery, owner, undefined);
      dropped(event, `agent ${app.agent} is disabled`);
      return {};
    }
    try {
      const result = await claimed(
        primed,
        integration,
        app,
        credentials,
        event,
        installation,
        now,
        replies,
        delivery,
        { owner, loaded: loaded && { ...loaded, store: primed.store } },
      );
      // A task's admission and a handoff's work write the receipt themselves; anything else is done here.
      if (!result.work && !result.taskId && !result.steered)
        await ctx.store.updateDelivery(delivery, owner, { at: now() }, { ttlMs: DELIVERY_TTL_MS });
      await result.work;

      return result.taskId ? { taskId: result.taskId } : {};
    } catch (error) {
      // Only the lease goes; a task a crashed admission left pending waits for the next delivery.
      const left = await ctx.store
        .get<PendingDelivery>('delivery', delivery)
        .catch(() => undefined);
      const pending = left?.pending?.task ? left.pending : undefined;
      await ctx.store
        .updateDelivery(delivery, owner, pending ? { at: now(), pending } : undefined)
        .catch(() => {});
      throw error;
    }
  }

  if ((await ctx.store.get('agent', app.agent))?.settings?.disabled) {
    dropped(event, `agent ${app.agent} is disabled`);
    return {};
  }
  if (await ctx.store.get('delivery', delivery).then(receipt => receipt && !receipt.pending)) {
    dropped(event, 'its delivery is already done');
    return {};
  }

  const key = JSON.stringify([event.appId, event.installationId, event.chat?.thread.id]);
  const locks = (ctx.store.handoffs ??= new Map());
  const work = (locks.get(key) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const result = await claimed(
        ctx,
        integration,
        app,
        credentials,
        event,
        installation,
        now,
        replies,
        delivery,
      );
      await result.work;
      return result;
    });

  locks.set(key, work);
  try {
    return await work;
  } finally {
    if (locks.get(key) === work) locks.delete(key);
  }
}

export interface PendingHandoff {
  event: AgentEvent;
  task?: AgentTask;
  taskId?: string;
}

/** Runs `work` under the delivery's receipt: the claim this request holds, or one it takes here; done once the work lands, released when it fails. */
async function handoff(
  ctx: ServerContext,
  delivery: string,
  event: AgentEvent,
  now: () => number,
  work: (pending: PendingHandoff) => Promise<void>,
  task?: AgentTask,
  slug?: () => Promise<string>,
  claim?: string,
): Promise<{ work?: Promise<void> }> {
  const owner = claim ?? randomUUID();
  const taskId = task && (task.flow === 'default' ? generateTaskId() : generateRunId());
  // A local task runs under its own id, so its link names that one.
  const taskUrl =
    taskId && task?.taskUrl
      ? dashPage(ctx, await (slug?.() ?? organizationSlug(ctx)), `/tasks/${taskId}`)
      : undefined;
  let pending: PendingHandoff = {
    event,
    ...(task ? { task: { ...task, ...(taskUrl ? { taskUrl } : {}) }, taskId } : {}),
  };
  if (ctx.local && !event.repo) {
    const receipt = await ctx.store.get<{ pending?: PendingHandoff }>('delivery', delivery);
    if (receipt && !receipt.pending) {
      dropped(event, 'its delivery is already done');
      return {};
    }
    pending = receipt?.pending ?? pending;
    if (pending.task && !pending.taskId) throw new Error('Local delivery has no task binding');
    await ctx.store.put('delivery', delivery, { at: now(), owner, pending });
  } else if (
    !claim &&
    !(await ctx.store.create(
      'delivery',
      delivery,
      { at: now(), owner, pending },
      { ttlMs: PENDING_TTL_MS },
    ))
  ) {
    dropped(event, 'another request holds or finished its delivery');
    return {};
  }
  return {
    work: (async () => {
      let renewal = Promise.resolve();
      const timer = ctx.local
        ? undefined
        : setInterval(() => {
            renewal = renewal
              .then(async () => {
                await ctx.store.updateDelivery(
                  delivery,
                  owner,
                  { at: now(), owner, pending },
                  { ttlMs: PENDING_TTL_MS },
                );
              })
              .catch(() => {});
          }, PENDING_TTL_MS / 3);
      try {
        await work(pending);
        if (timer) clearInterval(timer);
        await renewal;
        await ctx.store.updateDelivery(delivery, owner, { at: now() }, { ttlMs: DELIVERY_TTL_MS });
      } catch (error) {
        if (timer) clearInterval(timer);
        await renewal;
        if (!ctx.local || !pending.task)
          await ctx.store.updateDelivery(delivery, owner, undefined).catch(() => {});
        throw error;
      }
    })(),
  };
}

async function claimed(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  event: AgentEvent,
  installation: Installation,
  now: () => number,
  replies: Replies,
  delivery: string,
  claim?: { owner: string; loaded?: DispatchLoaded & { store: Store } },
): Promise<{ taskId?: string; steered?: boolean; work?: Promise<void> }> {
  let resolvedSlug: Promise<string> | undefined;
  const slug = () => (resolvedSlug ??= organizationSlug(ctx, claim?.loaded?.workspace));
  const effect = (work: () => Promise<void>) =>
    handoff(ctx, delivery, event, now, work, undefined, slug, claim?.owner);

  // Dispatch reads only: matching, usage, history and the write check, minting only on a cache miss. Execution mints the task's own token.
  const tokens = dispatchTokens(ctx, integration, installation, event, credentials);
  const token = async () => (await tokens(event.integration))!.token();

  // An approval answer in a task's conversation goes to that task, never to the agent; a bare one only while one approval is open.
  const answer = event.chat ? readApprovalCommand(event.text) : undefined;
  const asked = answer && (await conversationState(ctx, event)).status;
  if (answer && asked && (answer.id || (await openApprovals(ctx, asked.task.id)).length === 1))
    return effect(() =>
      answerInConversation(ctx, integration, asked, answer, event, token, text =>
        replies.whisper(text),
      ),
    );

  const [agent, member] = await Promise.all([
    ctx.loadAgent(app, installation, event, tokens, claim?.loaded),
    // The claim's read brought the linked member along.
    ctx.auth && event.actor.id
      ? claim?.loaded
        ? claim.loaded.member
        : linkedMember(ctx, integration, event)
      : undefined,
  ]);
  const match = matchAgent(event, agent);
  if (!match) {
    // A message the agent's wiring filters out still shows under `since` on its next turn.
    const message = event.chat?.message;
    if (message)
      await recordUnseen(ctx, event, {
        id: message.id,
        author: message.author.userName || message.author.userId,
        text: event.text,
        sentAt: message.metadata.dateSent,
      });
    dropped(event, `agent ${agent.id} is not wired for it`);
    return {};
  }

  // Only someone the platform lets write where the event happened starts or steers a task; a failed check says so, so every prompt gets an answer.
  const canWrite = await writeCheck(ctx, integration, event, token);
  if (canWrite === null)
    return effect(async () => {
      await replies.problem(ACCESS_UNCHECKED);
    });
  if (canWrite === false) {
    dropped(event, `${event.actor.login ?? event.actor.id} cannot write where it happened`);
    return {};
  }

  const local = (task: AgentTask) =>
    handoff(
      ctx,
      delivery,
      event,
      now,
      async pending => {
        const saved = pending.task!;
        const started = await runLocalTask(ctx, saved, pending.taskId);
        await Promise.all([
          rememberConversation(ctx, saved.event!, started.task.id, now()),
          forgetUnseen(ctx, saved.event!),
        ]);
        await taskConnectionSecrets(ctx, started.task.id, tokens.minted);
      },
      task,
      slug,
    );

  // A redelivery resumes its own interrupted handoff, never steers the task it made.
  if (ctx.local && !event.repo) {
    const receipt = await ctx.store.get<{ pending?: PendingHandoff }>('delivery', delivery);
    if (receipt?.pending?.task) {
      const saved = receipt.pending.task;
      if (saved.agent !== agent.id || saved.flow !== match.flow) {
        dropped(event, `its interrupted handoff belongs to agent ${saved.agent}`);
        return {};
      }
      return local(saved);
    }
  }

  // A conversation has one task: the first message starts it, every later one steers it.
  const talk = Boolean(event.chat) && match.flow === 'default';
  const state = talk ? await conversationState(ctx, event) : undefined;
  const known = state?.record;
  const described = talk
    ? await describe(ctx, integration, event, {
        token: async () => (await tokens(event.integration))?.token(),
        delivered: everyMessageDelivered(integration, app, agent),
        unseen: state?.unseen,
        loaded: true,
        ...(known ? { existing: known } : {}),
      })
    : event;
  const user = member ? { name: member.name, email: member.email } : undefined;
  const current = talk
    ? (state?.status ?? (await reservedConversation(ctx, described, agent.id)))
    : undefined;
  if (current)
    return effect(async () => {
      await Promise.all([
        steerConversation(ctx, current, described, user, now, state, member?.id),
        syncMembers(ctx, integration, current.task.event ?? event, token),
      ]);
    });

  // A 1:1 conversation runs on the own engine credentials of the member who asked; a shared one, where anyone may steer, on the workspace's. Each turn adds its asker's own connections.
  const requestedBy = !talk || described.chat?.thread.isDM === true ? member?.id : undefined;
  const settings = effectiveSettings(agent);
  const [route, resolved, context, grants, space] = await Promise.all([
    chooseRunner(ctx, { requestedBy, agent: agent.definition.runner }),
    resolveEngine(ctx, settings, requestedBy),
    buildContext(ctx, integration, event, member ?? null),
    connectionGrants(ctx, undefined, agent.usage?.connections),
    eventSpace(ctx, integration, event, token),
  ]);
  const { engine, credential, usable, chain, credentials: engineCredentials } = resolved;
  if (!usable && route.runner !== 'http') {
    const spoken = described.mustReply ?? directAsk(integration, event);
    if (!spoken) {
      dropped(
        event,
        `no usable ${chain.join(' or ')} model${requestedBy ? '' : ' among the workspace credentials'}`,
        'error',
      );
      return {};
    }
    return effect(async () => {
      // Once per thread, unless every prompt waits for an answer; a retry of the delivery that holds the mark may post again.
      const key = `setup:${app.id}:${event.chat?.thread.id ?? event.deliveryId}`;
      const owner = event.deliveryId;
      const first =
        integration.answersEveryPrompt ||
        (await ctx.store.create(
          'delivery',
          key,
          { at: now(), owner },
          { ttlMs: SETUP_NOTICE_TTL_MS },
        ));
      if (!first && (await ctx.store.get<{ owner?: string }>('delivery', key))?.owner !== owner)
        return;
      try {
        await replies.problem(await setupText(ctx, engine, await slug()));
      } catch (error) {
        if (!integration.answersEveryPrompt) await ctx.store.updateDelivery(key, owner, undefined);
        throw error;
      }
    });
  }

  if (Buffer.byteLength(JSON.stringify(event)) > CONTEXT_LIMIT)
    throw new Error('Event exceeds 256 KB');
  if (Buffer.byteLength(JSON.stringify(context)) > CONTEXT_LIMIT)
    throw new Error('Task context exceeds 256 KB');

  const id = `${event.deliveryId}-${agent.id}`;
  const taskUrl = dashPage(ctx, await slug(), `/tasks/${id}`);
  const settingsUrl = dashPage(
    ctx,
    await slug(),
    `/agents/${encodeURIComponent(agent.id)}/settings`,
  );
  const task: AgentTask = {
    id,
    source: event.integration as TaskSource,
    agent: agent.id,
    flow: match.flow,
    ...route,
    event: space ? { ...described, space } : described,
    failureReply: await failureText(ctx, engine, await slug()),
    ...(taskUrl ? { taskUrl } : {}),
    ...(settingsUrl ? { settingsUrl } : {}),
    author: integration.author?.(app.name) ?? app.name,
    definition: agent.definition,
    access: agentAccess(agent),
    engineChain: chain,
    engineCredentials,
    ...(credential ? { credential } : {}),
    ...(requestedBy ? { requestedBy } : {}),
    ...(agent.files ? { files: agent.files } : {}),
    usage: { ...agent.usage, engine },
    tools: match.tools,
    connections: grants,
    ...(Object.keys(context).length ? { context } : {}),
  };
  if (ctx.local && !event.repo && route.runner === 'local' && !route.runnerId) return local(task);

  // The queue steers an active task of the conversation itself, so two first messages at once make one task; the task's conversation, acknowledged messages and secrets land with it.
  const admitted = now();
  const [delivered] = await Promise.all([
    ctx.queue.deliver(
      ctx.organizationId,
      task,
      admitted,
      { key: delivery, ttlMs: DELIVERY_TTL_MS, ...(claim ? { owner: claim.owner } : {}) },
      talk ? eventPrompt([described], user) : undefined,
      ctx.config.maxQueued ?? 1000,
      true,
      {
        conversation: conversationRecord(described, id, admitted),
        unseen: unseenAcknowledgement(described),
        secrets: secretRows(ctx, id, tokens.minted),
      },
    ),
    syncMembers(ctx, integration, task.event!, token),
  ]);

  return delivered;
}

// Platform events Coder failed to handle: kept a day for the agent's Usage page, and told to their thread once when asked directly.

/** Most failures an agent read lists; the count covers them all. */
const LISTED = 50;

/** Keeps the failure in the workspace the installation is bound to, and tells the event's thread the first time if someone asked directly. */
export async function recordFailure(
  ctx: ServerContext,
  app: AgentApp,
  error: unknown,
  installation?: string,
  event?: AgentEvent,
  replies?: () => Promise<Replies> | Replies,
): Promise<void> {
  const integration = ctx.integrations[app.integration];
  const repo = event?.repo && `${event.repo.owner}/${event.repo.name}`;
  const url = event && (integration?.link?.(event) ?? (repo && integration?.repos?.url(repo)));
  let first = false;
  try {
    const tenant =
      (installation && (await forInstallation(ctx, `${app.id}:${installation}`))) || ctx;
    const failure: FailedDelivery = {
      at: (ctx.now ?? Date.now)(),
      organization: tenant.organizationId,
      integration: app.integration,
      app: app.id,
      agent: app.agent,
      error: (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 500),
      ...(event ? { type: event.type, delivery: event.deliveryId } : {}),
      ...(event?.chat ? { thread: event.chat.thread.id } : {}),
      ...(repo ? { repo } : {}),
      ...(url ? { url } : {}),
    };
    const key = `failed:${app.agent}:${event?.deliveryId ?? randomUUID()}`;
    first = await tenant.store.create('delivery', key, failure, { ttlMs: DELIVERY_TTL_MS });
  } catch (cause) {
    console.error(`coder server: could not record a failed delivery for ${app.id}`, cause);
  }
  if (!first || !replies || !integration || !event || !directAsk(integration, event)) return;

  try {
    await (
      await replies()
    ).problem(
      error instanceof AgentLoadError
        ? error.message
        : `Coder could not handle this message. If you run this server, check its logs. Otherwise [report the problem](${ctx.config.issuesUrl}).`,
    );
  } catch (cause) {
    console.error(`coder server: could not tell ${app.id}'s thread about a failed delivery`, cause);
  }
}

/** A platform task that ended before its agent answered: a direct ask's thread gets the failure reply once. */
export async function reportTaskFailure(
  ctx: ServerContext,
  task: AgentTask,
  error: unknown,
): Promise<void> {
  const event = task.event;
  if (!event || task.source !== event.integration) return;
  const app = await ctx.store.get('app', event.appId).catch(cause => {
    console.error(`coder server: could not report the failure of task ${task.id}`, cause);
  });
  if (!app) return;
  const { eventReplies } = await import('../chat');

  await recordFailure(ctx, app, error, event.installationId, event, () =>
    eventReplies(ctx, app, event),
  );
}

/** An agent's failed deliveries of the last day: how many, and the newest. */
export async function failedDeliveries(
  store: Store,
  agent: string,
): Promise<{ failed: number; recent: FailedDelivery[] }> {
  const rows = await store.list<FailedDelivery>('delivery', { prefix: `failed:${agent}:` });
  const recent = rows.map(row => row.value).sort((a, b) => b.at - a.at);

  return { failed: recent.length, recent: recent.slice(0, LISTED) };
}
