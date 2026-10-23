import { savedAppTokens, appSpec } from './platform';
import { definitionEvents } from '../../agent/definition';
import { decryptSecret } from '../store/secrets';
import { type Params } from '../routes/match';
import { encodeJson } from '../../utils/crypto';
import { issueNonce } from '../auth/nonce';
import { type ServerContext } from '../context';
import { sharedApps } from './apps';
import { nativeApp } from '../connections/records';
import { agentWithVersion, getVersion, seedBuiltinAgent } from './records';
import { checkApp, inSync, syncApps, syncKey, syncManifest, type SyncMarker } from './repo';
import { json, pageLimit } from '../routes/http';
import { LOOPBACK } from '../routes/guards';
import { updateMetadata } from '../store';
import { dropTokens, installationToken, uninstall, unsealed } from '../tasks/context';
import { audit } from '../operator';
import type { Installation, AgentApp } from '../../agent/types';
import type { Integration } from '../../integrations/types';

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
              ({ value }) => value.builtin && ctx.integrations[value.integration]?.app.shareable,
            ),
          )
      : [],
  ]);

  return [...own, ...shared].filter(
    ({ value }) =>
      (!value.builtin || ctx.integrations[value.integration]?.app.shareable) &&
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

/** How an integration's apps come up to date: Coder pushes them, or shows what to change on the platform. */
export const appUpdateOf = (integration: Integration) =>
  integration.app.update
    ? { appUpdate: 'push' as const }
    : integration.app.drift
      ? { appUpdate: 'drift' as const }
      : integration.app.values
        ? { appUpdate: 'confirm' as const }
        : {};

/** Apps changed since their last update, from their sync markers alone; no platform call; `shared` takes the server's own. */
export async function changedApps(
  ctx: ServerContext,
  apps: AgentApp[],
  shared = false,
): Promise<Set<string>> {
  const publicUrl = ctx.config.publicUrl;
  const own = apps.filter(
    app => (shared || (!app.builtin && !app.shared)) && ctx.integrations[app.integration]?.app,
  );
  if (!publicUrl || !own.length) return new Set();

  const [markers, versions] = await Promise.all([
    ctx.store.list('delivery', { ids: own.map(app => syncKey(app.id)) }),
    ctx.store.listAgentsWithVersions([...new Set(own.map(app => app.agent))]),
  ]);
  const marker = (id: string) =>
    markers.find(entry => entry.id === syncKey(id))?.value as SyncMarker | undefined;

  return new Set(
    own
      .filter(app => {
        const platform = ctx.integrations[app.integration]!.app;
        const version = versions.find(entry => entry.record.id === app.agent)?.version;
        if (!version?.definition.integrations[app.integration]) return false;
        if (!platform.update) return marker(app.id)?.changed === true;

        return !inSync(
          marker(app.id),
          version.version,
          syncManifest(platform, app, publicUrl, version.definition),
        );
      })
      .map(app => app.id),
  );
}

export async function listApps(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const rows = await agentApps(ctx, url.searchParams.get('agent'));
  const changed = await changedApps(
    ctx,
    rows.map(({ value }) => value),
  );

  return json(
    rows.map(({ id, value }) => ({
      id,
      value: { ...appRow(ctx, value), ...(changed.has(id) ? { changed: true } : {}) },
    })),
  );
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
  for (const { id, value } of await ctx.store.list('installation'))
    if (value.app === app.id && !value.deletedAt)
      await updateMetadata(ctx.store, 'installation', id, { deletedAt: now });
  await ctx.store.delete('app', app.id);
  await dropTokens(ctx.store, app.id);

  return json({ ok: true });
}

/** `DELETE /admin/installations/<id>`: uninstalls the app on its platform, then ends the installation as the platform's own uninstall does. */
export async function uninstallApp(
  req: Request,
  ctx: ServerContext,
  params: Params,
): Promise<Response> {
  const installation = await ctx.store.get('installation', params.id!);
  if (!installation || installation.deletedAt) return json({ error: 'Unknown installation' }, 404);

  const app = await ctx.store.get('app', installation.app);
  const integration = ctx.integrations[installation.integration];
  if (!app || !integration?.app.uninstall)
    return json(
      { error: `Coder cannot uninstall ${integration?.name ?? installation.integration} apps.` },
      400,
    );

  try {
    await integration.app.uninstall(
      unsealed(ctx, installation),
      decryptSecret(ctx.config, app.credentials),
      { fetch: ctx.fetch ?? fetch },
    );
  } catch (error) {
    console.error(`coder server: uninstalling ${installation.id} failed`, error);
    const url = integration.app.installationUrl?.(installation);

    return json(
      {
        error: `${error instanceof Error ? error.message : String(error)}. Uninstall ${app.name} on ${integration.name} instead.`,
        ...(url ? { hint: url } : {}),
      },
      502,
    );
  }
  await uninstall(ctx.store, installation.id, (ctx.now ?? Date.now)());
  await audit(
    ctx,
    'Uninstalled an app',
    `${app.name} from ${installation.account.login} on ${integration.name}`,
  );

  return json({ ok: true });
}

/** A workspace app with its agent's current version, or why Coder cannot bring it up to date. */
/** An app to bring up to date, with its agent's version; `shared` is the operator's, for the server's own apps. */
async function outdatedApp(ctx: ServerContext, id: string, shared = false) {
  const app = await ctx.store.get('app', id);
  if (!app) return json({ error: 'Unknown app' }, 404);
  if ((app.builtin || app.shared) && !shared)
    return json({ error: 'Only whoever runs this server can update its shared apps.' }, 403);

  if (!ctx.config.publicUrl) return json({ error: 'PUBLIC_URL is not set on this server' }, 400);
  const integration = ctx.integrations[app.integration];
  if (!integration || !(integration.app.update || integration.app.drift || integration.app.values))
    return json(
      { error: `Coder cannot update ${integration?.name ?? app.integration} apps.` },
      400,
    );
  // The server's organization runs no tasks, so its copy of the built-in agent is seeded here.
  if (shared)
    await seedBuiltinAgent(
      ctx.store,
      (ctx.now ?? Date.now)(),
      app.agent,
      await agentWithVersion(ctx.store, app.agent),
    );
  const version = await getVersion(ctx.store, app.agent);
  if (!version?.definition.integrations[app.integration])
    return json({ error: `The agent no longer listens on ${integration.name}.` }, 400);

  return { app, version, integration };
}

/** `GET /admin/apps/<id>/drift`: what to change on the platform by hand, checked now. */
export async function readDrift(
  req: Request,
  ctx: ServerContext,
  params: Params,
  _url?: URL,
  shared = false,
): Promise<Response> {
  const found = await outdatedApp(ctx, params.id!, shared);
  if (found instanceof Response) return found;
  if (found.integration.app.update)
    return json({ error: `Coder updates ${found.integration.name} apps itself.` }, 400);

  try {
    return json(await checkApp(ctx, ctx.store, found.app, found.version));
  } catch (error) {
    console.error(
      `coder server: reading ${found.app.id} on ${found.integration.name} failed`,
      error,
    );
    return json({ error: error instanceof Error ? error.message : String(error) }, 502);
  }
}

/** `POST /admin/apps/<id>/update`: pushes the app to its platform now, or records that its values were entered there by hand. */
export async function updateApp(
  req: Request,
  ctx: ServerContext,
  params: Params,
  _url?: URL,
  shared = false,
): Promise<Response> {
  const found = await outdatedApp(ctx, params.id!, shared);
  if (found instanceof Response) return found;
  const { app, version, integration } = found;

  if (integration.app.values) {
    const { lines } = integration.app.values(app, {
      publicUrl: ctx.config.publicUrl!,
      spec: appSpec(version.definition, app.agent, app.integration),
    });
    await ctx.store.put('delivery', syncKey(app.id), {
      version: version.version,
      manifest: lines,
      changed: false,
    });
    return json({ updated: true });
  }
  if (!integration.app.update)
    return json({ error: `Change the app on ${integration.name}; Coder cannot.` }, 400);

  const [synced] = await syncApps(ctx, [version], app.id);
  return synced?.error ? json({ error: synced.error }, 502) : json({ updated: true });
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
    ...(url.searchParams.get('active') === '1' ? { active: true, includeUninstalled: true } : {}),
    limit: pageLimit(url, 200),
  });

  return json(
    rows.map(({ id, value }) => {
      const { token: _token, ...safe } = value;
      const app = ctx.integrations[value.integration]?.app;
      const url = value.account.url ?? app?.accountUrl?.(value.account);
      const installationUrl = app?.installationUrl?.(value);

      return {
        id,
        value: {
          ...safe,
          account: { ...safe.account, ...(url ? { url } : {}) },
          ...(installationUrl ? { installationUrl } : {}),
        },
      };
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
  const ownRead = ctx.store.list('app');
  const [loaded, apps, own] = await Promise.all([
    agent ? agentWithVersion(ctx.store, agent) : undefined,
    sharedApps(ctx, ownRead),
    ownRead,
  ]);
  const record = loaded?.record;
  const shared = new Set(apps.map(app => app.integration));

  return json(
    await Promise.all(
      Object.values(ctx.integrations).map(async integration => {
        const use =
          typeof integration.use === 'function'
            ? integration.use(
                definitionEvents(loaded?.version?.definition.integrations[integration.id]),
              )
            : integration.use;
        return {
          id: integration.id,
          name: integration.name,
          brand: integration.brand,
          description: integration.description,
          installLabel: integration.installLabel ?? `Connect ${integration.id}`,
          ...(use ? { use } : {}),
          ...(integration.covered ? { covered: integration.covered } : {}),
          ...(integration.featured ? { featured: true } : {}),
          builtinApp: integration.app.shareable ? 'shared' : 'own',
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
          repositories: Boolean(integration.repos),
          ...(integration.app.createStep && base
            ? {
                create: integration.app.createStep(base, {
                  saved: await savedAppTokens(ctx, integration.id),
                  name: record?.name,
                  shared: shared.has(integration.id),
                  public: integration.publicApps === true && url.searchParams.get('public') === '1',
                }),
              }
            : {}),
          ...(unreachable ? { unreachable: true } : {}),
          ...appUpdateOf(integration),
        };
      }),
    ),
  );
}

export async function repositorySnapshot(
  ctx: ServerContext,
  installation: Installation,
  refresh = false,
  access?: { app: AgentApp; token: string; repo: string },
): Promise<Installation | undefined> {
  const current = installation;
  if (current.deletedAt) return;
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
  const rows = (await ctx.store.list('installation', { active: true })).filter(
    ({ value }) => ctx.integrations[value.integration]?.repos,
  );
  const installations: Array<Installation | undefined> = new Array(rows.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, rows.length) }, async () => {
      for (let i = next++; i < rows.length; i = next++) {
        const value = rows[i]!.value;
        installations[i] =
          refresh || value.repos == null
            ? await repositorySnapshot(ctx, value, refresh).catch(error => {
                console.error(
                  `coder server: repositories for installation ${value.id} failed`,
                  error,
                );
                return value;
              })
            : value;
      }
    }),
  );
  for (const installation of installations) {
    if (!installation || installation.deletedAt) continue;
    for (const repo of installation.repos ?? [])
      if (!seen.has(repo)) seen.set(repo, { repo, integration: installation.integration });
  }

  return json([...seen.values()].sort((a, b) => a.repo.localeCompare(b.repo)));
}
