import { type Params } from '../routes/match';
import { appOwner, forInstallation, scoped, type ServerContext } from '../context';
import { builtinFlowsDir, flowsIn } from '../../flow/discover';
import { body } from '../settings/config';
import { TaskInputError, createTask, repoAccess, type NewTask } from './create';
import { redactTask, taskError } from './admin';
import { json } from '../routes/http';
import { type AgentApp, type AgentEvent } from '../../agent/types';
import { type Integration, type OwnEvent } from '../../integrations/types';
import { importAgents, pushedFiles, sourceEvent } from '../agents/repo';
import { storeInstallation } from '../agents/install';
import {
  adapterContext,
  chatFor,
  dashUrl,
  deliver,
  eventReplies,
  later,
  type Target,
} from '../chat';
import { dropTokens } from './context';
import { appendLog } from './logs';
import { recordFailure } from './failures';
import { reviewKey } from './queue';
import { updateMetadata } from '../store';
import { decryptSecret } from '../store/secrets';
import { InstallationBoundError } from '../store/types';

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
  return flowList(ctx, url.searchParams.get('repo')).catch(taskError);
}

export async function listPulls(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return pullList(ctx, url.searchParams.get('repo')).catch(taskError);
}

export async function runFlow(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return body<NewTask>(req)
    .then(input => run(ctx, { ...input, flow: params.name }))
    .catch(taskError);
}

export async function review(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  return body<NewTask & { post?: boolean }>(req)
    .then(({ post, ...input }) => {
      if (!input.repo || !input.pr) throw new TaskInputError('repo and pr are required');

      return run(ctx, { ...input, flow: 'review', args: { post: post === true } });
    })
    .catch(taskError);
}

export function start(
  ctx: ServerContext,
  work: Promise<unknown>,
  tasks: string[],
): Promise<Response> {
  (ctx.waitUntil ?? ((pending: Promise<unknown>) => void pending.catch(() => {})))(work);
  return Promise.resolve(json({ tasks }, 202));
}

/** Cancels queued reviews replaced by this event. */
async function dropQueuedReviews(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
): Promise<void> {
  const pr = integration.repos?.pullRequest(event);
  const tenant =
    pr === undefined
      ? undefined
      : await forInstallation(ctx, `${event.appId}:${event.installationId}`);
  if (!tenant) return;

  const key = reviewKey({ flow: 'review', event });
  if (!key) return;
  const queued = await tenant.queue.list(tenant.organizationId, {
    status: 'queued',
    reviewKey: key,
  });
  const now = (ctx.now ?? Date.now)();
  const replaced = JSON.stringify({
    kind: 'status',
    message: 'Replaced by a newer review of this pull request.',
  });
  for (const status of queued.filter(
    status =>
      status.task.event?.type === event.type && status.task.event.deliveryId !== event.deliveryId,
  ))
    if (
      await tenant.queue.cancel(tenant.organizationId, status.task.id, now, {
        statuses: ['queued'],
      })
    )
      await appendLog(
        tenant.store,
        status.task.id,
        [{ level: 'sys', line: replaced }],
        status.logSeq ?? 0,
        now,
        status.logBytes ?? 0,
      );
}

async function ownEvent(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  credentials: unknown,
  own: Exclude<OwnEvent, { invalid: true }>,
  now: number,
  target?: Target,
): Promise<Response> {
  if ('ack' in own) return new Response(null, { status: 200 });
  if ('unhandled' in own) {
    console.warn(`coder server: ${app.id} sent ${own.unhandled}, which Coder does not handle yet`);
    return new Response(null, { status: 200 });
  }
  if ('work' in own) {
    if (target) {
      const work = dashUrl(ctx)
        .then(dash => own.work(adapterContext(ctx, integration, app, credentials, target, dash)))
        .catch(error => {
          console.error(`coder server: webhook work failed for ${app.id}`, error);

          return recordFailure(ctx, app, error, target.id);
        });
      (ctx.waitUntil ?? (() => {}))(work);
    }
    return json({ ok: true });
  }
  if ('installation' in own) {
    // Only installs bound from the dashboard are tracked; the platform's payload never binds one.
    const tenant = await forInstallation(ctx, own.installation.installation.id);
    const existing = await tenant?.store.get('installation', own.installation.installation.id);
    if (!tenant || !existing) return json({ ok: true });

    await tenant.store.withAppLock(`repositories:${existing.id}`, async store => {
      const current = await store.get('installation', existing.id);
      if (!current || (own.installation.repos && current.deletedAt)) return;
      const change = own.installation.repos;
      // A selection change or an unknown list leaves it unknown; the next read lists it.
      const repos = change
        ? change.refresh || current.repos == null
          ? undefined
          : [...new Set([...current.repos, ...change.add])].filter(
              repo => !change.remove.includes(repo),
            )
        : own.installation.installation.repos;
      await updateMetadata(store, 'installation', existing.id, {
        account: own.installation.installation.account,
        ...(change || repos ? { repos } : {}),
        deletedAt: own.installation.op === 'delete' ? now : undefined,
      });
    });
    // Its repositories or permissions may have changed.
    await dropTokens(tenant.store, existing.id);

    return json({ ok: true });
  }
  if ('covers' in own) {
    const { installation: id, add = [], remove = [] } = own.covers;
    const tenant = await forInstallation(ctx, id);
    let found = false;
    try {
      if (tenant)
        await storeInstallation(
          tenant.store,
          id,
          current => {
            found = Boolean(current);
            if (!current || current.deletedAt) return undefined;
            const covers = [...new Set([...(current.covers ?? []), ...add])];
            return { ...current, covers: covers.filter(entry => !remove.includes(entry)) };
          },
          now,
        );
    } catch (error) {
      if (!(error instanceof InstallationBoundError)) throw error;
      console.error(`coder server: ${id} covers an account bound elsewhere; grant ignored`);
    }

    // The platform sends it again later, once the install callback has stored the installation.
    return found
      ? json({ ok: true })
      : new Response('Installation not stored yet', { status: 503 });
  }
  if ('pushed' in own && own.pushed) {
    const tenant = await forInstallation(ctx, own.pushed.installation);
    if (tenant) await pushedFiles(tenant.store, own.pushed);
  }
  if (!('changes' in own) && 'pushed' in own) return json({ ok: true });
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
        deliver(ctx, integration, app, credentials, event, replies, () =>
          dropQueuedReviews(ctx, integration, event),
        ),
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
  const bound = target.installation ? { ...target, id: target.installation } : undefined;
  const own = integration.ownEvents?.(req, raw, app, credentials);
  if (own && 'invalid' in own) return new Response('Invalid signature', { status: 401 });
  if (own) return ownEvent(ctx, integration, app, credentials, own, (ctx.now ?? Date.now)(), bound);
  const chat = await chatFor(ctx, app, bound);
  const webhook = chat.webhooks[integration.id]!;
  // Coder claims each delivery by installation and conversation; Chat's own check knows only the message id.
  return webhook(new Request(req.url, { method: 'POST', headers: req.headers, body: raw }), {
    deduplicate: false,
    // Handler failures reach the catch below instead of only Chat's own log.
    propagateHandlerErrors: true,
    waitUntil: pending => {
      const logged = pending.catch(error => {
        console.error(`coder server: webhook work failed for ${app.id}`, error);

        return recordFailure(ctx, app, error, target.installation);
      });
      if (ctx.waitUntil) ctx.waitUntil(logged);
    },
  });
}
