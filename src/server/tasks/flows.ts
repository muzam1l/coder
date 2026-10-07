import { type Params } from '../routes/match';
import { appOwner, forInstallation, scoped, type ServerContext } from '../context';
import { builtinFlowsDir, flowsIn } from '../../flow/discover';
import { ConfigError, body } from '../settings/config';
import { TaskInputError, createTask, repoAccess, type NewTask } from './create';
import { redactTask, taskError } from './admin';
import { json } from '../routes/http';
import { type AgentApp } from '../../agent/types';
import { type Integration, type OwnEvent } from '../../integrations/types';
import { importAgents, sourceEvent } from '../agents/repo';
import { chatFor, deliver, eventReplies, later } from '../chat';
import { updateMetadata } from '../store';
import { decryptSecret } from '../store/secrets';

const SLUG = /^[a-z0-9][a-z0-9_-]*$/i;

async function flowList(ctx: ServerContext, repo: string | null): Promise<Response> {
  const builtin = flowsIn(builtinFlowsDir(), 'builtin').map(({ name }) => ({
    name,
    scope: 'builtin',
  }));
  if (!repo) return json(builtin);
  try {
    const { integration, token } = await repoAccess(ctx, repo);
    const names = integration.repos
      ? await integration.repos.listDir(repo, '.coder/flows', token)
      : [];
    const own = names
      .map(file => file.replace(/\.(ts|mjs|js)$/, ''))
      .filter(name => SLUG.test(name));
    return json([
      ...own.map(name => ({ name, scope: 'workspace' })),
      ...builtin.filter(flow => !own.includes(flow.name)),
    ]);
  } catch (error) {
    return taskError(error);
  }
}

async function pullList(ctx: ServerContext, repo: string | null): Promise<Response> {
  if (!repo) throw new TaskInputError('repo is required');
  const { integration, token } = await repoAccess(ctx, repo);
  return json((await integration.repos?.pullRequests(repo, token)) ?? []);
}

async function run(ctx: ServerContext, input: NewTask): Promise<Response> {
  try {
    return json(redactTask(await createTask(ctx, 'dashboard', input)), 201);
  } catch (error) {
    return taskError(error);
  }
}

export async function listFlows(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  try {
    {
      return flowList(ctx, url.searchParams.get('repo'));
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);

    return taskError(error);
  }
}

export async function listPulls(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  try {
    {
      return await pullList(ctx, url.searchParams.get('repo'));
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);

    return taskError(error);
  }
}

export async function runFlow(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const named = params.name;

  try {
    {
      const input = await body<NewTask>(req);

      return run(ctx, { ...input, flow: named });
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);

    return taskError(error);
  }
}

export async function review(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  try {
    {
      const { post, ...input } = await body<
        NewTask & {
          post?: boolean;
        }
      >(req);
      if (!input.repo || !input.pr) throw new TaskInputError('repo and pr are required');

      return run(ctx, { ...input, flow: 'review', args: { post: post === true } });
    }
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: error.message }, 400);

    return taskError(error);
  }
}

export function start(
  ctx: ServerContext,
  work: Promise<unknown>,
  tasks: string[],
): Promise<Response> {
  (ctx.waitUntil ?? ((pending: Promise<unknown>) => void pending.catch(() => {})))(work);
  return Promise.resolve(json({ tasks }, 202));
}

async function ownEvent(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  own: Exclude<OwnEvent, { invalid: true }>,
  now: number,
): Promise<Response> {
  if ('installation' in own) {
    // Only installs bound from the dashboard are tracked; the platform's payload never binds one.
    const tenant = await forInstallation(ctx, own.installation.installation.id);
    const existing = await tenant?.store.get('installation', own.installation.installation.id);
    if (!tenant || !existing) return json({ ok: true });

    await updateMetadata(tenant.store, 'installation', existing.id, {
      account: own.installation.installation.account,
      deletedAt: own.installation.op === 'delete' ? now : undefined,
    });

    return json({ ok: true });
  }
  if ('changes' in own) {
    const change = own.changes;
    try {
      if (!app.branch) await updateMetadata(ctx.store, 'app', app.id, { branch: change.branch });
      const imported = await importAgents(
        ctx,
        change.repo,
        change.ref,
        {
          ...sourceEvent(),
          integration: integration.id,
          appId: app.id,
        },
        change.branch,
      );
      return imported
        ? json({ imported: imported.map(version => version.agent) })
        : json({ error: `No installed app can read ${change.repo}` }, 400);
    } catch (error) {
      return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  }

  // Verified; dispatch runs after the response.
  for (const event of own.events)
    later(
      ctx,
      app,
      event,
      eventReplies(ctx, app, event).then(replies =>
        deliver(ctx, integration, app, credentials, event, replies),
      ),
    );

  return json({ accepted: own.events.length }, 202);
}

export async function hook(req: Request, base: ServerContext, id: string): Promise<Response> {
  const integration = base.integrations[id]!;

  const raw = await req.text();
  const target = integration.target(req, raw);
  if (target instanceof Response) return target;
  if (!target) return new Response('Not addressed to an app', { status: 400 });
  const key = `${integration.id}:${target.app}`;
  const found = base.webhookTarget
    ? await base.webhookTarget(
        key,
        target.installation ? `${key}:${target.installation}` : undefined,
      )
    : undefined;
  const owner = base.webhookTarget
    ? found && {
        ctx: {
          ...scoped(base, found.organizationId),
          ...(found.bound ? { boundInstallation: found.bound } : {}),
        },
        app: found.app,
      }
    : await appOwner(base, key);
  if (!owner) return new Response('Unknown app', { status: 404 });
  const { ctx, app } = owner;
  const credentials = decryptSecret(ctx.config, app.credentials);
  const own = integration.ownEvents?.(req, raw, app, credentials);
  if (own && 'invalid' in own) return new Response('Invalid signature', { status: 401 });
  if (own) return ownEvent(ctx, integration, app, credentials, own, (ctx.now ?? Date.now)());
  const chat = await chatFor(
    ctx,
    app,
    target.installation ? { ...target, id: target.installation } : undefined,
  );
  const webhook = chat.webhooks[integration.id]!;
  // Coder claims each delivery by installation and conversation; Chat's own check knows only the message id.
  return webhook(new Request(req.url, { method: 'POST', headers: req.headers, body: raw }), {
    deduplicate: false,
    waitUntil: pending => {
      const logged = pending.catch(error =>
        console.error(`coder server: webhook work failed for ${app.id}`, error),
      );
      if (ctx.waitUntil) ctx.waitUntil(logged);
    },
  });
}
