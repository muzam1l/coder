import { type Params } from '../routes/match';
import { LOOPBACK } from '../routes/guards';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { type AgentApp, type AgentDefinition } from '../../agent/types';
import { type CreateState, IntegrationError } from '../../integrations/types';
import { inspectNonce, issueNonce } from '../auth/nonce';
import { encodeJson } from '../../utils/base64url';
import { sha256 } from '../../utils/crypto';
import { decodeParam, json, redirect } from '../routes/http';
import { serveDash } from '../dash/serve';
import { sharedApps } from './apps';
import { audit } from '../operator';
import {
  type AppsContext,
  OPERATOR,
  outcome,
  dashOrigin,
  platformsPath,
  backPath,
  readState,
  createTarget,
  takeCreateState,
} from './platform';

const FINISHED_TTL_MS = 10 * 60 * 1000;

/** Where an operator's spent create transaction records which integration it finished. */
const finishedKey = (tx: string) => `create-finished:${sha256(tx)}`;

async function finishedTarget(ctx: AppsContext, tx: string): Promise<string | undefined> {
  const record = await ctx.store.get('delivery', finishedKey(tx));

  return record && 'target' in record ? record.target : undefined;
}

/** A checked creation request and its transaction: the operator's own, or a fresh one for this user. */
async function startCreate(
  ctx: AppsContext,
  id: string,
  source: URLSearchParams,
): Promise<
  { state: CreateState; definition: AgentDefinition } | { error: string; status: number }
> {
  const operator = ctx.operatorApp ?? false;
  const userId = operator ? OPERATOR : (ctx.session?.user.id ?? 'anonymous');
  if (!ctx.integrations[id])
    return {
      error: `Unknown integration "${id}"; run coder agent integrations list to see them`,
      status: 404,
    };
  if (!ctx.config.publicUrl)
    return {
      error:
        'PUBLIC_URL is not set on this server; set it to the address platforms should call and restart',
      status: 400,
    };
  if (operator && ctx.integrations[id]!.app.builtin !== 'shared')
    return {
      error: "Create this app in your workspace from the agent's Platforms tab.",
      status: 400,
    };

  const parsed = readState(source);
  if (!parsed)
    return {
      error: "Setup link is missing or malformed; start again from the agent's Platforms tab",
      status: 400,
    };
  if (!parsed.definition.integrations[id])
    return { error: `This agent declares no ${id} integration in its agent.json`, status: 400 };
  if (parsed.state.public && !operator && !ctx.integrations[id]!.publicApps)
    return {
      error: `${ctx.integrations[id]!.name} apps cannot be public here. Create a private one.`,
      status: 400,
    };

  const target = createTarget(id, parsed.state);
  // The operator's command issued the transaction already; the dashboard gets a fresh one.
  const tx = parsed.state.tx
    ? (await inspectNonce(ctx, parsed.state.tx, 'create', userId)) === target
      ? parsed.state.tx
      : undefined
    : await issueNonce(ctx, 'create', userId, target);
  if (!tx)
    return { error: 'This app creation link is invalid, expired, or already used', status: 403 };

  return { state: { ...parsed.state, tx }, definition: parsed.definition };
}

/** `GET /create/<id>`: a create link opened outside the Platforms tab continues in the dashboard. */
export async function createPage(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  // A signed operator link needs no workspace, so its page is served here, outside the dashboard shell; so is how it ended.
  const tx = url.searchParams.get('tx');
  if (
    ctx.operatorApp &&
    tx &&
    ((await inspectNonce(ctx, tx, 'create', OPERATOR)) ||
      (await finishedTarget(ctx, tx)) === params.id)
  )
    return (
      (await serveDash(req, undefined, ctx.dashboardHosts)) ??
      new Response('UI is not built', { status: 503 })
    );

  const query = new URLSearchParams(url.searchParams);
  query.set('create', params.id!);

  return redirect(`${dashOrigin(ctx)}/dash/setup?${query}`);
}

/** The transaction a create starts with, and where the browser goes when creation happens on the platform. */
async function startedCreate(ctx: AppsContext, id: string, source: URLSearchParams) {
  const started = await startCreate(ctx, id, source);
  if ('error' in started) return json({ error: started.error }, started.status);

  const { app } = ctx.integrations[id]!;
  const tx = started.state.tx!;
  // Operator links have no catalog form; public creates have their own.
  const create =
    app.createStep && (ctx.operatorApp || started.state.public)
      ? app.createStep(ctx.config.publicUrl!, {
          name: started.definition.name,
          public: started.state.public,
        })
      : undefined;

  const publicUrl = ctx.config.publicUrl!;
  // The platform calls the new app's webhook at once, so a loopback address fails there.
  if (app.createPost && LOOPBACK.has(new URL(publicUrl).hostname))
    return json(
      {
        error: `${ctx.integrations[id]!.name} cannot reach ${publicUrl}. Set a public address first.`,
      },
      400,
    );
  const back = ctx.operatorApp ? undefined : platformsPath(started.state.agent);
  const post = app.createPost?.({
    publicUrl,
    ...started,
    encodedState: encodeJson({ tx, ...(back ? { back } : {}) }),
  });

  return json({ tx, ...(post ? { post } : {}), ...(create ? { create } : {}) });
}

/** `POST /create/<id>`: what `/dash/setup` starts a create link with. */
export async function createStart(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  return startedCreate(ctx, params.id!, url.searchParams);
}

/** `POST /admin/apps/create/<id>`: the transaction the dashboard's create form posts with. */
export async function adminCreateTransaction(
  req: Request,
  ctx: AppsContext,
  params: Params,
): Promise<Response> {
  const body: unknown = await req.json().catch(() => undefined);

  return startedCreate(
    ctx,
    params.integration!,
    new URLSearchParams(body && typeof body === 'object' ? (body as Record<string, string>) : {}),
  );
}

/** Finish creating the app the transaction is bound to, then install it. */
async function finishCreate(
  req: Request,
  ctx: AppsContext,
  id: string,
  transaction: string | null | undefined,
  stated: string | undefined,
): Promise<Response> {
  const operator = ctx.operatorApp ?? false;
  const userId = operator ? OPERATOR : (ctx.session?.user.id ?? 'anonymous');
  const integration = ctx.integrations[id];
  if (!integration) return outcome(ctx, 'unknown-integration', { platform: id }, stated);
  if (operator && integration.app.builtin !== 'shared')
    return json(
      { error: "Create this app in your workspace from the agent's Platforms tab." },
      400,
    );

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl) return outcome(ctx, 'no-public-url', {}, stated);

  const parsed = transaction ? await takeCreateState(ctx, transaction, id, userId) : undefined;
  if (!parsed) return outcome(ctx, 'create-expired', { platform: id }, stated);

  // An operator's create ends on its own page, which this spent transaction alone still opens.
  if (operator)
    await ctx.store.put(
      'delivery',
      finishedKey(transaction!),
      { at: ctx.now?.() ?? Date.now(), target: id },
      { ttlMs: FINISHED_TTL_MS },
    );
  const back = operator ? `/create/${id}` : platformsPath(parsed.state.agent);
  const spent = operator ? { tx: transaction! } : {};
  const shared = operator
    ? undefined
    : (await sharedApps(ctx)).find(entry => entry.integration === id);
  const created = await integration.app
    .createCallback(req, {
      publicUrl,
      ...parsed,
      fetch: ctx.fetch ?? fetch,
      ...(shared ? { shared: decryptSecret(ctx.config, shared.credentials) } : {}),
    })
    .catch((error: unknown) => {
      // A form value the dashboard can fix in place stays in its dialog.
      if (
        error instanceof IntegrationError &&
        error.code === 'invalid-field' &&
        req.headers.get('accept') === 'application/json'
      )
        return json({ error: error.message }, 400);
      if (error instanceof IntegrationError)
        return outcome(ctx, error.code, { platform: id, error: error.error, ...spent }, back);
      console.error(`coder server: creating the ${id} app failed`, error);

      return outcome(ctx, 'failed', { platform: id, ...spent }, back);
    });
  if (created instanceof Response) return created;

  const app: AgentApp = {
    id: `${id}:${created.platformAppId}`,
    integration: id,
    agent: parsed.state.agent,
    name: created.name,
    ...(parsed.state.repo ? { agentsRepo: parsed.state.repo } : {}),
    ...(parsed.state.repo ? { branch: parsed.state.branch ?? 'main' } : {}),
    ...(operator ? { builtin: true } : {}),
    ...('shared' in created
      ? { shared: shared!.id, credentials: '' }
      : { credentials: encryptSecret(ctx.config, created.credentials) }),
    createdAt: ctx.now?.() ?? Date.now(),
  };
  await ctx.store.put('app', app.id, app);
  if (operator) {
    await audit(ctx, 'Created the shared app', `${created.name} on ${integration.name}`);
    return outcome(ctx, 'created', { platform: id, app: created.name, ...spent }, back);
  }

  const tx = await issueNonce(ctx, 'install', userId, app.id);

  return redirect(
    `${publicUrl}/install/${id}?app=${encodeURIComponent(app.id)}&state=${encodeJson({ tx, back })}`,
  );
}

/** `GET /create/<id>/callback`: the platform's redirect after creating the app, such as GitHub's manifest code. */
export async function completeCreate(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  const state = decodeParam<{ tx?: string; back?: string }>(url.searchParams.get('state'));

  return finishCreate(req, ctx, params.id!, state?.tx, backPath(state?.back));
}

/** `POST /create/<id>/callback`: a create form's values. */
export async function completeCreateForm(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  const transaction = new URLSearchParams(await req.clone().text()).get('tx');
  const done = await finishCreate(req, ctx, params.id!, transaction, undefined);
  const next = done.headers.get('location');

  // The dashboard asks for the next address and goes there itself; its CSP stops a form post that redirects to a platform.
  return next && req.headers.get('accept') === 'application/json' ? json({ url: next }) : done;
}
