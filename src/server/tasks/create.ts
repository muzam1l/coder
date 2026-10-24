import { connectionGrants, connectNotice } from '../connections/records';
import { narrowConnections } from '../../core/connections';
import { checkFolder } from '../settings/folders';
import { repositorySnapshot } from '../agents/connections';
import { getApps } from '../store';
import { dashPath, organizationSlug, sessionSlug } from '../auth/members';
/** Tasks started from the dashboard, the CLI, or a schedule: a prompt or a flow, optionally on a workspace repo. */
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { agentAccess, declaredTools, effectiveSettings, matchAgent } from '../../agent/definition';
import { defaultAgent } from '../../agent/load';
import type { Integration } from '../../integrations/types';
import type {
  Agent,
  AgentApp,
  AgentEvent,
  AgentTask,
  Installation,
  TaskSource,
  TaskUsage,
} from '../../agent/types';
import type { TaskTurn } from '../../client/types';
import type { AgentRecord, TaskStatus } from '../store/types';
import { ACCESS, strictestAccess, type Access } from '../../core/config';
import { agentWithVersion, ensureBuiltinAgents, toAgent } from '../agents/records';
import type { ServerContext } from '../context';
import { turnStarter, type TaskPrincipal } from './access';
import { syncLocalAgents } from '../store/local';
import { runLocalTask } from './local';
import { credentialFix, failureText, modelAttempts, resolveModels } from '../settings/credentials';
import { decryptSecret } from '../store/secrets';
import { dispatchTokens, installationToken } from './context';
import { chooseRunner, visibleRunner } from '../runners/select';
import {
  CoderError,
  ignoredAddDirs,
  resolveAddDirs,
  resolveTaskOptions,
} from '../../core/dispatch';
import { taskWarnings } from './logs';
import { effectiveConfig, shownConfig } from '../settings/config';

export interface NewTask {
  cwd?: string;
  outputSchema?: object;
  prompt?: string;
  /** `owner/name`, reached through one of the workspace's installs. */
  repo?: string;
  /** A pull request of `repo`, checked out at its head. */
  pr?: number;
  agent?: string;
  flow?: string;
  args?: Record<string, unknown>;
  model?: string;
  access?: Access;
  runner?: string;
  mcp?: string[];
  /** Narrows the connections the task is granted. */
  connections?: string[];
  name?: string;
  /** Standing instructions appended to the task's system prompt. */
  appendSystem?: string;
  /** Absolute directories beyond cwd, for runners on the caller's machine. */
  addDirs?: string[];
}

/** A request the server refuses; `fix` is the one-click link that resolves it. */
export class TaskInputError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly fix?: string,
  ) {
    super(message);
  }
}

/** Refuses tasks for an agent disabled in this workspace. */
export function assertEnabled(ctx: ServerContext, slug: string, record?: AgentRecord): void {
  if (record?.problems?.length) throw new TaskInputError(record.problems.join('\n'), 409);
  if (!record?.settings?.disabled) return;
  throw new TaskInputError(
    `Agent "${slug}" is disabled in this workspace. Enable it in its settings to start tasks.`,
    409,
    `${ctx.config.publicUrl?.replace(/\/$/, '') ?? ''}${dashPath(sessionSlug(ctx), `/agents/${encodeURIComponent(slug)}/settings`)}`,
  );
}

export function taskCwd(ctx: ServerContext, input: { cwd?: string }): string | undefined {
  if (input.cwd === undefined) return undefined;
  if (!ctx.local) throw new TaskInputError('cwd is available on a local server only');
  const checked = checkFolder(input.cwd);
  if (!checked.ok) throw new TaskInputError(checked.detail);
  return checked.folder.path;
}

/** A child keeps its agent, and at most its parent's access and connections. */
function childTask(parent: TaskPrincipal, input: NewTask): NewTask {
  if (input.agent && input.agent !== parent.agent)
    throw new TaskInputError('A task starts children of its own agent only.', 403);
  const beyond = (['cwd', 'flow', 'args', 'mcp', 'addDirs'] as const).filter(
    key => input[key] !== undefined,
  );
  if (beyond.length)
    throw new TaskInputError(
      `A child task takes no ${beyond.join(', ')}; give it the text to work on.`,
      403,
    );

  return {
    ...input,
    agent: parent.agent,
    access: strictestAccess(input.access, parent.access),
    connections: narrowConnections(parent.connections, input.connections),
  };
}

export const MAX_PROMPT_CHARS = 64 * 1024;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

/** Why an option a task no longer takes is refused, naming the ones in its place. */
export function unknownOption(input: unknown, keys: string[]): string | undefined {
  const key = keys.find(key => input instanceof Object && key in input);
  if (key)
    return `Unknown task option "${key}". Give model as <name>[/<effort>] or <engine>/<model>[/<effort>], and access as read-only or auto.`;
}

export function check(input: NewTask): void {
  const unknown = unknownOption(input, ['engine', 'effort', 'permissions', 'background']);
  if (unknown) throw new TaskInputError(unknown);
  const flow = input.flow ?? 'default';
  if (!SLUG.test(flow)) throw new TaskInputError(`Invalid flow "${flow}"`);
  if (input.prompt !== undefined && typeof input.prompt !== 'string')
    throw new TaskInputError('prompt must be text');
  if (flow === 'default' && !input.prompt?.trim()) throw new TaskInputError('prompt is required');
  if ((input.prompt?.length ?? 0) > MAX_PROMPT_CHARS)
    throw new TaskInputError('prompt is longer than 64 KB');
  if (input.repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(input.repo))
    throw new TaskInputError('repo must be owner/name');
  if (input.pr !== undefined && (!Number.isInteger(input.pr) || input.pr < 1 || !input.repo))
    throw new TaskInputError('pr needs a repo and a pull request number');
  if (input.access !== undefined && !ACCESS.includes(input.access))
    throw new TaskInputError(`Unknown access "${input.access}". Use read-only or auto.`);
  if (
    input.mcp !== undefined &&
    (!Array.isArray(input.mcp) || !input.mcp.every(name => SLUG.test(name)))
  )
    throw new TaskInputError('mcp must list server names');
  if (
    input.connections !== undefined &&
    (!Array.isArray(input.connections) ||
      !input.connections.every(id => typeof id === 'string' && id.length > 0))
  )
    throw new TaskInputError('connections must list connection ids');
  if (
    input.outputSchema !== undefined &&
    (!input.outputSchema ||
      typeof input.outputSchema !== 'object' ||
      Array.isArray(input.outputSchema))
  )
    throw new TaskInputError('outputSchema must be an object');
  if (input.args !== undefined && (typeof input.args !== 'object' || Array.isArray(input.args)))
    throw new TaskInputError('args must be an object');
  if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length > 200))
    throw new TaskInputError('name must be text of at most 200 characters');
  if (
    input.appendSystem !== undefined &&
    (typeof input.appendSystem !== 'string' || input.appendSystem.length > MAX_PROMPT_CHARS)
  )
    throw new TaskInputError('appendSystem must be text of at most 64 KB');
  if (
    input.addDirs !== undefined &&
    (!Array.isArray(input.addDirs) ||
      !input.addDirs.every(dir => typeof dir === 'string' && path.isAbsolute(dir)))
  )
    throw new TaskInputError('addDirs must list absolute paths');
}

/** The first install of the workspace that reaches `repo`, with a token for it; a task reaches only its own agent's installs. */
export async function repoAccess(
  ctx: ServerContext,
  repo: string,
): Promise<{ integration: Integration; installation: Installation; app: AgentApp; token: string }> {
  const installations = (await ctx.store.list('installation'))
    .filter(({ value }) => !value.deletedAt && ctx.integrations[value.integration]?.repos)
    .sort(
      (a, b) =>
        Number(b.value.repos?.includes(repo) ?? false) -
        Number(a.value.repos?.includes(repo) ?? false),
    );
  const apps = new Map(
    (
      await getApps(
        ctx.store,
        installations.map(({ value }) => value.app),
      )
    ).map(({ id, value }) => [id, value]),
  );

  const agent = ctx.taskPrincipal?.agent;
  for (const { value: installation } of installations) {
    const integration = ctx.integrations[installation.integration];
    if (installation.deletedAt || !integration?.repos) continue;
    const app = apps.get(installation.app);
    if (!app || (agent && app.agent !== agent)) continue;
    try {
      const token = await installationToken(
        ctx,
        integration,
        installation,
        decryptSecret(ctx.config, app.credentials),
      );
      const current = installation.repos?.includes(repo)
        ? installation
        : await repositorySnapshot(ctx, installation, false, { app, token, repo });
      if (!current?.repos?.includes(repo)) continue;

      return { integration, installation: current, app, token };
    } catch (error) {
      console.error(`coder server: repository token for ${installation.id} failed`, error);
    }
  }
  if (agent) throw new TaskInputError(`No install of agent "${agent}" reaches ${repo}`, 403);
  throw new TaskInputError(`No install in this workspace reaches ${repo}`, 404);
}

/** The repo as a task event, and the handle the task posts as there. */
async function repoEvent(
  ctx: ServerContext,
  id: string,
  input: NewTask,
  requestedBy: string | undefined,
): Promise<{ event: AgentEvent; author: string }> {
  const repo = input.repo!;
  const { integration, installation, app, token } = await repoAccess(ctx, repo);
  const found = await integration.repos!.get(repo, token);
  const event: AgentEvent = {
    integration: integration.id,
    type: input.pr ? 'pull_request' : 'task',
    appId: app.id,
    installationId: installation.id.slice(app.id.length + 1),
    deliveryId: id,
    actor: { id: requestedBy ?? '' },
    text: input.prompt ?? '',
    ...(input.pr ? { chat: { thread: integration.repos!.pullRequestThread(repo, input.pr) } } : {}),
    repo: found,
  };
  return { event, author: integration.author?.(app.name) ?? app.name };
}

/** The engine, model and effort a model spec asks for; undefined when nothing was asked. */
async function taskPick(ctx: ServerContext, model: string | undefined): Promise<TaskUsage['pick']> {
  if (!model) return undefined;
  try {
    const selected = resolveTaskOptions({ model }, effectiveConfig(ctx, await shownConfig(ctx)));
    return {
      engine: selected.engine,
      model: selected.model ?? undefined,
      ...(selected.effort ? { effort: selected.effort } : {}),
    };
  } catch (error) {
    throw new TaskInputError((error as Error).message);
  }
}

/** Queue a task, whose next kick starts it on its runner; a local server runs it at once. */
export async function createTask(
  ctx: ServerContext,
  source: TaskSource,
  input: NewTask,
): Promise<TaskStatus> {
  const parent = ctx.taskPrincipal;
  const parentTask = parent && (await ctx.store.get('task', parent.task))?.task;
  if (parent) input = childTask(parent, input);
  check(input);
  const cwd = taskCwd(ctx, input);
  const now = (ctx.now ?? Date.now)();
  // A child runs on its parent's turn's account.
  const requestedBy = parentTask ? turnStarter(parentTask) : ctx.session?.user.id;
  const slug = input.agent || defaultAgent();
  if (!slug) throw new TaskInputError('Name an agent: this server has no default agent.');
  if (slug === defaultAgent()) await ensureBuiltinAgents(ctx, now);
  if (ctx.local) await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations);
  const { record, version } = await agentWithVersion(ctx.store, slug);
  const chosen = await chooseRunner(ctx, {
    requestedBy,
    runner: input.runner,
    agent: version?.definition.runner,
  }).catch((error: Error) => {
    throw new TaskInputError(error.message);
  });
  if (!record || !version) throw new TaskInputError(`No agent "${slug}"`, 404);
  assertEnabled(ctx, slug, record);
  const pick = (await taskPick(ctx, input.model)) ?? parentTask?.usage?.pick;
  const agent = toAgent(record, version, pick, ctx.integrations);
  const { models, first } = await resolveModels(ctx, effectiveSettings(agent), requestedBy);
  const attempts = modelAttempts(models, chosen.runner === 'http');
  if (!attempts.length) throw await noCredential(ctx, models, first.engine);

  const id = `${now.toString(36)}-${randomBytes(4).toString('hex')}`;
  const repo = input.repo ? await repoEvent(ctx, id, input, requestedBy) : undefined;
  const ignored = input.addDirs?.length ? ignoredAddDirs(chosen.runner) : undefined;
  // A local server shares the caller's machine, so missing directories fail here rather than on the runner.
  if (ctx.local && input.addDirs?.length && !ignored)
    try {
      resolveAddDirs(cwd ?? ctx.local.cwd, input.addDirs);
    } catch (error) {
      if (error instanceof CoderError) throw new TaskInputError(error.message);
      throw error;
    }
  const task: AgentTask = {
    id,
    ...(input.name ? { name: input.name } : {}),
    source,
    agent: agent.id,
    flow: input.flow ?? 'default',
    ...chosen,
    access: agentAccess(agent, input.access),
    ...(repo ? { event: repo.event, author: repo.author } : {}),
    ...(cwd && !repo ? { cwd } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.args ? { args: input.args } : {}),
    ...(input.mcp?.length ? { mcp: input.mcp } : {}),
    ...(input.appendSystem ? { appendSystem: input.appendSystem } : {}),
    ...(input.addDirs?.length && !ignored ? { addDirs: input.addDirs } : {}),
    definition: agent.definition,
    models: attempts,
    ...(requestedBy ? { requestedBy } : {}),
    ...(parent
      ? {
          parent: parent.task,
          audience: parent.audience,
          ...(parent.space ? { space: parent.space } : {}),
        }
      : {}),
    ...(agent.files ? { files: agent.files } : {}),
    usage: { ...agent.usage, ...(pick ? { pick } : {}) },
    tools: parent ? declaredTools(agent, input.access) : {},
    connections: await connectionGrants(
      ctx,
      requestedBy,
      narrowConnections(agent.usage?.connections, input.connections),
    ),
    ...(ctx.session || input.outputSchema
      ? {
          context: {
            ...(ctx.session
              ? { user: { name: ctx.session.user.name, email: ctx.session.user.email } }
              : {}),
            ...(input.outputSchema ? { outputSchema: input.outputSchema } : {}),
          },
        }
      : {}),
  };
  if (ctx.local && chosen.runner === 'local' && !chosen.runnerId) return runLocalTask(ctx, task);
  await ctx.queue.enqueue(ctx.organizationId, task, now, undefined, ctx.config.maxQueued ?? 1000);
  if (ignored) await taskWarnings(ctx, id, [ignored]);
  return { task, status: 'queued', attempts: 0, createdAt: now, updatedAt: now };
}

/** Persisted turns and the task's current run. */
export function taskTurns(status: TaskStatus): TaskTurn[] {
  if (status.turns) return status.turns;
  const history = status.task.context?.turns ?? [];
  return [
    ...history,
    {
      prompt: status.task.prompt ?? status.task.event?.text ?? status.task.name ?? '',
      result: status.result,
      error: status.error,
      finishedAt: status.finishedAt,
      ...(['completed', 'failed', 'cancelled'].includes(status.status)
        ? { logSeq: status.logSeq }
        : {}),
    },
  ];
}

/** Refuses a turn no listed model runs: in a starter's thread, another member's turn without a workspace credential points at the starter. */
async function noCredential(
  ctx: ServerContext,
  models: Array<{ model: string }>,
  engine: string,
  task?: Pick<AgentTask, 'requestedBy' | 'event' | 'source'>,
): Promise<TaskInputError> {
  const fix = await credentialFix(ctx, engine);
  const actor = task?.event?.actor;
  if (task?.requestedBy && actor && task.source === task.event?.integration) {
    const starter = `@${actor.login ?? actor.id}`;

    return new TaskInputError(
      `This thread runs on ${starter}'s subscription. Ask ${starter}, or an admin can add a workspace key: [Add a key](${fix})`,
      409,
      fix,
    );
  }

  return new TaskInputError(
    `No credential runs ${models.map(run => run.model).join(' or ')}`,
    409,
    fix,
  );
}

/** The runner a turn runs on: its starter's own turns may use their personal runner, anyone else's the workspace's; a dashboard task keeps its runner while the turn may use it. */
async function turnRunner(
  ctx: ServerContext,
  task: AgentTask,
  starter: string | undefined,
): Promise<Pick<AgentTask, 'runner' | 'runnerId'>> {
  const stored = task.runnerId ? await ctx.store.get('runner', task.runnerId) : undefined;
  if (task.source !== task.event?.integration && (!stored || visibleRunner(stored, starter)))
    return { runner: task.runner, ...(task.runnerId ? { runnerId: task.runnerId } : {}) };
  const chosen = await chooseRunner(ctx, { requestedBy: starter, agent: task.definition.runner });

  return { runnerId: undefined, ...chosen };
}

/** The agent as it is now, for a task's next turn: definition, usage, files and tools by the current access mode, the models the turn's asker may run it on, and its runner. A disabled agent fails the turn; one the store no longer holds keeps the task's snapshot. */
export async function refreshedTask(
  ctx: ServerContext,
  task: AgentTask,
): Promise<
  Partial<
    Pick<
      AgentTask,
      | 'definition'
      | 'usage'
      | 'tools'
      | 'files'
      | 'access'
      | 'models'
      | 'runner'
      | 'runnerId'
      | 'failureReply'
      | 'notice'
    >
  >
> {
  const pick = task.usage?.pick;
  const event = task.event;
  let agent: Agent | undefined;
  if (event) {
    const [app, installation] = await Promise.all([
      ctx.store.get('app', event.appId),
      ctx.store.get('installation', `${event.appId}:${event.installationId}`),
    ]);
    if (!app || !installation || installation.deletedAt || !ctx.loadAgent) return {};
    assertEnabled(ctx, task.agent, await ctx.store.get('agent', task.agent));
    const integration = ctx.integrations[event.integration]!;
    const credentials = decryptSecret(ctx.config, app.credentials);
    agent = await ctx.loadAgent(
      app,
      installation,
      event,
      dispatchTokens(ctx, integration, installation, event, credentials),
    );
  } else {
    if (task.agent === defaultAgent()) await ensureBuiltinAgents(ctx, (ctx.now ?? Date.now)());
    const { record, version } = await agentWithVersion(ctx.store, task.agent);
    assertEnabled(ctx, task.agent, record);
    if (!record || !version) return {};
    agent = toAgent(record, version, pick, ctx.integrations);
  }
  const match = event && matchAgent(event, agent, task.access);
  const usage = { ...agent.usage, ...pick };
  const starter = turnStarter(task);
  const conversation = event && task.source === event.integration ? event : undefined;
  const [route, { models, first }, slug] = await Promise.all([
    turnRunner(ctx, task, starter),
    resolveModels(ctx, effectiveSettings({ ...agent, usage }), starter),
    conversation && organizationSlug(ctx),
  ]);
  const attempts = modelAttempts(models, route.runner === 'http');
  // The turn's asker, when the account names no member, hears how it could run on a member's own subscription.
  const actor = conversation?.chat?.message?.author.userId || conversation?.actor.id;
  const connect =
    conversation && actor && !task.context?.asker
      ? await connectNotice(ctx, ctx.integrations[conversation.integration]!, {
          task: task.id,
          actor,
          models,
          attempts,
          ...(slug ? { slug } : {}),
        })
      : undefined;
  if (!attempts.length)
    throw connect
      ? new TaskInputError(connect.failure, 409, connect.url)
      : await noCredential(ctx, models, first.engine, task);

  return {
    definition: agent.definition,
    usage: { ...usage, ...(pick ? { pick } : {}) },
    models: attempts,
    ...route,
    tools: match?.tools ?? declaredTools(agent, task.access),
    ...(agent.files ? { files: agent.files } : {}),
    access: agentAccess(agent, task.access),
    ...(conversation
      ? {
          failureReply: connect?.failure ?? (await failureText(ctx, first.engine, slug)),
          notice: connect?.notice,
        }
      : {}),
  };
}

/** Ask a finished task something new: the same task runs again with the earlier turns as its thread. */
/** What a resumed turn may change: its model, and access only downward. */
interface TurnOverrides {
  model?: string;
  access?: Access;
}

export async function continueTask(
  ctx: ServerContext,
  status: TaskStatus,
  text: string,
  outputSchema?: object,
  overrides: TurnOverrides = {},
): Promise<TaskStatus> {
  if (
    outputSchema !== undefined &&
    (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema))
  )
    throw new TaskInputError('outputSchema must be an object');
  if (!text.trim()) throw new TaskInputError('text is required');
  if (text.length > MAX_PROMPT_CHARS) throw new TaskInputError('text is longer than 64 KB');
  const { model, access } = overrides;
  if (model !== undefined && (typeof model !== 'string' || !model.trim()))
    throw new TaskInputError('model must be text');
  if (access !== undefined && !ACCESS.includes(access))
    throw new TaskInputError(`Unknown access "${access}". Use read-only or auto.`);
  const now = (ctx.now ?? Date.now)();
  const earlier = status.task.context?.messages ?? [];
  const at = String(status.finishedAt ?? now);
  const messages = [
    ...earlier,
    {
      user: 'user',
      text: status.task.prompt ?? status.task.event?.text ?? '',
      ts: String(status.createdAt),
    },
    { user: 'agent', text: status.result?.output ?? status.error ?? '', ts: at },
  ].slice(-20);
  const context = status.task.context ?? {};
  const turns = taskTurns(status);
  turns.at(-1)!.finishedAt ??= now;
  const pick = model ? await taskPick(ctx, model) : status.task.usage?.pick;
  const current = await refreshedTask(ctx, {
    ...status.task,
    usage: { ...status.task.usage, pick },
  });
  const next: TaskStatus = {
    task: {
      ...status.task,
      ...current,
      prompt: text,
      access: strictestAccess(access, current.access ?? status.task.access),
      context: {
        ...context,
        ...(outputSchema ? { outputSchema } : {}),
        messages,
        turns,
      },
    },
    status: 'queued',
    attempts: 0,
    generation: (status.generation ?? 0) + 1,
    ...(status.logSeq !== undefined ? { logSeq: status.logSeq } : {}),
    ...(status.logBytes !== undefined ? { logBytes: status.logBytes } : {}),
    createdAt: status.createdAt,
    updatedAt: now,
  };
  if (
    !(await ctx.queue.continueTask(ctx.organizationId, status.task.id, next.task, now, {
      attempts: status.attempts,
      tokenHash: status.tokenHash ?? null,
      generation: status.generation ?? 0,
    }))
  )
    throw new TaskInputError('Task is already active', 409);
  return next;
}
