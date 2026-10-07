/** A platform event becomes a task: dedupe, installation, linked member, agent match, credential, then the queue. */
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
import { credentialFix, resolveCredential } from '../settings/credentials';
import { installationToken, resolveTokens, tokenBound } from './context';
import { chooseRunner } from '../runners';
import { sessionKey, addInbox } from './queue';
import { buildContext, threadKey } from './thread';
import { enqueueSteer, generateTaskId, loadTask, reconcileTask } from '../../core/state';
import { generateRunId } from '../../flow/runs';
import { steerTask } from '../../core/task/actions';

const PENDING_TTL_MS = 60_000;

const SETUP_MARKER = '<!-- coder:setup -->';
export const DELIVERY_TTL_MS = 24 * 60 * 60 * 1000;
const CONTEXT_LIMIT = 256 * 1024;
const LINK_PROMPT_TTL_MS = 24 * 60 * 60 * 1000;
const SETTING_KEYS = ['model', 'engine', 'effort'] as const;

const SETTINGS_HELP = [
  'Usage:',
  '• `/setup model <name>`. Sets the engine model. Also accepts `engine` and `effort`.',
  '• `/setup show`. Shows the current settings.',
].join('\n');

/** Where dispatch answers an event: its thread in public, the actor in private, and the thread's recent messages. */
export interface Replies {
  post(text: string): Promise<unknown>;
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

/** Keep only the integrations the agent declares. */
function declaredTokens(tokens: Record<string, string>, agent: Agent): Record<string, string> {
  return Object.fromEntries(
    Object.entries(tokens).filter(([id]) => id in agent.definition.integrations),
  );
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
  else if (event.chat) scopes[event.integration] = { thread: event.chat.thread.id };

  for (const [id, connection] of Object.entries(installation.connections ?? {})) {
    if (connection.kind !== 'installation') continue;

    const linked = await ctx.store.get('installation', connection.id);
    const configRepo = linked?.settings?.configRepo;
    const match = configRepo && /^([^/]+)\/([^/]+)$/.exec(configRepo);
    if (match) scopes[id] = { repo: { owner: match[1]!, name: match[2]! } };
  }

  return scopes;
}

function setupText(ctx: ServerContext, engine: string): string {
  return `${SETUP_MARKER}\nCoder is installed, but no engine is connected. [Connect ${engine}](${credentialFix(ctx, engine)}).`;
}

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
  if (
    ctx.local &&
    (await ctx.store.get('delivery', delivery).then(receipt => receipt && !receipt.pending))
  )
    return {};

  if (!ctx.local)
    return claimed(ctx, integration, app, credentials, event, installation, now, replies, delivery);

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

  // Dispatch reads only: matching, usage, history and write checks. Execution mints the task's own token.
  const eventToken = await installationToken(
    ctx,
    integration,
    installation,
    credentials,
    tokenBound(event.repo, integration.tools.presets.observe),
  );
  const resolved = await resolveTokens(ctx, installation, event, eventToken);
  const [agent, member] = await Promise.all([
    ctx.loadAgent(app, installation, event, resolved),
    ctx.auth && event.actor.id ? linkedMember(ctx, integration, event) : undefined,
  ]);
  // Someone asking the agent directly must be a linked member of this workspace.
  if (!member && ctx.auth && event.actor.id && integration.events[event.type]?.addressed)
    return effect(() => sendLink(ctx, integration, installation, event, replies, now()));

  const requester = member?.id;
  const match = matchAgent(event, agent);
  if (!match) return {};

  const steers = event.chat && match.flow === 'default' && integration.events[event.type]?.steers;
  const local = (task: AgentTask) =>
    handoff(
      ctx,
      delivery,
      event,
      now,
      async pending => {
        const saved = pending.task!;
        const started = await runLocalTask(ctx, saved, pending.taskId);
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
  const tokens = declaredTokens(resolved, agent);
  const [route, credential, toolScopes, context] = await Promise.all([
    chooseRunner(ctx, { requester, agent: agent.definition.runner }),
    resolveCredential(ctx.store, settings.engine, requester),
    frozenToolScopes(ctx, installation, event),
    buildContext(
      ctx,
      integration,
      installation,
      event,
      tokens,
      agent,
      integration.events[event.type]?.addressed && integration.history !== false
        ? replies.recent
        : undefined,
      member ?? null,
    ),
  ]);
  if (
    !credential &&
    route.runner !== 'http' &&
    !(await machineSignedIn(ctx, settings.engine ?? 'claude'))
  ) {
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
    return effect(() => replies.post(setupText(ctx, settings.engine ?? 'claude')).then(() => {}));
  }

  // Write tools need a requester who can write there, checked with the platform.
  const reads = new Set(integration.tools.presets.observe);
  const own = match.tools[event.integration] ?? [];
  if (
    member &&
    integration.auth.canWrite &&
    own.some(name => !reads.has(name)) &&
    !(await integration.auth.canWrite(event, eventToken))
  )
    match.tools[event.integration] = own.filter(name => reads.has(name));

  const tools = Object.fromEntries(
    Object.entries(match.tools)
      .filter(([id]) => id in tokens)
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
    author: integration.author?.(app.name) ?? app.name,
    definition: agent.definition,
    ...(credential ? { credential: credential.id } : {}),
    ...(requester ? { requester } : {}),
    ...(agent.files ? { files: agent.files } : {}),
    ...(agent.usage ? { usage: agent.usage } : {}),
    tools,
    ...(Object.keys(toolScopes).length ? { toolScopes } : {}),
    ...(Object.keys(context).length ? { context } : {}),
  };
  if (ctx.local && !event.repo && route.runner === 'local' && !route.runnerId) return local(task);

  return ctx.queue.deliver(
    ctx.organizationId,
    task,
    now(),
    { key: delivery, ttlMs: DELIVERY_TTL_MS },
    Boolean(steers),
    ctx.config.maxQueued ?? 1000,
  );
}
