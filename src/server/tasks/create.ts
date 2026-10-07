import { checkFolder } from '../settings/folders';
import { getApps } from '../store';
/** Tasks started from the dashboard, the CLI, or a schedule: a prompt or a flow, optionally on a workspace repo. */
import { randomBytes } from 'node:crypto';

import { effectiveSettings } from '../../agent/definition';
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
import type { TaskStatus } from '../store/types';
import { PERMISSION_MODES, type Permission } from '../../core/config';
import { agentWithVersion, seedBuiltinAgent, toAgent } from '../agents/records';
import type { ServerContext } from '../context';
import { syncLocalAgents } from '../store/local';
import { machineSignedIn, runLocalTask } from './local';
import { credentialFix, resolveCredential } from '../settings/credentials';
import { decryptSecret } from '../store/secrets';
import { unsealed } from './context';
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

export function taskCwd(ctx: ServerContext, input: { cwd?: string }): string | undefined {
  if (input.cwd === undefined) return undefined;
  if (!ctx.local) throw new TaskInputError('cwd is available on a local server only');
  const checked = checkFolder(input.cwd);
  if (!checked.ok) throw new TaskInputError(checked.detail);
  return checked.folder.path;
}

const MAX_PROMPT_CHARS = 64 * 1024;
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
  const installations = (await ctx.store.list('installation')).filter(
    ({ value }) => !value.deletedAt && ctx.integrations[value.integration]?.repos,
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
      const token = await integration.auth.token(
        unsealed(ctx, installation),
        decryptSecret(ctx.config, app.credentials),
      );
      if ((await integration.repos.list(installation, token)).includes(repo))
        return { integration, installation, app, token };
    } catch {
      // One unreachable install must not hide the others.
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
  const slug = input.agent ?? 'coder';
  if (ctx.local) await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations);
  const inputs = () =>
    ctx.store.taskInputs
      ? ctx.store.taskInputs(slug, requester, input.engine)
      : agentWithVersion(ctx.store, slug);
  const initial = await inputs();
  let loaded = initial;
  if (await seedBuiltinAgent(ctx.store, now, slug, loaded)) loaded = await inputs();
  const { record, version } = loaded;
  const chosen = await chooseRunner(ctx, {
    requester,
    runner: input.runner,
    agent: version?.definition.runner,
  }).catch((error: Error) => {
    throw new TaskInputError(error.message);
  });
  if (!record || !version) throw new TaskInputError(`No agent "${slug}"`, 404);
  const usage: AgentUsage = {
    ...(input.engine ? { engine: input.engine } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort as AgentUsage['effort'] } : {}),
    ...(input.permissions ? { permissions: input.permissions as Permission } : {}),
  };
  const agent = toAgent(record, version, usage, ctx.integrations);
  const settings = effectiveSettings(agent);

  const credential = ctx.store.taskInputs
    ? (loaded as { credential?: string }).credential
    : (await resolveCredential(ctx.store, settings.engine, requester))?.id;
  const engine = settings.engine ?? 'claude';
  if (!credential && chosen.runner !== 'http' && !(await machineSignedIn(ctx, engine)))
    throw new TaskInputError(
      `No ${engine} credential is connected`,
      409,
      credentialFix(ctx, engine),
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
    ...(credential ? { credential } : {}),
    ...(requester ? { requester } : {}),
    ...(agent.files ? { files: agent.files } : {}),
    ...(agent.usage ? { usage: agent.usage } : {}),
    tools: {},
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
export async function continueTask(
  ctx: ServerContext,
  status: TaskStatus,
  text: string,
  outputSchema?: object,
): Promise<TaskStatus> {
  if (
    outputSchema !== undefined &&
    (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema))
  )
    throw new TaskInputError('outputSchema must be an object');
  if (!text.trim()) throw new TaskInputError('text is required');
  if (text.length > MAX_PROMPT_CHARS) throw new TaskInputError('text is longer than 64 KB');
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
  const { note: previousNote, ...context } = status.task.context ?? {};
  const turns = taskTurns(status);
  turns.at(-1)!.finishedAt ??= now;
  const next: TaskStatus = {
    task: {
      ...status.task,
      prompt: text,
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
