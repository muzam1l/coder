import { type Params } from '../routes/match';
import { encryptSecret } from '../store/secrets';
import { type CreateState } from '../../integrations/types';
import { type AgentApp } from '../../agent/types';
import { consumeNonce, inspectNonce, issueNonce } from '../auth/nonce';
import { encodeJson } from '../../utils/base64url';
import { decodeParam, redirect } from '../routes/http';
import { type AppsContext, OPERATOR, page, readState, createTarget } from './platform';

export async function createPage(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  const id = params.id!;
  const operator = ctx.operatorApp ?? false;
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  const userId = operator ? OPERATOR : (ctx.session?.user.id ?? 'anonymous');
  const integration = ctx.integrations[id!];
  if (!integration)
    return page(`Unknown integration "${id}"; run coder agent integrations list to see them`, 404);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl)
    return page(
      'PUBLIC_URL is not set on this server; set it to the address platforms should call and restart',
      400,
    );

  const request = ctx.fetch ?? fetch;
  const now = ctx.now?.() ?? Date.now();
  const parsed = readState(url.searchParams);
  if (!parsed)
    return page(
      "Setup link is missing or malformed; start again from the agent's Platforms tab",
      400,
    );
  if (!parsed.definition.integrations[id!])
    return page(`This agent declares no ${id} integration in its agent.json`, 400);
  if (parsed.state.public && !operator)
    return page('Only the server operator creates public apps', 403);

  const target = createTarget(id!, parsed.state);
  // The operator's command issued the transaction already; the dashboard gets a fresh one.
  const tx = parsed.state.tx
    ? (await inspectNonce(ctx, parsed.state.tx, 'create', userId)) === target
      ? parsed.state.tx
      : undefined
    : await issueNonce(ctx, 'create', userId, target);
  if (!tx) return page('This app creation link is invalid, expired, or already used', 403);

  const state = { ...parsed.state, tx };

  return integration.app.createPage({
    publicUrl,
    state,
    definition: parsed.definition,
    encodedState: encodeJson(state),
  });
}

export async function completeCreate(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  const id = params.id!;
  const operator = ctx.operatorApp ?? false;
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  const userId = operator ? OPERATOR : (ctx.session?.user.id ?? 'anonymous');
  const integration = ctx.integrations[id!];
  if (!integration)
    return page(`Unknown integration "${id}"; run coder agent integrations list to see them`, 404);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl)
    return page(
      'PUBLIC_URL is not set on this server; set it to the address platforms should call and restart',
      400,
    );

  const request = ctx.fetch ?? fetch;
  const now = ctx.now?.() ?? Date.now();
  // State travels in the query (GitHub) or the posted form (Slack).
  const form = undefined;
  const carried = decodeParam<CreateState>(url.searchParams.get('state'));
  const parsed =
    readState(url.searchParams) ??
    (carried &&
      readState(
        new URLSearchParams(
          Object.entries(carried).filter(([, v]) => v !== undefined) as [string, string][],
        ),
      )) ??
    (form && readState(form));
  if (!parsed)
    return page('Setup state was lost between the platform and this server; start again', 400);
  if (
    !parsed.state.tx ||
    !(await consumeNonce(ctx, parsed.state.tx, 'create', userId, createTarget(id!, parsed.state)))
  )
    return page('This app creation link is invalid, expired, or already used', 403);

  const created = await integration.app
    .createCallback(req, { publicUrl, ...parsed, fetch: request })
    .catch(error =>
      page(`Creating the ${id} app failed: ${error instanceof Error ? error.message : error}`, 400),
    );
  if (created instanceof Response) return created;

  const app: AgentApp = {
    id: `${id}:${created.platformAppId}`,
    integration: id!,
    agent: parsed.state.agent,
    name: created.name,
    ...(parsed.state.repo ? { agentsRepo: parsed.state.repo } : {}),
    ...(parsed.state.repo ? { branch: parsed.state.branch ?? 'main' } : {}),
    ...(operator ? { builtin: true } : {}),
    credentials: encryptSecret(ctx.config, created.credentials),
    createdAt: now,
  };
  await ctx.store.put('app', app.id, app);
  if (operator)
    return page(
      `Created ${created.name}. Every workspace on this server can now connect it from its dashboard.`,
    );

  const tx = await issueNonce(ctx, 'install', userId, app.id);
  const back = `/dash/agents/${encodeURIComponent(app.agent)}/platforms`;

  return redirect(
    `${publicUrl}/install/${id}?app=${encodeURIComponent(app.id)}&state=${encodeJson({ tx, back })}`,
  );
}

export async function completeCreateForm(
  req: Request,
  ctx: AppsContext,
  params: Params,
  url: URL,
): Promise<Response | undefined> {
  const id = params.id!;
  const operator = ctx.operatorApp ?? false;
  if (!/^[a-z0-9_-]+$/.test(url.pathname.split('/')[2]!)) return undefined;

  const userId = operator ? OPERATOR : (ctx.session?.user.id ?? 'anonymous');
  const integration = ctx.integrations[id!];
  if (!integration)
    return page(`Unknown integration "${id}"; run coder agent integrations list to see them`, 404);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl)
    return page(
      'PUBLIC_URL is not set on this server; set it to the address platforms should call and restart',
      400,
    );

  const request = ctx.fetch ?? fetch;
  const now = ctx.now?.() ?? Date.now();
  // State travels in the query (GitHub) or the posted form (Slack).
  const form = new URLSearchParams(await req.clone().text());
  const carried = decodeParam<CreateState>(url.searchParams.get('state'));
  const parsed =
    readState(url.searchParams) ??
    (carried &&
      readState(
        new URLSearchParams(
          Object.entries(carried).filter(([, v]) => v !== undefined) as [string, string][],
        ),
      )) ??
    (form && readState(form));
  if (!parsed)
    return page('Setup state was lost between the platform and this server; start again', 400);
  if (
    !parsed.state.tx ||
    !(await consumeNonce(ctx, parsed.state.tx, 'create', userId, createTarget(id!, parsed.state)))
  )
    return page('This app creation link is invalid, expired, or already used', 403);

  const created = await integration.app
    .createCallback(req, { publicUrl, ...parsed, fetch: request })
    .catch(error =>
      page(`Creating the ${id} app failed: ${error instanceof Error ? error.message : error}`, 400),
    );
  if (created instanceof Response) return created;

  const app: AgentApp = {
    id: `${id}:${created.platformAppId}`,
    integration: id!,
    agent: parsed.state.agent,
    name: created.name,
    ...(parsed.state.repo ? { agentsRepo: parsed.state.repo } : {}),
    ...(parsed.state.repo ? { branch: parsed.state.branch ?? 'main' } : {}),
    ...(operator ? { builtin: true } : {}),
    credentials: encryptSecret(ctx.config, created.credentials),
    createdAt: now,
  };
  await ctx.store.put('app', app.id, app);
  if (operator)
    return page(
      `Created ${created.name}. Every workspace on this server can now connect it from its dashboard.`,
    );

  const tx = await issueNonce(ctx, 'install', userId, app.id);
  const back = `/dash/agents/${encodeURIComponent(app.agent)}/platforms`;

  return redirect(
    `${publicUrl}/install/${id}?app=${encodeURIComponent(app.id)}&state=${encodeJson({ tx, back })}`,
  );
}
