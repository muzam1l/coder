import { eventOptions } from '../../agent/definition';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { BROKERED, BROKERED_PLACEHOLDER } from '../runners/vercel-sandbox';
import type { Integration, TokenBound } from '../../integrations/types';
import type { AgentEvent, Connection, Installation } from '../../agent/types';
import type { EngineCredential, TaskStatus } from '../store/types';
import type { ServerContext } from '../context';
import type { CoderConfig } from '../../core/config';
import { taskConfig } from '../settings/config';
import { credentialValue, resolveCredential } from '../settings/credentials';

/** Installation tokens are encrypted at rest; integrations see plaintext only in memory. */
export function unsealed(ctx: ServerContext, installation: Installation): Installation {
  return installation.token
    ? {
        ...installation,
        token: decryptSecret<string>(ctx.config, installation.token),
      }
    : installation;
}

/** The installation's token through its integration; a refreshed one is stored again, sealed. */
export function installationToken(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  credentials: unknown,
  bound?: TokenBound,
): Promise<string> {
  return integration.auth.token(unsealed(ctx, installation), credentials, bound, async token => {
    const current = await ctx.store.get('installation', installation.id);
    if (current) {
      const sealed = encryptSecret(ctx.config, token);
      await ctx.store.put('installation', installation.id, { ...current, token: sealed });
      installation.token = sealed;
    }
  });
}

/** The linked member's own platform token, refreshed and stored again when it had expired. */
async function requesterToken(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
  credentials: unknown,
): Promise<string | undefined> {
  if (!integration.auth.user || !ctx.auth) return undefined;
  const user = await ctx.auth.linkedUser(integration.id, event.actor.id);
  if (!user?.token || !user.organizations?.includes(ctx.organizationId)) return undefined;
  const access = await integration.auth.user.access(
    decryptSecret<string>(ctx.config, user.token),
    credentials,
    { fetch: ctx.fetch ?? fetch, now: (ctx.now ?? Date.now)() },
  );
  if (access.refreshed)
    await ctx.auth.link(user, integration.id, event.actor.id, {
      token: encryptSecret(ctx.config, access.refreshed),
    });
  return access.accessToken;
}

/** A bound on one repository, when there is one, and the tools a token serves. */
export function tokenBound(
  repo: { owner: string; name: string } | undefined,
  tools: string[],
): TokenBound {
  return { ...(repo ? { repo: { owner: repo.owner, name: repo.name } } : {}), tools };
}

/** A task's platform token: the requester's own when its trigger acts as them, else the installation's narrowed to `bound`. */
export async function taskToken(
  ctx: ServerContext,
  integration: Integration,
  installation: Installation,
  event: AgentEvent,
  credentials: unknown,
  bound: TokenBound,
  actAs?: 'requester',
): Promise<string> {
  const own =
    actAs === 'requester'
      ? await requesterToken(ctx, integration, event, credentials).catch(() => undefined)
      : undefined;
  return own ?? installationToken(ctx, integration, installation, credentials, bound);
}

const repoName = (value: string | undefined) => {
  const match = value && /^([^/]+)\/([^/]+)$/.exec(value);
  return match ? { owner: match[1]!, name: match[2]! } : undefined;
};

/** A connected installation's token, narrowed to the task's frozen bound, or before a task to its config repository read-only. */
async function connectionToken(
  ctx: ServerContext,
  integration: string,
  connection: Connection,
  task?: Pick<TaskStatus['task'], 'tools' | 'toolScopes'>,
): Promise<string | undefined> {
  if (connection.kind === 'oauth') return decryptSecret<string>(ctx.config, connection.token);

  const linked = await ctx.store.get('installation', connection.id);
  if (!linked || linked.deletedAt) return undefined;

  const app = await ctx.store.get('app', linked.app);
  const target = ctx.integrations[integration];
  if (!app || !target) return undefined;

  const repo = task ? task.toolScopes?.[integration]?.repo : repoName(linked.settings?.configRepo);
  if (!repo) return undefined;

  return target.auth.token(
    unsealed(ctx, linked),
    decryptSecret(ctx.config, app.credentials),
    tokenBound(repo, task ? (task.tools[integration] ?? []) : target.tools.presets.observe),
  );
}

/** Event token plus tokens for connected integrations that can still be minted. */
export async function resolveTokens(
  ctx: ServerContext,
  installation: Installation,
  event: AgentEvent,
  eventToken: string,
  task?: Pick<TaskStatus['task'], 'tools' | 'toolScopes'>,
): Promise<Record<string, string>> {
  const tokens: Record<string, string> = { [event.integration]: eventToken };
  await Promise.all(
    Object.entries(installation.connections ?? {}).map(async ([integration, connection]) => {
      if (integration === event.integration) return;
      try {
        const token = await connectionToken(ctx, integration, connection, task);
        if (token) tokens[integration] = token;
      } catch {}
    }),
  );
  return tokens;
}
export async function eventTokens(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<Record<string, string>> {
  const event = task.event!;
  const integration = ctx.integrations[event.integration];
  if (!integration) throw new Error(`Unknown integration "${event.integration}"`);

  const [app, installation] = await Promise.all([
    ctx.store.get('app', event.appId),
    ctx.store.get('installation', `${event.appId}:${event.installationId}`),
  ]);
  if (!app) throw new Error(`Unknown app "${event.appId}"`);
  if (!installation || installation.deletedAt) throw new Error('Installation is gone');

  // A review that posts needs the comment scope and nothing more.
  const posts = task.flow === 'review' && task.args?.post === true;
  const eventToken = await taskToken(
    ctx,
    integration,
    installation,
    event,
    decryptSecret(ctx.config, app.credentials),
    tokenBound(
      task.toolScopes?.[event.integration]?.repo ?? event.repo,
      task.tools[event.integration] ?? (posts ? integration.tools.presets.comment : []),
    ),
    eventOptions(task.definition.integrations[event.integration], event.type)?.actAs,
  );
  const resolved = await resolveTokens(ctx, installation, event, eventToken, task);
  const tokens = Object.fromEntries(Object.entries(resolved).filter(([id]) => id in task.tools));
  tokens[event.integration] = eventToken;

  return tokens;
}

export async function taskContext(
  ctx: ServerContext,
  status: TaskStatus,
): Promise<{
  task: TaskStatus['task'];
  tokens: Record<string, string>;
  credential: EngineCredential;
  config: Partial<CoderConfig>;
}> {
  const task = status.task;
  const [tokens, config, credential] = await Promise.all([
    task.event ? eventTokens(ctx, status.task) : {},
    ctx.local ? {} : taskConfig(ctx.store, ctx.config),
    taskCredential(ctx, task),
  ]);
  if (task.runner !== 'vercel-sandbox') return { task, tokens, credential, config };
  const env = Object.fromEntries(
    Object.entries(credential.env).map(([name, value]) => [
      name,
      name in BROKERED ? BROKERED_PLACEHOLDER : value,
    ]),
  );
  return { task, tokens, credential: { ...credential, env }, config };
}

/** The task's engine credential; a member's own runner falls back to the machine's logins. */
export async function taskCredential(
  ctx: ServerContext,
  task: TaskStatus['task'],
): Promise<EngineCredential> {
  const selected = task.credential
    ? await ctx.store.get('credential', task.credential)
    : (
        await resolveCredential(
          ctx.store,
          task.usage?.engine ?? task.definition.engine,
          task.requester,
        )
      )?.value;
  if (selected) return credentialValue(ctx.config, selected);
  if (!task.runnerId && !ctx.local) throw new Error('no-credential');

  return {
    engine: (task.usage?.engine ??
      task.definition.engine ??
      'claude') as EngineCredential['engine'],
    env: {},
  };
}
