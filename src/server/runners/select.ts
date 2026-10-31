/** Which runner a task runs on, and the instance behind a stored runner record. */
import type { AgentTask, RunnerTrust } from '../../agent/types';
import type { RunnerRecord } from '../store/types';
import type { ServerContext } from '../context';
import { decryptSecret } from '../store/secrets';
import { installationToken, repoInstallations } from '../tasks/context';
import { workspaceRepositories } from '../agents/connections';
import { createRunner, serverVcpus, type Runner } from '.';
import { runnerSnapshots } from './kinds/vercel-sandbox';
import { workspaceAdmin } from '../routes/guards';

export function visibleRunner(record: RunnerRecord, requestedBy?: string): boolean {
  return record.scope === 'workspace' || Boolean(requestedBy && record.owner === requestedBy);
}

export function serverRunnerId(ctx: ServerContext): string {
  return ctx.local ? 'local' : 'default';
}

/** Who operates a runner: the workspace for the built-in and workspace-scope records, a third party for a personal `http` runner, else its member. */
export function runnerTrust(record?: Pick<RunnerRecord, 'kind' | 'scope'>): RunnerTrust {
  if (!record || record.scope === 'workspace') return 'workspace';

  return record.kind === 'http' ? 'external' : 'member';
}

/** Why the session may not `change` a stored runner (test, edit, remove) or `assign` it to an agent, else nothing: one it cannot see is unknown; a workspace runner changes only by an admin; an agent's runner serves every member's turns, so only a workspace-trust one. */
export function runnerAccess(
  ctx: ServerContext,
  record: RunnerRecord | undefined,
  action: 'change' | 'assign',
): { error: string; status: number } | undefined {
  const user = ctx.session?.user.id;
  if (
    !record ||
    !visibleRunner(record, user) ||
    (!ctx.local && (record.kind === 'local' || record.kind === 'local-docker'))
  )
    return { error: 'Unknown runner', status: 404 };
  if (action === 'change' && record.scope === 'workspace' && !workspaceAdmin(ctx))
    return { error: 'Only a workspace owner or admin can change this runner.', status: 403 };
  if (action === 'assign' && runnerTrust(record) !== 'workspace')
    return {
      error:
        'An agent runs on a workspace runner or the built-in; pick a personal runner per task.',
      status: 400,
    };

  return undefined;
}

/** The server's own runner: charged per vCPU on a hosted server, never on a local one. */
export function serverRunner(ctx: ServerContext): Pick<AgentTask, 'runner' | 'vcpus' | 'trust'> {
  return ctx.local
    ? { runner: ctx.config.runner, trust: 'workspace' }
    : { runner: ctx.config.runner, vcpus: serverVcpus(ctx.config), trust: 'workspace' };
}

export async function chooseRunner(
  ctx: ServerContext,
  options: { requestedBy?: string; runner?: string; agent?: string } = {},
): Promise<Pick<AgentTask, 'runner' | 'runnerId' | 'vcpus' | 'trust'>> {
  const named = options.runner ?? options.agent;
  if (named === serverRunnerId(ctx)) return serverRunner(ctx);
  const rows = (
    await ctx.store.list('runner', {
      visibleTo: options.requestedBy,
      ...(named ? { runner: named } : { defaults: true }),
    })
  ).filter(
    ({ value }) =>
      visibleRunner(value, options.requestedBy) &&
      (ctx.local || (value.kind !== 'local' && value.kind !== 'local-docker')),
  );
  const found = named
    ? rows.find(({ id, value }) => id === named || value.name === named)
    : (rows.find(({ value }) => value.scope === 'personal' && value.default) ??
      rows.find(({ value }) => value.scope === 'workspace' && value.default));
  if (named && !found) throw new Error(`Unknown runner "${named}".`);

  return found
    ? { runner: found.value.kind, runnerId: found.id, trust: runnerTrust(found.value) }
    : serverRunner(ctx);
}

/** The repositories the workspace's GitHub connections reach. */
export async function githubRepos(ctx: ServerContext): Promise<string[]> {
  return (await workspaceRepositories(ctx))
    .filter(row => row.integration === 'github')
    .map(row => row.repo);
}

/** A token for `repo` from the workspace's GitHub connection there, narrowed to `purpose`. */
export async function githubRepoToken(
  ctx: ServerContext,
  repo: string,
  purpose: 'actions' | 'workflows',
): Promise<string> {
  const integration = ctx.integrations.github;
  const found = repoInstallations(
    await ctx.store.list('installation', { active: true }),
    'github',
    repo,
  );
  if (!integration || !found.length)
    throw new Error(
      `GitHub isn’t connected to ${repo}. Install it on that repository under Settings → Connections, or add a token with Actions, Contents and Workflows write.`,
    );

  // Several apps can reach a repository; the first that grants these permissions mints the token.
  for (const installation of found) {
    const app = await ctx.store.get('app', installation.app);
    if (!app) continue;
    try {
      return await installationToken(
        ctx,
        integration,
        installation,
        decryptSecret(ctx.config, app.credentials),
        { purpose, repository: repo.split('/')[1] },
      );
    } catch (error) {
      console.error(
        `coder server: ${purpose} token for ${repo} from ${installation.id} failed`,
        error,
      );
    }
  }
  throw new Error(
    `Coder could not get a GitHub token for ${repo}. If the app's Actions and Workflows permissions are pending, approve them on GitHub.`,
  );
}

export function recordRunner(ctx: ServerContext, record: RunnerRecord, id?: string): Runner {
  const secrets = decryptSecret<Record<string, string>>(ctx.config, record.secret);
  const config = { ...record.config, ...secrets };
  const appToken =
    record.kind === 'github-actions' && !secrets.token
      ? { token: () => githubRepoToken(ctx, String(config.repo), 'actions') }
      : {};
  return createRunner(record.kind, {
    workDir: ctx.config.workDir,
    config: { ...config, ...appToken },
    fetch: ctx.fetch,
    sandbox: {
      ...(id
        ? {
            snapshots: runnerSnapshots(ctx.store, `runner:${id}:`),
          }
        : {}),
    },
  });
}

export async function taskRunner(
  ctx: ServerContext,
  task: Pick<AgentTask, 'runner' | 'runnerId'>,
): Promise<Runner | undefined> {
  if (!task.runnerId) return ctx.runners[task.runner];

  const record = await ctx.store.get('runner', task.runnerId);
  if (
    !record ||
    record.kind !== task.runner ||
    (!ctx.local && (record.kind === 'local' || record.kind === 'local-docker'))
  ) {
    ctx.settings?.runnerInstances?.delete(task.runnerId);
    return undefined;
  }

  decryptSecret(ctx.config, record.secret);

  const instances = ((ctx.settings ??= {}).runnerInstances ??= new Map());
  const signature = JSON.stringify([record.kind, record.config, record.secret]);
  let instance = instances.get(task.runnerId);
  if (instance?.signature !== signature) {
    instance = { signature, runner: recordRunner(ctx, record, task.runnerId) };
    instances.set(task.runnerId, instance);
  }

  return instance!.runner;
}
