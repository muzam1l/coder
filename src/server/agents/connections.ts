import { decryptSecret } from '../store/secrets';
import { type Params } from '../routes/match';
import { encodeJson } from '../../utils/base64url';
import { issueNonce } from '../auth/nonce';
import { type ServerContext } from '../context';
import { sharedApps } from './apps';
import { nativeApp } from '../connections/records';
import { getAgent } from './records';
import { json } from '../routes/http';
import { LOOPBACK } from '../routes/guards';

export async function adminInstallLink(
  req: Request,
  ctx: ServerContext,
  appId: string,
  back: string | null,
  link: string | null,
): Promise<Response> {
  const app = await ctx.store.get('app', appId);
  if (!app) return json({ error: 'Unknown app' }, 404);

  const publicUrl = ctx.config.publicUrl;
  if (!publicUrl) return json({ error: 'PUBLIC_URL is not set on this server' }, 400);

  const tx = await issueNonce(ctx, 'install', ctx.session?.user.id ?? 'anonymous', app.id);
  const state = encodeJson({ tx, ...(back ? { back } : {}), ...(link ? { link } : {}) });

  return json({
    url: `${publicUrl.replace(/\/$/, '')}/install/${app.integration}?app=${encodeURIComponent(app.id)}&state=${state}`,
  });
}

/** This workspace's apps and the server's shared ones, for one agent or all. */
export async function agentApps(ctx: ServerContext, agent?: string | null) {
  const server = ctx.serverOrganizationId;
  const [own, shared] = await Promise.all([
    ctx.store.list('app'),
    server !== undefined && server !== ctx.organizationId && ctx.scope
      ? ctx
          .scope(server)
          .store.list('app')
          .then(rows =>
            rows.filter(
              ({ value }) =>
                value.builtin && ctx.integrations[value.integration]?.app.builtin === 'shared',
            ),
          )
      : [],
  ]);

  return [...own, ...shared].filter(
    ({ value }) =>
      (!value.builtin || ctx.integrations[value.integration]?.app.builtin === 'shared') &&
      (!agent || value.agent === agent),
  );
}

export async function listApps(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const rows = await agentApps(ctx, url.searchParams.get('agent'));

  return json(
    rows.map(({ id, value }) => {
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

/** `?agent=` fills that agent's name into create steps that prefill the platform's form. */
export async function integrationCatalog(ctx: ServerContext, url: URL): Promise<Response> {
  const publicUrl = ctx.config.publicUrl;
  const unreachable = publicUrl ? LOOPBACK.has(new URL(publicUrl).hostname) : false;
  // Platforms cannot call a loopback address, so create steps never offer one to copy.
  const base = unreachable ? 'https://<public address>' : publicUrl;
  const agent = url.searchParams.get('agent');
  const [record, apps, own] = await Promise.all([
    agent ? getAgent(ctx.store, agent) : undefined,
    sharedApps(ctx),
    ctx.store.list('app'),
  ]);
  const shared = new Set(apps.map(app => app.integration));

  return json(
    await Promise.all(
      Object.values(ctx.integrations).map(async integration => ({
        id: integration.id,
        name: integration.name,
        brand: integration.brand,
        description: integration.description,
        installLabel: integration.installLabel ?? `Connect ${integration.id}`,
        ...(integration.covered ? { covered: integration.covered } : {}),
        ...(integration.featured ? { featured: true } : {}),
        builtinApp: integration.app.builtin,
        ...(integration.auth.user ? { personal: true } : {}),
        ...((await nativeApp(ctx, integration.id, undefined, [
          ...apps,
          ...own.map(row => row.value),
        ]))
          ? { connectable: true }
          : {}),
        organizationApps: integration.organizationApps === true,
        events: Object.fromEntries(
          Object.entries(integration.events).map(([name, { description, noisy, addressed }]) => [
            name,
            { description, ...(noisy ? { noisy } : {}), ...(addressed ? { addressed } : {}) },
          ]),
        ),
        presets: integration.tools.presets,
        repositories: Boolean(integration.repos),
        ...(integration.app.createStep && base
          ? {
              create: integration.app.createStep(base, {
                name: record?.name,
                shared: shared.has(integration.id),
              }),
            }
          : {}),
        ...(unreachable ? { unreachable: true } : {}),
      })),
    ),
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
