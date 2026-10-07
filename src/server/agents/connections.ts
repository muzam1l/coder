import * as z from 'zod/mini';
import { decryptSecret, encryptSecret } from '../store/secrets';
import { type Params } from '../routes/match';
import { type Connection } from '../../agent/types';
import { encodeJson } from '../../utils/base64url';
import { issueNonce } from '../auth/nonce';
import { type ServerContext } from '../context';
import { updateMetadata } from '../store';
import { json } from '../routes/http';

const connectionSchema = z.object({
  installation: z.string().check(z.minLength(1)),
  integration: z.string().check(z.minLength(1)),
  token: z.string().check(z.minLength(1)),
  account: z.optional(z.string()),
});

export async function adminConnection(req: Request, ctx: ServerContext): Promise<Response> {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }
  const parsed = connectionSchema.safeParse(body);
  if (!parsed.success) return new Response('Invalid connection', { status: 400 });

  const { installation: id, integration, token, account } = parsed.data;
  const installation = await ctx.store.get('installation', id);
  if (!installation || installation.deletedAt)
    return new Response('Unknown installation', { status: 404 });

  const connection: Connection = {
    kind: 'oauth',
    token: encryptSecret(ctx.config, token),
    ...(account ? { account } : {}),
  };

  await updateMetadata(ctx.store, 'installation', id, {
    connections: { ...installation.connections, [integration]: connection },
  });

  return json({ ok: true });
}

export async function adminInstallLink(
  req: Request,
  ctx: ServerContext,
  appId: string,
  back: string | null,
): Promise<Response> {
  const app = await ctx.store.get('app', appId);
  if (!app) return json({ error: 'Unknown app' }, 404);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl) return json({ error: 'PUBLIC_URL is not set on this server' }, 400);

  const tx = await issueNonce(ctx, 'install', ctx.session?.user.id ?? 'anonymous', app.id);
  const state = encodeJson({ tx, ...(back ? { back } : {}) });

  return json({
    url: `${publicUrl.replace(/\/$/, '')}/install/${app.integration}?app=${encodeURIComponent(app.id)}&state=${state}`,
  });
}

export async function listApps(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const agent = url.searchParams.get('agent');
  const server = ctx.serverOrganizationId;
  const [own, shared] = await Promise.all([
    ctx.store.list('app'),
    server !== undefined && server !== ctx.organizationId && ctx.scope
      ? ctx
          .scope(server)
          .store.list('app')
          .then(rows => rows.map(({ id, value }) => ({ id, value: { ...value, builtin: true } })))
      : [],
  ]);
  const rows = [...own, ...shared];

  return json(
    rows
      .filter(({ value }) => !agent || value.agent === agent)
      .map(({ id, value }) => {
        const { credentials: _credentials, ...safe } = value;

        return { id, value: safe };
      }),
  );
}

export async function listInstallations(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const agent = url.searchParams.get('agent');
  const [rows, apps] = await Promise.all([
    ctx.store.list('installation'),
    agent ? ctx.store.list('app') : [],
  ]);
  const own = new Set(apps.filter(({ value }) => value.agent === agent).map(({ id }) => id));

  return json(
    rows
      .filter(({ value }) => !agent || own.has(value.app))
      .map(({ id, value }) => {
        const { token: _token, connections: _connections, ...safe } = value;

        return { id, value: safe };
      }),
  );
}

export function integrationCatalog(ctx: ServerContext): Response {
  return json(
    Object.values(ctx.integrations).map(integration => ({
      id: integration.id,
      name: integration.name,
      brand: integration.brand,
      description: integration.description,
      installLabel: integration.installLabel ?? `Connect ${integration.id}`,
      organizationApps: integration.organizationApps === true,
      events: Object.fromEntries(
        Object.entries(integration.events).map(([name, { description, noisy, addressed }]) => [
          name,
          { description, ...(noisy ? { noisy } : {}), ...(addressed ? { addressed } : {}) },
        ]),
      ),
      presets: integration.tools.presets,
      repositories: Boolean(integration.repos),
    })),
  );
}

export async function adminRepositories(ctx: ServerContext): Promise<Response> {
  const seen = new Map<string, { repo: string; integration: string }>();

  for (const { value: installation } of await ctx.store.list('installation')) {
    const integration = ctx.integrations[installation.integration];
    if (installation.deletedAt || !integration?.repos) continue;

    const app = await ctx.store.get('app', installation.app);
    if (!app) continue;

    try {
      const token = await integration.auth.token(
        installation.token
          ? {
              ...installation,
              token: decryptSecret<string>(ctx.config, installation.token),
            }
          : installation,
        decryptSecret(ctx.config, app.credentials),
      );
      for (const repo of await integration.repos.list(installation, token))
        if (!seen.has(repo)) seen.set(repo, { repo, integration: integration.id });
    } catch {
      // One unreachable installation must not hide the others.
    }
  }

  return json([...seen.values()].sort((a, b) => a.repo.localeCompare(b.repo)));
}
