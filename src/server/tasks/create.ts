import { connectionGrants } from '../connections/grants';
import { narrowConnections } from '../../core/connections';
import { checkFolder } from '../settings/folders';
import { repositorySnapshot } from '../agents/connections';
import { getApps } from '../store';
import { dashPath, sessionSlug } from '../auth/account';
/** Tasks started from the dashboard, the CLI, or a schedule: a prompt or a flow, optionally on a workspace repo. */
import { randomBytes } from 'node:crypto';

import { effectiveSettings } from '../../agent/definition';
import { defaultAgent } from '../../agent/load';
import type { Integration } from '../../integrations/types';
import type {
  AgentApp,
  AgentEvent,
  AgentTask,
  AgentUsage,
  Installation,
  TaskSource,
} from '../../agent/types';
import type { TaskTurn } from '../../client/types';
import type { AgentRecord, TaskStatus } from '../store/types';
import { PERMISSION_MODES, type Permission } from '../../core/config';
import { agentWithVersion, ensureBuiltinAgents, toAgent } from '../agents/records';
import type { ServerContext } from '../context';
import { syncLocalAgents } from '../store/local';
import { runLocalTask } from './local';
import { credentialFix, resolveEngine } from '../settings/credentials';
import { decryptSecret } from '../store/secrets';
import { installationToken } from './context';
import { chooseRunner } from '../runners';

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
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  runner?: string;
  mcp?: string[];
  /** Narrows the connections the task is granted. */
  connections?: string[];
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

export const MAX_PROMPT_CHARS = 64 * 1024;
const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;
const ENGINES = new Set(['claude', 'codex', 'custom']);
const EFFORTS = new Set(['low', 'medium', 'high']);

export function check(input: NewTask): void {
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
  if (input.engine !== undefined && !ENGINES.has(input.engine))
    throw new TaskInputError(`Unknown engine "${input.engine}"`);
  if (input.effort !== undefined && !EFFORTS.has(input.effort))
    throw new TaskInputError(`Unknown effort "${input.effort}"`);
  if (input.permissions !== undefined && !(input.permissions in PERMISSION_MODES))
    throw new TaskInputError(`Unknown permissions "${input.permissions}"`);
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
}

/** The first install of the workspace that reaches `repo`, with a token for it. */
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

  for (const { value: installation } of installations) {
    const integration = ctx.integrations[installation.integration];
    if (installation.deletedAt || !integration?.repos) continue;
    const app = apps.get(installation.app);
    if (!app) continue;
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
  throw new TaskInputError(`No install in this workspace reaches ${repo}`, 404);
}

/** The repo as a task event, and the handle the task posts as there. */
async function repoEvent(
  ctx: ServerContext,
  id: string,
  input: NewTask,
  requester: string | undefined,
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
    actor: { id: requester ?? '' },
    text: input.prompt ?? '',
    ...(input.pr ? { chat: { thread: integration.repos!.pullRequestThread(repo, input.pr) } } : {}),
    repo: input.pr ? { ...found, ref: `refs/pull/${input.pr}/head` } : found,
  };
  return { event, author: integration.author?.(app.name) ?? app.name };
}

/** Queue a task, whose next kick starts it on its runner; a local server runs it at once. */
export async function createTask(
  ctx: ServerContext,
  source: TaskSource,
  input: NewTask,
): Promise<TaskStatus> {
  check(input);
  const cwd = taskCwd(ctx, input);
  const now = (ctx.now ?? Date.now)();
  const requester = ctx.session?.user.id;
  const slug = input.agent || defaultAgent();
  if (!slug) throw new TaskInputError('Name an agent: this server has no default agent.');
  if (slug === defaultAgent()) await ensureBuiltinAgents(ctx, now);
  if (ctx.local) await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations);
  const { record, version } = await agentWithVersion(ctx.store, slug);
  const chosen = await chooseRunner(ctx, {
    requester,
    runner: input.runner,
    agent: version?.definition.runner,
  }).catch((error: Error) => {
    throw new TaskInputError(error.message);
  });
  if (!record || !version) throw new TaskInputError(`No agent "${slug}"`, 404);
  assertEnabled(ctx, slug, record);
  const usage: AgentUsage = {
    ...(input.engine ? { engine: input.engine } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort as AgentUsage['effort'] } : {}),
    ...(input.permissions ? { permissions: input.permissions as Permission } : {}),
  };
  const agent = toAgent(record, version, usage, ctx.integrations);
  const settings = effectiveSettings(agent);

  const { engine, credential, usable, chain, credentials } = await resolveEngine(
    ctx,
    settings,
    requester,
  );
  if (!usable && chosen.runner !== 'http')
    throw new TaskInputError(
      `No ${engine} credential is connected`,
      409,
      await credentialFix(ctx, engine),
    );

  const id = `${now.toString(36)}-${randomBytes(4).toString('hex')}`;
  const repo = input.repo ? await repoEvent(ctx, id, input, requester) : undefined;
  const task: AgentTask = {
    id,
    source,
    agent: agent.id,
    flow: input.flow ?? 'default',
    ...chosen,
    permissions: settings.permissions,
    ...(repo ? { event: repo.event, author: repo.author } : {}),
    ...(cwd && !repo ? { cwd } : {}),
    ...(input.prompt ? { prompt: input.prompt } : {}),
    ...(input.args ? { args: input.args } : {}),
    ...(input.mcp?.length ? { mcp: input.mcp } : {}),
    definition: agent.definition,
    engineChain: chain,
    engineCredentials: credentials,
    ...(credential ? { credential } : {}),
    ...(requester ? { requester } : {}),
    ...(agent.files ? { files: agent.files } : {}),
    usage: { ...agent.usage, engine },
    tools: {},
    connections: await connectionGrants(
      ctx,
      requester,
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

/** Ask a finished task something new: the same task runs again with the earlier turns as its thread. */
/** What a resumed turn may change: model and effort, and permissions only downward. */
export interface TurnOverrides {
  model?: string;
  effort?: string;
  permissions?: string;
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
  const { model, effort, permissions } = overrides;
  if (model !== undefined && (typeof model !== 'string' || !model.trim()))
    throw new TaskInputError('model must be text');
  if (effort !== undefined && !EFFORTS.has(effort))
    throw new TaskInputError(`Unknown effort "${effort}"`);
  if (permissions !== undefined && !(permissions in PERMISSION_MODES))
    throw new TaskInputError(`Unknown permissions "${permissions}"`);
  const rank = (mode?: string) => Object.keys(PERMISSION_MODES).indexOf(mode ?? 'auto');
  if (permissions !== undefined && rank(permissions) > rank(status.task.permissions))
    throw new TaskInputError(
      `permissions can only be lowered on a resumed task (it runs ${status.task.permissions ?? 'auto'})`,
    );
  if (ctx.session && status.task.requester && status.task.requester !== ctx.session.user.id)
    throw new TaskInputError('Only the member who asked can continue this task', 403);
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
  const next: TaskStatus = {
    task: {
      ...status.task,
      prompt: text,
      ...(model || effort
        ? {
            usage: {
              ...status.task.usage,
              ...(model ? { model } : {}),
              ...(effort ? { effort: effort as AgentUsage['effort'] } : {}),
            },
          }
        : {}),
      ...(permissions ? { permissions: permissions as Permission } : {}),
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
