import { type Params } from '../routes/match';
import { type ServerContext } from '../context';
import { operator, serverMode } from '../routes/guards';
import { json } from '../routes/http';

/** A server without accounts has one workspace, at `/dash/local`. */
export const LOCAL_SLUG = 'local';

export async function meRoute(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  if (!ctx.auth) {
    return json({
      mode: serverMode(ctx),
      organization: { id: ctx.organizationId, slug: LOCAL_SLUG },
      server: serverInfo(ctx),
      operator: operator(ctx),
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
    operator: operator(ctx, session),
  });
}

function serverInfo(ctx: ServerContext) {
  return {
    name: ctx.config.name ?? 'Coder',
    store: ctx.config.store,
    ...(ctx.config.publicUrl ? { url: ctx.config.publicUrl } : {}),
    issuesUrl: ctx.config.issuesUrl,
    subscriptions: {
      claude: Boolean(ctx.config.subscriptions?.claude),
      codex: Boolean(ctx.config.subscriptions?.codex),
    },
  };
}

/** The slug of `ctx`'s organization from its session, else of the session's active one; else the organization id, which the dashboard sends on to the slug. */
export function sessionSlug(ctx: ServerContext): string {
  const organizations = ctx.session?.organizations ?? [];
  const org =
    organizations.find(entry => entry.id === ctx.organizationId) ??
    organizations.find(entry => entry.id === ctx.session?.organizationId);

  return org?.slug ?? (ctx.auth ? ctx.organizationId : LOCAL_SLUG);
}

/** The same without a session, such as for a link posted to a platform: the slug as Wular last named it. */
export async function organizationSlug(
  ctx: ServerContext,
  workspace?: { slug: string },
): Promise<string> {
  const known =
    ctx.session?.organizations.find(org => org.id === ctx.organizationId)?.slug ?? workspace?.slug;

  if (known || !ctx.auth) return known ?? LOCAL_SLUG;

  return (await ctx.auth.organization?.(ctx.organizationId))?.slug ?? ctx.organizationId;
}

/** A dashboard page of the organization `slug`, such as `/tasks/<id>`; without one, the dashboard opens it in the active organization. */
export const dashPath = (slug: string, page = '') =>
  slug ? `/dash/${encodeURIComponent(slug)}${page}` : `/dash${page}`;
