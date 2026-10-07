import { type Params } from '../routes/match';
import { builtinDefinitions } from '../../agent/load';
import { type AgentApp } from '../../agent/types';
import {
  type AgentRecord,
  type AgentVersionRecord,
  type AgentVersionSummary,
} from '../store/types';
import { type ServerContext } from '../context';
import {
  getAgent,
  agentWithVersion,
  agentsWithVersions,
  getVersion,
  seedBuiltinAgent,
  seedBuiltinAgents,
  versionKey,
} from './records';
import { syncLocalAgents } from '../store/local';
import { decodeCursor, json, notFound, page, pageLimit, paged } from '../routes/http';

export async function sourceUrl(
  ctx: ServerContext,
  record: AgentRecord,
  version?: AgentVersionSummary,
  apps?: Promise<Array<{ value: AgentApp }>>,
): Promise<string | undefined> {
  if (record.source !== 'repo' || !record.repo) return undefined;

  const app = (await (apps ?? ctx.store.list('app'))).find(
    ({ value }) => value.agent === record.id && value.agentsRepo === record.repo,
  )?.value;
  const integration =
    (app && ctx.integrations[app.integration]) ??
    Object.values(ctx.integrations).find(entry => entry.repos);

  return integration?.repos?.url(record.repo, record.path, app?.branch ?? version?.commit);
}

export async function loadAgent(ctx: ServerContext, slug: string, now: number) {
  const loaded = await agentWithVersion(ctx.store, slug);
  return (await seedBuiltinAgent(ctx.store, now, slug, loaded))
    ? agentWithVersion(ctx.store, slug)
    : loaded;
}

export async function prepareAgent(ctx: ServerContext, slug?: string) {
  const now = (ctx.now ?? Date.now)();
  // An agent folder the CLI cannot load keeps the last good versions here.
  const local = ctx.local
    ? await syncLocalAgents(ctx.store, ctx.local.cwd, ctx.integrations, slug).catch(() => undefined)
    : undefined;
  const loadCurrent = (): Promise<{ record?: AgentRecord; version?: AgentVersionRecord }> =>
    local
      ? Promise.resolve(local.find(({ record }) => record.id === slug) ?? {})
      : loadAgent(ctx, slug!, now);

  return { now, local, loadCurrent };
}

export async function listAgents(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const versionNumber = params.version ? Number(params.version) : undefined;
  if (params.version && !/^\d+$/.test(url.pathname.split('/').at(-1)!)) return notFound();

  const { now, local, loadCurrent } = await prepareAgent(ctx, slug);
  if (!local && ctx.store.listAgentSummaries) {
    await seedBuiltinAgents(ctx.store, now);
    if (paged(url)) return json(await agentsPage(ctx, url));
  }

  let agents =
    local ??
    (ctx.store.listAgentSummaries
      ? await ctx.store.listAgentSummaries()
      : await agentsWithVersions(ctx.store));
  if (
    !local &&
    !ctx.store.listAgentSummaries &&
    (await seedBuiltinAgents(
      ctx.store,
      now,
      agents as Array<{
        record: AgentRecord;
        version?: AgentVersionRecord;
      }>,
    ))
  )
    agents = await agentsWithVersions(ctx.store);
  if (paged(url)) return json(await agentsPage(ctx, url, agents));

  let apps:
    | Promise<
      Array<{
        value: AgentApp;
      }>
    >
    | undefined;

  return json(
    await Promise.all(
      agents.map(async ({ record, version }) => {
        if (record.source === 'repo' && record.repo) apps ??= ctx.store.list('app');

        const source = await sourceUrl(ctx, record, version, apps);

        return {
          ...record,
          definition: version?.definition,
          ...(source ? { sourceUrl: source } : {}),
        };
      }),
    ),
  );
}

export async function listVersions(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const versionNumber = params.version ? Number(params.version) : undefined;
  if (params.version && !/^\d+$/.test(url.pathname.split('/').at(-1)!)) return notFound();

  const { now, local, loadCurrent } = await prepareAgent(ctx, slug);
  const limit = pageLimit(url, 10, 50);
  const below = decodeCursor<number>(url);
  const [record, rows] = await Promise.all([
    local ? loadCurrent().then(row => row.record) : getAgent(ctx.store, slug),
    local
      ? Promise.resolve(local.flatMap(({ version }) => (version ? [{ value: version }] : [])))
      : ctx.store.listVersions?.(slug, limit + 1, below),
  ]);
  if (!record) return json({ error: `No agent named "${slug}"` }, 404);

  return json(await versionsPage(ctx, record, limit, below ?? record.currentVersion + 1, rows));
}

export async function readVersion(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const versionNumber = params.version ? Number(params.version) : undefined;
  if (params.version && !/^\d+$/.test(url.pathname.split('/').at(-1)!)) return notFound();

  const { now, local, loadCurrent } = await prepareAgent(ctx, slug);
  const version = local
    ? local.find(({ version }) => version?.version === versionNumber)?.version
    : await getVersion(ctx.store, slug, versionNumber);

  return version
    ? json(version)
    : json({ error: `No version ${versionNumber} for agent "${slug}"` }, 404);
}

export async function readAgent(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const slug = params.slug!;
  const versionNumber = params.version ? Number(params.version) : undefined;
  if (params.version && !/^\d+$/.test(url.pathname.split('/').at(-1)!)) return notFound();

  const { now, local, loadCurrent } = await prepareAgent(ctx, slug);
  const withVersions = url.searchParams.get('versions') !== '0';
  const withContent = url.searchParams.get('content') !== '0';
  const [{ record, version: current }, rows] = await Promise.all([
    !withContent && !local && ctx.store.listAgentSummaries && !builtinDefinitions()[slug]
      ? ctx.store
        .listAgentSummaries({ slug })
        .then((rows): { record?: AgentRecord; version?: AgentVersionSummary } => rows[0] ?? {})
      : loadCurrent(),
    withVersions
      ? local
        ? local.flatMap(({ version }) => (version ? [{ value: version }] : []))
        : ctx.store.listVersions
          ? ctx.store.listVersions(slug)
          : ctx.store.list('agentversion', { prefix: `${slug}:` })
      : [],
  ]);
  if (!record) return json({ error: `No agent named "${slug}"` }, 404);

  const versions = rows.map(({ value }) => {
    const { systemPrompt, files, ...metadata } = value as AgentVersionRecord;

    return metadata;
  });
  const source = await sourceUrl(ctx, record, current);

  return json({
    ...record,
    ...(current
      ? {
        definition: current.definition,
        ...(withContent && 'systemPrompt' in current
          ? {
            systemPrompt: current.systemPrompt,
            ...((current as AgentVersionRecord).files
              ? { files: (current as AgentVersionRecord).files }
              : {}),
          }
          : {}),
      }
      : {}),
    ...(source ? { sourceUrl: source } : {}),
    ...(withVersions ? { versions } : {}),
  });
}

type Reach = 'installed' | 'created' | 'none';

const AGENT_TYPES: Record<string, AgentRecord['source']> = {
  builtin: 'builtin',
  dashboard: 'upload',
  repository: 'repo',
};

export async function agentsPage(
  ctx: ServerContext,
  url: URL,
  all?: Array<{ record: AgentRecord; version?: AgentVersionSummary }>,
) {
  const limit = pageLimit(url, 24, 100);
  const after = decodeCursor<string>(url);
  const q = url.searchParams.get('q')?.trim().toLowerCase();
  const source = AGENT_TYPES[url.searchParams.get('type') ?? ''];
  const platform = url.searchParams.get('platform');
  const connect = url.searchParams.get('connect') === '1';
  const server = ctx.serverOrganizationId;
  const apps = ctx.store.list('app');
  const [appRows, installations, shared, candidates] = await Promise.all([
    apps,
    ctx.store.list('installation'),
    connect && server !== undefined && server !== ctx.organizationId && ctx.scope
      ? ctx.scope(server).store.list('app')
      : [],
    all
      ? all.filter(
        ({ record }) =>
          (!after || record.id > after) &&
          (!source || record.source === source) &&
          (!q ||
            [record.id, record.name, record.description, record.repo].some(value =>
              value?.toLowerCase().includes(q),
            )),
      )
      : ctx.store.listAgentSummaries!({
        after,
        source,
        q,
        platform: platform ?? undefined,
        limit: limit + 1,
      }),
  ]);
  const live = new Set(
    installations.filter(({ value }) => !value.deletedAt).map(({ value }) => value.app),
  );
  const reach = (agent: string, integration: string): Reach => {
    const own = appRows.filter(
      ({ value }) => value.agent === agent && value.integration === integration,
    );
    if (!own.length) return 'none';
    return own.some(({ value }) => live.has(value.id)) ? 'installed' : 'created';
  };
  const rows = [];

  for (const { record, version } of candidates) {
    const ids = Object.keys(version?.definition?.integrations ?? {}).sort();
    if (platform && !ids.includes(platform)) continue;
    rows.push({ record, version, ids });
    if (rows.length > limit) break;
  }
  const result = page(rows, limit, last => last.record.id);

  return {
    ...result,
    ...(connect
      ? {
        connectable: [
          ...appRows,
          ...shared.map(row => ({ ...row, value: { ...row.value, builtin: true } })),
        ]
          .filter(({ value }) => value.builtin && !live.has(value.id))
          .map(({ value }) => ({ id: value.id, integration: value.integration })),
      }
      : {}),
    items: await Promise.all(
      result.items.map(async ({ record, version, ids }) => {
        const source = await sourceUrl(ctx, record, version, apps);
        return {
          ...record,
          definition: version?.definition,
          ...(source ? { sourceUrl: source } : {}),
          platforms: ids.map(id => ({ id, state: reach(record.id, id) })),
        };
      }),
    ),
  };
}

async function versionsPage(
  ctx: ServerContext,
  record: AgentRecord,
  limit: number,
  below: number,
  read?: Array<{ value: AgentVersionSummary }>,
) {
  const from = below - limit - 2;
  const rows =
    read ??
    (await ctx.store.list('agentversion', {
      prefix: `${record.id}:`,
      ...(from > 0 ? { after: versionKey(record.id, from) } : {}),
      limit: limit + 1,
    }));
  const newest = rows
    .map(({ value }) => {
      const { systemPrompt, files, definition, ...metadata } = value as AgentVersionRecord;
      return metadata;
    })
    .filter(version => version.version < below)
    .reverse();

  return page(newest, limit, last => last.version);
}
