import { decryptSecret } from '../store/secrets';
import { type Params } from '../routes/match';
import { encodeJson } from '../../utils/base64url';
import { issueNonce } from '../auth/nonce';
import { type ServerContext } from '../context';
import { sharedApps } from './apps';
import { nativeApp } from '../connections/records';
import { getAgent } from './records';
import { json, pageLimit } from '../routes/http';
import { LOOPBACK } from '../routes/guards';
import { updateMetadata } from '../store';
import { dropTokens, installationToken, unsealed } from '../tasks/context';
import type { Installation, AgentApp } from '../../agent/types';
import type { Integration } from '../../integrations/types';

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

/** An app as the dashboard sees it. */
function appRow(ctx: ServerContext, app: AgentApp) {
  const { credentials, ...safe } = app;
  const settings = app.builtin
    ? undefined
    : ctx.integrations[app.integration]?.app.settingsUrl?.(
        app,
        decryptSecret(ctx.config, credentials),
      );

  return {
    ...safe,
    ...(settings ? { settingsUrl: settings } : {}),
  };
}

export async function listApps(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const rows = await agentApps(ctx, url.searchParams.get('agent'));

  return json(rows.map(({ id, value }) => ({ id, value: appRow(ctx, value) })));
}

/** `DELETE /admin/apps/<id>`: forgets a workspace app; its installations end as a platform uninstall ends them. */
export async function removeApp(
  req: Request,
  ctx: ServerContext,
  params: Params,
): Promise<Response> {
  const app = await ctx.store.get('app', params.id!);
  if (!app) return json({ error: 'Unknown app' }, 404);
  if (app.builtin)
    return json({ error: 'Only whoever runs this server can remove its shared apps.' }, 403);

  const now = ctx.now?.() ?? Date.now();
  const rows = await ctx.store.list('installation');
  const removed = new Set(rows.filter(({ value }) => value.app === app.id).map(({ id }) => id));
  for (const { id, value } of rows) {
    if (removed.has(id)) {
      if (!value.deletedAt) await updateMetadata(ctx.store, 'installation', id, { deletedAt: now });
      continue;
    }
    // Sibling links to the removed installations go too.
    const links = Object.entries(value.connections ?? {});
    const kept = links.filter(([, link]) => !removed.has(link.id));
    if (kept.length < links.length)
      await updateMetadata(ctx.store, 'installation', id, {
        connections: kept.length ? Object.fromEntries(kept) : undefined,
      });
  }
  await ctx.store.delete('app', app.id);
  await dropTokens(ctx.store, app.id);

  return json({ ok: true });
}

export async function listInstallations(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const agent = url.searchParams.get('agent');
  const rows = await ctx.store.list('installation', {
    ...(agent ? { agent } : {}),
    ...(url.searchParams.get('active') === '1' ? { active: true } : {}),
    limit: pageLimit(url, 200),
  });

  return json(
    rows.map(({ id, value }) => {
      const { token: _token, connections: _connections, ...safe } = value;

      return { id, value: safe };
    }),
  );
}

/** `?agent=` fills that agent's name into create steps that prefill the platform's form; `?public=1` asks for the public one. */
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
        publicApps: integration.publicApps === true,
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
                public: integration.publicApps === true && url.searchParams.get('public') === '1',
              }),
            }
          : {}),
        ...(unreachable ? { unreachable: true } : {}),
      })),
    ),
  );
}

export async function repositorySnapshot(
  ctx: ServerContext,
  installation: Installation,
  refresh = false,
  access?: { app: AgentApp; token: string; repo: string },
): Promise<Installation | undefined> {
  const current = await ctx.store.get('installation', installation.id);
  if (!current || current.deletedAt) return;
  if (!refresh && current.repos != null && (!access || current.repos.includes(access.repo)))
    return current;

  const integration = ctx.integrations[current.integration];
  if (!integration?.repos) return current;

  const lists = (ctx.repositoryLists ??= new Map());
  let pending = lists.get(current.id);
  if (!pending) {
    pending = listRepositories(ctx, integration, current, access).finally(() =>
      lists.delete(current.id),
    );
    lists.set(current.id, pending);
  }

  return pending;
}

/** Lists an installation's repositories with no store lock held, then saves them unless a webhook changed them meanwhile. */
async function listRepositories(
  ctx: ServerContext,
  integration: Integration,
  read: Installation,
  access?: { app: AgentApp; token: string },
): Promise<Installation | undefined> {
  const app = access?.app ?? (await ctx.store.get('app', read.app));
  if (!app) throw new Error(`Missing app for installation ${read.id}`);
  const token =
    access?.token ??
    (await installationToken(ctx, integration, read, decryptSecret(ctx.config, app.credentials)));
  const repos = await integration.repos!.list(unsealed(ctx, read), token, ctx.fetch ?? fetch);

  return ctx.store.withAppLock(`repositories:${read.id}`, async store => {
    const current = await store.get('installation', read.id);
    if (!current || current.deletedAt) return;
    if (JSON.stringify(current.repos) !== JSON.stringify(read.repos))
      return { ...current, repos: current.repos ?? repos };

    await updateMetadata(store, 'installation', current.id, { repos });

    return { ...current, repos };
  });
}

export async function adminRepositories(ctx: ServerContext, refresh = false): Promise<Response> {
  const seen = new Map<string, { repo: string; integration: string }>();
  for (const { value } of await ctx.store.list('installation', { active: true })) {
    if (value.deletedAt || !ctx.integrations[value.integration]?.repos) continue;
    const installation =
      refresh || value.repos == null
        ? await repositorySnapshot(ctx, value, refresh).catch(error => {
            console.error(`coder server: repositories for installation ${value.id} failed`, error);
            return value;
          })
        : value;
    if (!installation || installation.deletedAt) continue;
    for (const repo of installation.repos ?? [])
      if (!seen.has(repo)) seen.set(repo, { repo, integration: installation.integration });
  }

  return json([...seen.values()].sort((a, b) => a.repo.localeCompare(b.repo)));
}
