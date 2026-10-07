import { type Params } from '../routes/match';
import { type ServerContext } from '../context';
import { serverMode } from '../routes/guards';
import { json, redirect } from '../routes/http';

export async function meRoute(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  if (!ctx.auth) {
    return json({
      mode: serverMode(ctx),
      organization: { id: ctx.organizationId },
      server: serverInfo(ctx),
    });
  }

  const session = ctx.session!;

  return json({
    mode: serverMode(ctx),
    user: session.user,
    organization:
      session.organizations.find(candidate => candidate.id === session.organizationId) ?? null,
    organizations: session.organizations,
    manageMembersUrl: `${ctx.auth.issuer}/auth/onboarding`,
    server: serverInfo(ctx),
  });
}

function serverInfo(ctx: ServerContext) {
  return {
    name: ctx.config.name ?? 'Coder',
    store: ctx.config.store,
    ...(ctx.config.publicUrl ? { url: ctx.config.publicUrl } : {}),
    subscriptions: {
      claude: Boolean(ctx.config.subscriptions?.claude),
      codex: Boolean(ctx.config.subscriptions?.codex),
    },
  };
}

export async function organizationRoute(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
) {
  const contentType = req.headers.get('content-type') ?? '';
  const body = (
    contentType.includes('application/json')
      ? await req.json().catch(() => undefined)
      : await req.formData().then(
          form => Object.fromEntries(form.entries()),
          () => undefined,
        )
  ) as
    | {
        organization?: unknown;
      }
    | undefined;
  if (!body || typeof body !== 'object')
    return json({ error: 'Send the workspace as a form or JSON body.' }, 400);

  const slug = typeof body.organization === 'string' ? body.organization : '';
  const selected = slug ? await ctx.auth!.setOrganization(req.headers, slug) : undefined;
  if (!selected) return json({ error: 'You are not a member of that workspace.' }, 403);

  const { cookies, ...organization } = selected;
  const response = contentType.includes('application/json')
    ? json({ organization })
    : redirect('/dash', 303);
  for (const cookie of cookies) response.headers.append('set-cookie', cookie);

  return response;
}
