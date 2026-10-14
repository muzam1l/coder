/** A platform event becomes a task: dedupe, installation, linked member, agent match, credential, then the queue. */
import { taskConnectionSecrets } from '../connections/resolve';
import { connectionGrants } from '../connections/grants';
import { randomUUID } from 'node:crypto';
import { effectiveSettings } from '../../agent/definition';
import type { Integration } from '../../integrations/types';
import { matchAgent } from '../../agent/match';
import type {
  Agent,
  AgentApp,
  AgentEvent,
  AgentTask,
  Installation,
  InstallationSettings,
  TaskSource,
} from '../../agent/types';
import type { TaskContext } from '../../agent/types';
import { issueLinkToken } from '../auth/link';
import type { ServerContext } from '../context';
import { updateMetadata } from '../store';
import type { Store } from '../store/types';
import { machineSignedIn, runLocalTask } from './local';
import { syncLocalAgents } from '../store/local';
import { credentialFix, resolveCredential } from '../settings/credentials';
import { dispatchTokens, requesterToken, type EventTokens } from './context';
import { chooseRunner } from '../runners';
import { sessionKey, addInbox } from './queue';
import { buildContext, conversationKey, NOTE_TTL_MS, threadKey } from './thread';
import {
  appendTaskLog,
  enqueueSteer,
  generateTaskId,
  loadTask,
  reconcileTask,
} from '../../core/state';
import { generateRunId } from '../../flow/runs';
import { steerTask } from '../../core/task/actions';
import { connectionWarnings } from './logs';
import { DEFAULT_ENGINE } from '../../core/defaults';
import { dashPath, organizationSlug } from '../auth/account';

const PENDING_TTL_MS = 60_000;

export const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const CONTEXT_LIMIT = 256 * 1024;
const LINK_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
/** A thread hears that no model is configured once in this long. */
const SETUP_NOTICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SETTING_KEYS = ['model', 'engine', 'effort'] as const;

const SETTINGS_HELP = [
  'Usage:',
  '• `/setup model <name>`. Sets the engine model. Also accepts `engine` and `effort`.',
  '• `/setup show`. Shows the current settings.',
].join('\n');

/** Where dispatch answers an event: its thread in public, the actor in private, and the thread's recent messages. */
export interface Replies {
  post(text: string): Promise<unknown>;
  /** A reply that reports a failure; Linear marks the session failed, elsewhere it is a plain reply. */
  problem(text: string): Promise<unknown>;
  /** Resolves without posting where the platform has no private messages. */
  whisper(text: string): Promise<unknown>;
  recent?(): Promise<TaskContext['messages']>;
}

/** `/setup` settings commands: server-side installation settings, no task involved. */
export function isSettingsCommand(event: AgentEvent): boolean {
  return event.type === 'command';
}

function shown(settings: InstallationSettings | undefined): string {
  const entries = Object.entries(settings ?? {}).filter(([, value]) => value);
  return entries.length
    ? `Current settings:\n${entries.map(([key, value]) => `• ${key}: \`${value}\``).join('\n')}`
    : 'No settings yet. A workspace admin can configure this agent in the dashboard.';
}

/** Whether a settings command writes, rather than shows help or the current settings. */
export function changesSettings(event: AgentEvent): boolean {
  const [word = '', ...rest] = event.text.trim().split(/\s+/);
  return (SETTING_KEYS as readonly string[]).includes(word) && rest.join(' ').trim() !== '';
}

/** Apply one settings command; returns the reply text. */
export async function applySettings(
  event: AgentEvent,
  installation: Installation,
  store: Store,
): Promise<string> {
  const [word = '', ...rest] = event.text.trim().split(/\s+/);
  const value = rest.join(' ').trim();
  const settings: InstallationSettings = { ...installation.settings };
  let text: string;
  if (!word) text = SETTINGS_HELP;
  else if (word === 'show') text = shown(installation.settings);
  else if ((SETTING_KEYS as readonly string[]).includes(word)) {
    if (!value) text = `Give a value: \`/setup ${word} <name>\`.`;
    else {
      settings[word as (typeof SETTING_KEYS)[number]] = value;
      text = `${word} set to \`${value}\`.`;
    }
  } else text = `Unknown setting \`${word}\`.\n${SETTINGS_HELP}`;
  if (JSON.stringify(settings) !== JSON.stringify(installation.settings ?? {}))
    await updateMetadata(store, 'installation', installation.id, { settings });
  return text;
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

/** The Coder user linked to the event's actor, when they belong to this workspace. */
async function linkedMember(ctx: ServerContext, integration: Integration, event: AgentEvent) {
  const user = await ctx.auth!.linkedUser(integration.id, event.actor.id).catch(() => undefined);
  return user?.organizations?.includes(ctx.organizationId) ? user : undefined;
}

function outsiderEvent(
  ctx: ServerContext,
  member: unknown,
  canWrite: boolean | undefined,
): boolean {
  return ctx.auth ? !member : canWrite === false;
}

/** Whether the actor may write where the event happened, as the platform says; a failed check counts as no, and a platform without one answers nothing. */
async function writeCheck(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  tokens: EventTokens,
): Promise<boolean | undefined> {
  if (!integration.auth.canWrite) return undefined;
  const token = await (await tokens(event.integration))!.token();
  return integration.auth.canWrite(event, token!, ctx.fetch).catch((error: unknown) => {
    console.error(`coder server: ${integration.id} write check failed`, error);

    return false;
  });
}

/** The link that makes an actor known, at most once a day each unless they asked for something that needs it. */
async function sendLink(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  event: AgentEvent,
  replies: Replies,
  now: number,
  always = false,
): Promise<void> {
  const base = ctx.config.publicUrl?.replace(/\/$/, '');
  const owner = randomUUID();
  const first =
    always ||
    (await ctx.store.create(
      'delivery',
      `link:${integration.id}:${event.actor.id}`,
      { at: now, owner },
      { ttlMs: LINK_PROMPT_TTL_MS },
    ));
  if (!base || !first) return;
  const text = (url: string) => `Link your Coder account so I can work for you here: ${url}`;
  // A public reply carries no secret: the platform's own sign-in proves who follows the link.
  try {
    if (integration.auth.user) {
      await replies.post(
        text(
          `${base}/connect/${integration.id}?installation=${encodeURIComponent(installation.id)}`,
        ),
      );
      return;
    }
    const link = await issueLinkToken(ctx, {
      platform: integration.id,
      platformUserId: event.actor.id,
    });
    await replies.whisper(text(`${base}/connect?token=${encodeURIComponent(link)}`));
  } catch (error) {
    if (!always)
      await ctx.store
        .updateDelivery(`link:${integration.id}:${event.actor.id}`, owner, undefined)
        .catch(() => {});
    throw error;
  }
}

/** Remembers a thread Coder started a task in. */
async function converse(ctx: ServerContext, event: AgentEvent, now: number): Promise<void> {
  if (!event.chat) return;
  const key = conversationKey(event.appId, event.installationId, event.chat.thread.id);
  await ctx.store.put('delivery', key, { at: now }, { ttlMs: NOTE_TTL_MS });
}

/** The integrations the agent declares that the event can reach, found without minting. */
async function reachable(tokens: EventTokens, agent: Agent): Promise<Set<string>> {
  const ids = Object.keys(agent.definition.integrations);
  const found = await Promise.all(ids.map(id => tokens(id)));

  return new Set(ids.filter((_, index) => found[index]));
}

async function frozenToolScopes(
  ctx: ServerContext,
  installation: Installation,
  event: AgentEvent,
): Promise<NonNullable<AgentTask['toolScopes']>> {
  const scopes: NonNullable<AgentTask['toolScopes']> = {};
  if (event.repo)
    scopes[event.integration] = {
      repo: { owner: event.repo.owner, name: event.repo.name },
    };
  else if (event.chat)
    scopes[event.integration] = {
      thread: event.chat.thread.id,
      ...(event.within ? { within: event.within } : {}),
    };

  for (const [id, connection] of Object.entries(installation.connections ?? {})) {
    if (connection.kind !== 'installation') continue;

    const linked = await ctx.store.get('installation', connection.id);
    const configRepo = linked?.settings?.configRepo;
    const match = configRepo && /^([^/]+)\/([^/]+)$/.exec(configRepo);
    if (match) scopes[id] = { repo: { owner: match[1]!, name: match[2]! } };
  }

  return scopes;
}

async function setupText(ctx: ServerContext, engine: string): Promise<string> {
  return `No model is configured yet. If you have access to it, [add one here](${await credentialFix(ctx, engine)}).`;
}

/** What the thread gets when a run ends without an answer. */
async function failureText(ctx: ServerContext, engine: string): Promise<string> {
  return `There was a problem with your connected model. If you have access to it, [check it here](${await credentialFix(ctx, engine)}).`;
}

/** Someone spoke to the agent: a mention, a direct message, or a message that @-mentions it. */
const direct = (integration: Integration, event: AgentEvent) =>
  integration.events[event.type]?.on === 'mention' ||
  event.chat?.thread.isDM === true ||
  event.chat?.message?.isMention === true;

/** The session's task still running for this app, agent and requester in the event's thread. */
async function runningIn(
  ctx: ServerContext,
  event: AgentEvent,
  agent: string,
  requester?: string,
): Promise<string | undefined> {
  const key = sessionKey({ agent, requester, event });
  const session =
    (await localSession(ctx, key)) ??
    (await ctx.store.get<SessionBinding>('snapshot', `session:${key}`));
  if (
    !session ||
    session.requester !== requester ||
    !event.actor.id ||
    session.actor !== event.actor.id
  )
    return;

  const queued = await ctx.store.get('task', session.id);
  if (
    queued &&
    ['queued', 'running', 'waiting'].includes(queued.status) &&
    sessionKey(queued.task) === key
  )
    return queued.task.id;

  let found = loadTask(ctx.local!.cwd, session.id);
  if (!found) {
    const receipts = await ctx.store.list<{ pending?: PendingHandoff; session?: SessionBinding }>(
      'delivery',
      { prefix: 'delivery:' },
    );
    const reserved = receipts.find(
      row => row.value.session?.key === key && row.value.session.id === session.id,
    )?.value.pending;
    if (!reserved?.task || reserved.taskId !== session.id || sessionKey(reserved.task) !== key)
      return;
    await runLocalTask(ctx, reserved.task, reserved.taskId);
    found = loadTask(ctx.local!.cwd, session.id);
  }
  if (!found || found.agentId !== agent) return;

  const task = reconcileTask(ctx.local!.cwd, found);

  return task.status === 'running' || task.status === 'queued' ? task.id : undefined;
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
  if (!installation) return {};
  if (ctx.local)
    await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations, app.agent).catch(() => {});
  if ((await ctx.store.get('agent', app.agent))?.settings?.disabled) return {};
  if (
    ctx.local &&
    (await ctx.store.get('delivery', delivery).then(receipt => receipt && !receipt.pending))
  )
    return {};

  if (!ctx.local) {
    // Claimed apart from the queue's receipt, after the tenant checks and before any platform call.
    const claim = `claim:${delivery.slice('delivery:'.length)}`;
    const owner = randomUUID();
    if (
      !(await ctx.store.create('delivery', claim, { owner, at: now() }, { ttlMs: PENDING_TTL_MS }))
    )
      return {};
    try {
      const receipt = await ctx.store.get('delivery', delivery);
      if (receipt && (!receipt.pending || ('owner' in receipt && receipt.owner))) {
        await ctx.store.updateDelivery(claim, owner, undefined);
        return {};
      }
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
      // The handoff receipt owns dedupe and renewal once its work starts.
      await ctx.store.updateDelivery(claim, owner, result.work ? undefined : { at: now() }, {
        ttlMs: DELIVERY_TTL_MS,
      });
      await result.work;

      return result.taskId ? { taskId: result.taskId } : {};
    } catch (error) {
      await ctx.store.updateDelivery(claim, owner, undefined);
      throw error;
    }
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

export interface SessionBinding {
  key: string;
  id: string;
  version: number;
  requester?: string;
  actor: string;
}

async function localSession(ctx: ServerContext, key: string): Promise<SessionBinding | undefined> {
  const receipts = await ctx.store.list<{ session?: SessionBinding }>('delivery', {
    prefix: 'delivery:',
  });
  const snapshot = await ctx.store.get<SessionBinding>('snapshot', `session:${key}`);
  return [...receipts.map(row => row.value.session), snapshot && { ...snapshot, key }]
    .filter((session): session is SessionBinding => session?.key === key)
    .sort((a, b) => (b.version ?? 0) - (a.version ?? 0))[0];
}

export interface PendingHandoff {
  event: AgentEvent;
  task?: AgentTask;
  taskId?: string;
}

async function handoff(
  ctx: ServerContext,
  delivery: string,
  event: AgentEvent,
  now: () => number,
  work: (pending: PendingHandoff) => Promise<void>,
  task?: AgentTask,
  reserve = false,
): Promise<{ work?: Promise<void> }> {
  const owner = randomUUID();
  let pending: PendingHandoff = {
    event,
    ...(task ? { task, taskId: task.flow === 'default' ? generateTaskId() : generateRunId() } : {}),
  };
  let session: SessionBinding | undefined;
  if (ctx.local && !event.repo) {
    const receipt = await ctx.store.get<{ pending?: PendingHandoff; session?: SessionBinding }>(
      'delivery',
      delivery,
    );
    if (receipt && !receipt.pending) return {};
    pending = receipt?.pending ?? pending;
    if (pending.task && !pending.taskId) throw new Error('Local delivery has no task binding');
    session = receipt?.session;
    if (!session && reserve && pending.task) {
      const key = sessionKey(pending.task);
      session = {
        key,
        id: pending.taskId!,
        version: ((await localSession(ctx, key))?.version ?? 0) + 1,
        requester: pending.task.requester,
        actor: pending.task.event!.actor.id,
      };
    }
    await ctx.store.put('delivery', delivery, {
      at: now(),
      owner,
      pending,
      ...(session ? { session } : {}),
    });
  } else if (
    !(await ctx.store.create(
      'delivery',
      delivery,
      { at: now(), owner, pending },
      { ttlMs: PENDING_TTL_MS },
    ))
  )
    return {};
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
        await ctx.store.updateDelivery(
          delivery,
          owner,
          { at: now(), ...(session ? { session } : {}) },
          { ttlMs: DELIVERY_TTL_MS },
        );
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
): Promise<{ taskId?: string; work?: Promise<void> }> {
  const effect = (work: () => Promise<void>) => handoff(ctx, delivery, event, now, work);
  if (isSettingsCommand(event)) {
    // Installation-wide settings change only for a linked member of this workspace.
    if (ctx.auth && changesSettings(event) && !(await linkedMember(ctx, integration, event)))
      return effect(() => sendLink(ctx, integration, installation, event, replies, now(), true));
    return effect(() =>
      applySettings(event, installation, ctx.store)
        .then(reply => replies.whisper(reply))
        .then(() => {}),
    );
  }

  // Dispatch reads only: matching, usage, history and write checks, minting only on a cache miss. Execution mints the task's own token.
  const tokens = dispatchTokens(ctx, integration, installation, event, credentials);
  const [agent, member] = await Promise.all([
    ctx.loadAgent(app, installation, event, tokens),
    ctx.auth && event.actor.id ? linkedMember(ctx, integration, event) : undefined,
  ]);
  // Someone asking the agent directly is a linked member of this workspace, or someone the platform lets write there.
  const addressed = Boolean(
    ctx.auth && event.actor.id && integration.events[event.type]?.addressed,
  );
  const trusted =
    addressed && !member ? await writeCheck(ctx, integration, event, tokens) : undefined;
  if (addressed && !member && !trusted)
    return effect(() => sendLink(ctx, integration, installation, event, replies, now()));

  const requester = member?.id;
  const match = matchAgent(event, agent);
  if (!match) return {};

  const steers = event.chat && match.flow === 'default' && integration.events[event.type]?.steers;
  const local = (task: AgentTask, fallbackText?: string, personal?: string) =>
    handoff(
      ctx,
      delivery,
      event,
      now,
      async pending => {
        const saved = pending.task!;
        const started = await runLocalTask(ctx, saved, pending.taskId);
        await converse(ctx, event, now());
        await taskConnectionSecrets(ctx, started.task.id, [
          ...tokens.minted,
          ...(personal ? [personal] : []),
        ]);
        if (fallbackText) {
          appendTaskLog(ctx.local!.cwd, started.task.id, { kind: 'status', message: fallbackText });
        }
        if (steers) {
          const session = await localSession(ctx, sessionKey(saved));
          if (session && session.id === pending.taskId)
            await ctx.store.put('snapshot', `session:${session.key}`, {
              ...session,
              id: started.task.id,
            });
        }
      },
      task,
      Boolean(steers),
    );
  if (ctx.local && !event.repo) {
    const receipt = await ctx.store.get<{ pending?: PendingHandoff }>('delivery', delivery);
    if (receipt?.pending?.task) {
      const saved = receipt.pending.task;
      if (
        sessionKey(saved) !== sessionKey({ agent: agent.id, requester, event }) ||
        saved.flow !== match.flow
      )
        return {};
      return local(saved);
    }
  }

  const running =
    ctx.local && !event.repo && steers
      ? await runningIn(ctx, event, agent.id, requester)
      : undefined;
  if (running) {
    const queued = await ctx.store.get('task', running);
    const task = loadTask(ctx.local!.cwd, running);
    if (!task || queued?.status === 'queued')
      return effect(async () => {
        if (queued)
          await addInbox(ctx, running, 'steer', { text: event.text }, queued.generation ?? 0);
      });
    if (!task.threadId)
      return effect(async () => {
        enqueueSteer(ctx.local!.cwd, running, event.text);
      });

    return effect(() => steerTask(ctx.local!.cwd, task, event.text).then(() => {}));
  }

  const settings = effectiveSettings(agent);
  const declared = await reachable(tokens, agent);
  const [route, credential, toolScopes, context, grants, personalToken] = await Promise.all([
    chooseRunner(ctx, { requester, agent: agent.definition.runner }),
    resolveCredential(ctx.store, settings.engine, requester),
    frozenToolScopes(ctx, installation, event),
    buildContext(
      ctx,
      integration,
      installation,
      event,
      async id => (declared.has(id) ? tokens(id) : undefined),
      agent,
      integration.events[event.type]?.addressed ? replies.recent : undefined,
      member ?? null,
    ),
    connectionGrants(
      ctx,
      requester,
      agent.usage?.connections,
      Boolean(ctx.auth && !member && !trusted),
    ),
    match.actAs === 'requester'
      ? requesterToken(ctx, integration, event, credentials).catch(() => undefined)
      : undefined,
  ]);
  if (!credential && route.runner !== 'http' && !(await machineSignedIn(ctx, settings.engine))) {
    if ((!ctx.local || event.repo) && steers) {
      const forwarded = await ctx.queue.deliver(
        ctx.organizationId,
        {
          id: `${event.deliveryId}-${agent.id}`,
          source: event.integration as TaskSource,
          agent: agent.id,
          flow: match.flow,
          ...route,
          event,
          requester,
          definition: agent.definition,
          tools: {},
        },
        now(),
        { key: delivery, ttlMs: DELIVERY_TTL_MS },
        true,
        undefined,
        false,
      );
      if (forwarded.steered) return {};
    }
    if (!direct(integration, event)) return {};
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
        await replies.problem(await setupText(ctx, settings.engine ?? DEFAULT_ENGINE));
      } catch (error) {
        if (!integration.answersEveryPrompt) await ctx.store.updateDelivery(key, owner, undefined);
        throw error;
      }
    });
  }

  const reads = new Set(integration.tools.presets.observe);
  const own = match.tools[event.integration] ?? [];
  const fallback = !!ctx.auth && match.actAs === 'requester' && !personalToken;
  const writes = own.some(name => !reads.has(name));
  const check = ctx.auth
    ? member && (writes || fallback)
    : writes ||
      grants.length > 0 ||
      Object.entries(match.tools).some(
        ([id, names]) => id !== event.integration && declared.has(id) && names.length,
      );
  const canWrite =
    trusted ?? (check ? await writeCheck(ctx, integration, event, tokens) : undefined);
  const outsider = outsiderEvent(ctx, member || trusted, canWrite);
  const fallbackText = fallback
    ? `Acting as the app because the requester's account has no usable ${integration.name} token. ${canWrite === true && !outsider ? 'The platform write check passed.' : 'Only reads are allowed.'} [Connect your account](${ctx.config.publicUrl?.replace(/\/$/, '') ?? ''}${dashPath(await organizationSlug(ctx), '/settings/connections')}).`
    : undefined;
  if (fallbackText)
    context.instructions = [
      context.instructions,
      fallbackText,
      'Include the account connection link in your reply.',
    ]
      .filter(Boolean)
      .join('\n\n');

  if (outsider) {
    const comments = new Set(integration.tools.presets.comment);
    for (const id of Object.keys(match.tools))
      match.tools[id] = id === event.integration ? own.filter(name => comments.has(name)) : [];
  } else if ((member && canWrite === false) || (fallback && canWrite !== true))
    match.tools[event.integration] = own.filter(name => reads.has(name));

  const tools = Object.fromEntries(
    Object.entries(match.tools)
      .filter(([id]) => declared.has(id))
      .map(([id, names]): [string, string[]] => {
        if (toolScopes[id]) return [id, names];
        // A linked platform without a bound repository gets no tools at all.
        if (id !== event.integration) return [id, []];
        const reads = new Set(ctx.integrations[id]?.tools.presets.observe ?? []);
        return [id, names.filter(name => reads.has(name))];
      })
      .filter(([, names]) => names.length),
  );
  if (Buffer.byteLength(JSON.stringify(event)) > CONTEXT_LIMIT)
    throw new Error('Event exceeds 256 KB');
  if (Buffer.byteLength(JSON.stringify(context)) > CONTEXT_LIMIT)
    throw new Error('Task context exceeds 256 KB');

  const task: AgentTask = {
    id: `${event.deliveryId}-${agent.id}`,
    source: event.integration as TaskSource,
    agent: agent.id,
    flow: match.flow,
    ...route,
    permissions: match.permissions ?? settings.permissions,
    event,
    failureReply: await failureText(ctx, settings.engine ?? DEFAULT_ENGINE),
    author: integration.author?.(app.name) ?? app.name,
    definition: agent.definition,
    ...(credential ? { credential: credential.id } : {}),
    ...(requester ? { requester } : {}),
    ...(agent.files ? { files: agent.files } : {}),
    ...(agent.usage ? { usage: agent.usage } : {}),
    tools,
    connections: outsider ? [] : grants,
    ...(Object.keys(toolScopes).length ? { toolScopes } : {}),
    ...(Object.keys(context).length ? { context } : {}),
  };
  if (ctx.local && !event.repo && route.runner === 'local' && !route.runnerId)
    return local(task, fallbackText, personalToken);

  const delivered = await ctx.queue.deliver(
    ctx.organizationId,
    task,
    now(),
    { key: delivery, ttlMs: DELIVERY_TTL_MS },
    Boolean(steers),
    ctx.config.maxQueued ?? 1000,
  );
  if (delivered.taskId) {
    await converse(ctx, event, now());
    await taskConnectionSecrets(ctx, delivered.taskId, [
      ...tokens.minted,
      ...(personalToken ? [personalToken] : []),
    ]);
  }
  if (fallbackText && delivered.taskId) {
    await connectionWarnings(ctx, delivered.taskId, [fallbackText]);
  }

  return delivered;
}
