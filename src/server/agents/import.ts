import { type Params } from '../routes/match';
import { getApps } from '../store';
import { type ServerContext } from '../context';
import { getAgent, getVersion } from './records';
import {
  updateApps,
  AGENTS_DIR,
  importRepoAgents,
  type Contents,
  type RepositoryAccess,
} from './repo';
import { json } from '../routes/http';
import { decryptSecret } from '../store/secrets';

async function access(ctx: ServerContext, repo: string): Promise<RepositoryAccess | undefined> {
  const installations = (await ctx.store.list('installation')).filter(
    ({ value }) => !value.deletedAt && ctx.integrations[value.integration]?.repos,
  );
  const apps = new Map(
    (
      await getApps(
        ctx.store,
        installations.map(({ value }) => value.app),
      )
    ).map(({ id, value }) => [id, value]),
  );

  for (const { value: installation } of installations) {
    const integration = ctx.integrations[installation.integration];
    if (installation.deletedAt || !integration?.repos) continue;
    const app = apps.get(installation.app);
    if (!app || app.integration !== integration.id) continue;
    try {
      const plain = installation.token
        ? { ...installation, token: decryptSecret<string>(ctx.config, installation.token) }
        : installation;
      const token = await integration.auth.token(plain, decryptSecret(ctx.config, app.credentials));
      if ((await integration.repos.list(plain, token)).includes(repo))
        return { contents: integration as Contents, token, app, installation };
    } catch {}
  }

  return undefined;
}

async function preview(ctx: ServerContext, repo: string, ref: string): Promise<Response> {
  const reach = await access(ctx, repo);
  if (!reach) return json({ error: `No installed app can read ${repo}` }, 400);
  const slugs = await reach.contents.repos
    .listDir(repo, AGENTS_DIR, reach.token, ref)
    .catch(() => [] as string[]);
  const agents = await Promise.all(
    slugs.map(async id => {
      const raw = await reach.contents.repos
        .readFile(repo, `${AGENTS_DIR}/${id}/agent.json`, reach.token, ref)
        .catch(() => undefined);
      if (raw === undefined) return undefined;
      let definition: { name?: unknown; description?: unknown } = {};
      try {
        definition = JSON.parse(raw);
      } catch {}
      const record = await getAgent(ctx.store, id);
      const tracked = record?.source === 'repo' && record.repo === repo;
      const version = tracked ? await getVersion(ctx.store, id) : undefined;
      return {
        id,
        name: typeof definition.name === 'string' ? definition.name : id,
        ...(typeof definition.description === 'string'
          ? { description: definition.description }
          : {}),
        ...(tracked
          ? {
              version: record.currentVersion,
              ...(version?.source ? { commit: version.source.commit } : {}),
            }
          : {}),
        ...(record && !tracked ? { taken: true } : {}),
      };
    }),
  );
  return json({ repo, agents: agents.filter(Boolean) });
}

export async function previewImport(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const repo = url.searchParams.get('repo');
  if (!repo) return json({ error: 'repo is required' }, 400);

  return preview(ctx, repo, url.searchParams.get('ref') || 'HEAD');
}

export async function importAgent(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const body = (await req.json().catch(() => undefined)) as
    | {
        repo?: unknown;
        ref?: unknown;
        agents?: unknown;
      }
    | undefined;
  const agents = body?.agents;
  if (
    typeof body?.repo !== 'string' ||
    (body.ref !== undefined && typeof body.ref !== 'string') ||
    (agents !== undefined && !(Array.isArray(agents) && agents.every(id => typeof id === 'string')))
  )
    return json({ error: 'repo is required, ref must be a string and agents a list of ids' }, 400);

  try {
    const reach = await access(ctx, body.repo);
    if (!reach) return json({ error: `No installed app can read ${body.repo}` }, 400);

    const ref = body.ref ?? 'HEAD';
    const slugs =
      (agents as string[] | undefined) ??
      (await reach.contents.repos.listDir(body.repo, AGENTS_DIR, reach.token, ref));
    for (const id of slugs) {
      const record = await getAgent(ctx.store, id);
      if (record && (record.source !== 'repo' || record.repo !== body.repo))
        return json({ error: `Agent id "${id}" is already taken` }, 409);
    }

    const versions = await importRepoAgents(
      ctx.store,
      reach.contents,
      body.repo,
      ref,
      reach.token,
      (ctx.now ?? Date.now)(),
      { slugs },
    );
    await updateApps(ctx, versions);

    return json({ imported: versions.map(version => version.agent) });
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : String(error) }, 400);
  }
}
