/** The operator area: the built-in agent's shared app per platform, and the log of what operators did. */
import { randomBytes } from 'node:crypto';

import type { AuditRow, OperatorAppRow } from '../client/types';
import { serverAppUrl } from './agents/apps';
import { appUpdateOf, changedApps, readDrift, updateApp } from './agents/connections';
import { scoped, type ServerContext } from './context';
import { LOOPBACK } from './routes/guards';
import { json } from './routes/http';
import { type Params } from './routes/match';

const AUDIT_PAGE = 100;

// Keys count down from the largest 13-digit time, so key order is newest first.
const auditKey = (at: number) =>
  `audit:${String(9_999_999_999_999 - at).padStart(13, '0')}:${randomBytes(4).toString('hex')}`;

/** What platforms call the shared apps unless the operator names them: the server's brand. */
const appName = (ctx: ServerContext) => ctx.config.name ?? 'Wular';

const serverScope = (ctx: ServerContext) =>
  scoped(ctx, ctx.serverOrganizationId ?? ctx.organizationId);

/** One line in the operator audit log, as the signed-in operator or the admin token. */
export async function audit(ctx: ServerContext, action: string, target: string) {
  const at = (ctx.now ?? Date.now)();
  const user = ctx.session?.user;
  const entry: AuditRow = {
    at,
    actor: user ? { id: user.id, name: user.name, email: user.email } : { id: 'admin-token' },
    action,
    target,
  };

  await serverScope(ctx).store.put('snapshot', auditKey(at), entry);
}

/** The server's built-in app on `integration`, its id, or a 404. */
async function sharedApp(server: ServerContext, integration: string) {
  const apps = await server.store.list('app');
  const app = apps.find(({ value }) => value.builtin && value.integration === integration)?.value;

  return app?.id ?? json({ error: `No built-in ${integration} app on this server.` }, 404);
}

export async function operatorApps(req: Request, ctx: ServerContext): Promise<Response> {
  const server = serverScope(ctx);
  const apps = await server.store.list('app');
  const shared = apps.map(({ value }) => value).filter(app => app.builtin);
  const changed = await changedApps(server, shared, true);
  const platforms: OperatorAppRow[] = Object.values(ctx.integrations)
    .filter(integration => integration.app.shareable)
    .map(integration => {
      const app = shared.find(value => value.integration === integration.id);

      return {
        integration: integration.id,
        name: integration.name,
        brand: integration.brand,
        organizationApps: integration.organizationApps === true,
        ...appUpdateOf(integration),
        ...(app
          ? {
              app: {
                id: app.id,
                name: app.name,
                createdAt: app.createdAt,
                ...(changed.has(app.id) ? { changed: true as const } : {}),
              },
            }
          : {}),
      };
    });

  const publicUrl = ctx.config.publicUrl;
  const unreachable = !!publicUrl && LOOPBACK.has(new URL(publicUrl).hostname);

  return json({ name: appName(ctx), platforms, ...(unreachable ? { unreachable: true } : {}) });
}

export async function setUpApp(req: Request, ctx: ServerContext, params: Params) {
  const integration = ctx.integrations[params.integration!];
  if (!integration) return json({ error: `Unknown integration "${params.integration}".` }, 404);
  if (!integration.app.shareable)
    return json(
      {
        error: `Create ${integration.name} apps in your workspace from the agent's Platforms tab.`,
      },
      400,
    );
  if (!ctx.config.publicUrl)
    return json({ error: 'Set PUBLIC_URL on this server first. Platforms call it.' }, 400);

  const body = (await req.json().catch(() => undefined)) as { name?: unknown; owner?: unknown };
  const text = (value: unknown) => (typeof value === 'string' && value.trim()) || undefined;
  const name = text(body?.name) ?? appName(ctx);
  const owner = integration.organizationApps ? text(body?.owner) : undefined;

  const url = await serverAppUrl(serverScope(ctx), integration.id, { name, owner });
  await audit(ctx, 'Started setting up a shared app', `${name} on ${integration.name}`);

  return json({ url });
}

/** `GET /admin/operator/apps/<integration>/drift`: what to change by hand on the platform for the built-in app. */
export async function sharedAppDrift(req: Request, ctx: ServerContext, params: Params, url: URL) {
  const server = serverScope(ctx);
  const id = await sharedApp(server, params.integration!);

  return typeof id === 'string' ? readDrift(req, server, { id }, url, true) : id;
}

/** `POST /admin/operator/apps/<integration>/update`: pushes the built-in app, or records its values were entered by hand. */
export async function updateSharedApp(req: Request, ctx: ServerContext, params: Params, url: URL) {
  const server = serverScope(ctx);
  const id = await sharedApp(server, params.integration!);
  if (typeof id !== 'string') return id;

  const response = await updateApp(req, server, { id }, url, true);
  if (response.ok)
    await audit(ctx, 'Updated a shared app', ctx.integrations[params.integration!]?.name ?? id);

  return response;
}

export async function auditLog(req: Request, ctx: ServerContext): Promise<Response> {
  const rows = await serverScope(ctx).store.list<AuditRow>('snapshot', {
    prefix: 'audit:',
    limit: AUDIT_PAGE,
  });

  return json(rows.map(row => row.value));
}
