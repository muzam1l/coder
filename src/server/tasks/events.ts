/** A platform event becomes a task: dedupe, installation, linked member, agent match, credential, then the queue. */
import { secretRows, taskConnectionSecrets } from '../connections/resolve';
import { connectionGrants } from '../connections/grants';
import { dispatchFilePrefixes } from '../agents/repo';
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
import { issueLinkToken } from '../auth/link';
import type { ServerContext } from '../context';
import { updateMetadata } from '../store';
import type { DispatchLoaded, Store, TaskStatus } from '../store/types';
import { dispatchStore } from '../store/primed';
import { machineSignedIn, runLocalTask } from './local';
import { syncLocalAgents } from '../store/local';
import { credentialFix, resolveCredential } from '../settings/credentials';
import { dispatchTokens, requesterToken, type EventTokens } from './context';
import { chooseRunner } from '../runners';
import { buildContext, conversationKey } from './thread';
import {
  conversationRecord,
  conversationState,
  everyMessageDelivered,
  describe,
  forgetUnseen,
  recordUnseen,
  rememberConversation,
  steerConversation,
  unseenAcknowledgement,
} from './conversation';
import { eventPrompt } from '../../core/prompts';
import { appendTaskLog, generateTaskId } from '../../core/state';
import { generateRunId } from '../../flow/runs';
import { connectionWarnings } from './logs';
import type { PendingDelivery } from './queue';
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

/** Public and private replies to an event. */
export interface Replies {
  post(text: string, progress?: boolean): Promise<{ id?: string; ids?: string[] } | null | void>;
  react?(emoji: string, message?: string): Promise<void>;
  /** A reply that reports a failure; Linear marks the session failed, elsewhere it is a plain reply. */
  problem(text: string): ReturnType<Replies['post']>;
  /** Resolves without posting where the platform has no private messages. */
  whisper(text: string): Promise<unknown>;
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

/** Whether the actor may write where the event happened, as the platform says; `null` when the check failed, which counts as no, and a platform without one answers nothing. */
async function writeCheck(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  tokens: EventTokens,
): Promise<boolean | null | undefined> {
  if (!integration.auth.canWrite) return undefined;
  const token = await (await tokens(event.integration))!.token();
  return integration.auth.canWrite(event, token!, ctx.fetch).catch((error: unknown) => {
    console.error(
      `coder server: ${integration.id} write check failed for ${event.appId} event ${event.deliveryId}`,
      error,
    );

    return null;
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

/** The integrations the agent declares that the event can reach, found without minting. */
async function reachable(tokens: EventTokens, agent: Agent): Promise<Set<string>> {
  const ids = Object.keys(agent.definition.integrations);
  const found = await Promise.all(ids.map(id => tokens(id)));

  return new Set(ids.filter((_, index) => found[index]));
}

async function frozenToolScopes(
  installation: Installation,
  event: AgentEvent,
  tokens: EventTokens,
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

    const linked = (await tokens(id))?.record;
    const configRepo = linked?.settings?.configRepo;
    const match = configRepo && /^([^/]+)\/([^/]+)$/.exec(configRepo);
    if (match) scopes[id] = { repo: { owner: match[1]!, name: match[2]! } };
  }

  return scopes;
}

async function setupText(ctx: ServerContext, engine: string, slug?: string): Promise<string> {
  return `No model is configured yet. If you have access to it, [add one here](${await credentialFix(ctx, engine, slug)}).`;
}

/** What the thread gets when a run fails without an answer. */
async function failureText(ctx: ServerContext, engine: string, slug?: string): Promise<string> {
  return `There was a problem with your connected model. If you have access to it, [check it here](${await credentialFix(ctx, engine, slug)}).`;
}

/** The task's dashboard page, linked when the agent returns no reply where one is due. */
async function taskPage(ctx: ServerContext, id: string, slug: string): Promise<string | undefined> {
  const base = ctx.config.publicUrl?.replace(/\/$/, '');

  return base ? `${base}${dashPath(slug, `/tasks/${id}`)}` : undefined;
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
  if (!installation) return {};
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
      files: dispatchFilePrefixes(ctx.integrations, installation, event),
    };
    const { claimed: mine, loaded } = await ctx.store.dispatchState(input);
    if (!mine) return {};
    const primed = loaded ? { ...ctx, store: dispatchStore(ctx.store, loaded, input) } : ctx;
    if ((await primed.store.get('agent', app.agent))?.settings?.disabled) {
      await ctx.store.updateDelivery(delivery, owner, undefined);
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

  if ((await ctx.store.get('agent', app.agent))?.settings?.disabled) return {};
  if (await ctx.store.get('delivery', delivery).then(receipt => receipt && !receipt.pending))
    return {};

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
      ? await taskPage(ctx, taskId, await (slug?.() ?? organizationSlug(ctx)))
      : undefined;
  let pending: PendingHandoff = {
    event,
    ...(task ? { task: { ...task, ...(taskUrl ? { taskUrl } : {}) }, taskId } : {}),
  };
  if (ctx.local && !event.repo) {
    const receipt = await ctx.store.get<{ pending?: PendingHandoff }>('delivery', delivery);
    if (receipt && !receipt.pending) return {};
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
    ctx.loadAgent(app, installation, event, tokens, claim?.loaded),
    ctx.auth && event.actor.id ? linkedMember(ctx, integration, event) : undefined,
  ]);
  // Someone asking the agent directly is a linked member of this workspace, or someone the platform lets write there.
  const addressed = Boolean(
    ctx.auth && event.actor.id && integration.events[event.type]?.addressed,
  );
  // A failed check drops the event and says so, so every prompt gets an answer.
  const unchecked = () =>
    effect(async () => {
      await replies.problem('Coder could not check your access to this conversation.');
    });
  const trusted =
    addressed && !member ? await writeCheck(ctx, integration, event, tokens) : undefined;
  if (trusted === null) return unchecked();
  if (addressed && !member && !trusted)
    return effect(() => sendLink(ctx, integration, installation, event, replies, now()));

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
    return {};
  }

  const local = (task: AgentTask, fallbackText?: string, personal?: string) =>
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
        await taskConnectionSecrets(ctx, started.task.id, [
          ...tokens.minted,
          ...(personal ? [personal] : []),
        ]);
        if (fallbackText) {
          appendTaskLog(ctx.local!.cwd, started.task.id, { kind: 'status', message: fallbackText });
        }
      },
      task,
      slug,
    );

  // A redelivery resumes its own interrupted handoff, never steers the task it made.
  if (ctx.local && !event.repo) {
    const receipt = await ctx.store.get<{ pending?: PendingHandoff }>('delivery', delivery);
    if (receipt?.pending?.task) {
      const saved = receipt.pending.task;
      if (saved.agent !== agent.id || saved.flow !== match.flow) return {};
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
  if (current) {
    // The same gate as a new event: a linked member or a platform writer steers; write tools need the write check.
    const reads = new Set(integration.tools.presets.observe);
    const writes = (current.task.tools[event.integration] ?? []).some(name => !reads.has(name));
    const allowed =
      trusted ||
      (Boolean(member) && !writes) ||
      (await writeCheck(ctx, integration, event, tokens));
    if (allowed === null) return unchecked();

    return allowed !== false
      ? effect(() => steerConversation(ctx, current, described, user, now, state))
      : {};
  }

  // A 1:1 conversation runs on the requester's own credentials; a shared one, where anyone may steer, on the workspace's only.
  const personal = !talk || described.chat?.thread.isDM === true;
  const requester = personal ? member?.id : undefined;
  const actAs = personal ? match.actAs : undefined;
  const settings = effectiveSettings(agent);
  const declared = await reachable(tokens, agent);
  const [route, credential, toolScopes, context, grants, personalToken] = await Promise.all([
    chooseRunner(ctx, { requester, agent: agent.definition.runner }),
    resolveCredential(ctx.store, settings.engine, requester),
    frozenToolScopes(installation, event, tokens),
    buildContext(
      ctx,
      integration,
      installation,
      event,
      async id => (declared.has(id) ? tokens(id) : undefined),
      agent,
      member ?? null,
    ),
    connectionGrants(
      ctx,
      requester,
      agent.usage?.connections,
      Boolean(ctx.auth && !member && !trusted),
    ),
    actAs === 'requester'
      ? requesterToken(ctx, integration, event, credentials).catch(() => undefined)
      : undefined,
  ]);
  if (!credential && route.runner !== 'http' && !(await machineSignedIn(ctx, settings.engine))) {
    const spoken = described.mustReply ?? integration.events[event.type]?.on === 'mention';
    if (!spoken) return {};
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
        await replies.problem(
          await setupText(ctx, settings.engine ?? DEFAULT_ENGINE, await slug()),
        );
      } catch (error) {
        if (!integration.answersEveryPrompt) await ctx.store.updateDelivery(key, owner, undefined);
        throw error;
      }
    });
  }

  const reads = new Set(integration.tools.presets.observe);
  const own = match.tools[event.integration] ?? [];
  const fallback = !!ctx.auth && actAs === 'requester' && !personalToken;
  const writes = own.some(name => !reads.has(name));
  const check = ctx.auth
    ? member && (writes || fallback)
    : writes ||
      grants.length > 0 ||
      Object.entries(match.tools).some(
        ([id, names]) => id !== event.integration && declared.has(id) && names.length,
      );
  const checked =
    trusted ?? (check ? await writeCheck(ctx, integration, event, tokens) : undefined);
  const canWrite = checked === null ? false : checked;
  const outsider = outsiderEvent(ctx, member || trusted, canWrite);
  const fallbackText = fallback
    ? `Acting as the app because the requester's account has no usable ${integration.name} token. ${canWrite === true && !outsider ? 'The platform write check passed.' : 'Only reads are allowed.'} [Connect your account](${ctx.config.publicUrl?.replace(/\/$/, '') ?? ''}${dashPath(await slug(), '/settings/connections')}).`
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

  const id = `${event.deliveryId}-${agent.id}`;
  const taskUrl = await taskPage(ctx, id, await slug());
  const task: AgentTask = {
    id,
    source: event.integration as TaskSource,
    agent: agent.id,
    flow: match.flow,
    ...route,
    permissions: match.permissions ?? settings.permissions,
    event: described,
    failureReply: await failureText(ctx, settings.engine ?? DEFAULT_ENGINE, await slug()),
    ...(taskUrl ? { taskUrl } : {}),
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

  // The queue steers an active task of the conversation itself, so two first messages at once make one task; the task's conversation, acknowledged messages and secrets land with it.
  const admitted = now();
  const delivered = await ctx.queue.deliver(
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
      secrets: secretRows(ctx, id, [...tokens.minted, ...(personalToken ? [personalToken] : [])]),
    },
  );
  if (fallbackText && delivered.taskId) {
    await connectionWarnings(ctx, delivered.taskId, [fallbackText]);
  }

  return delivered;
}
