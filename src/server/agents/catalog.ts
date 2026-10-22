import { type Params } from '../routes/match';
import { builtinDefinitions, defaultAgent } from '../../agent/load';
import { staleKeys } from '../../agent/definition';
import { type AgentApp } from '../../agent/types';
import {
  agentOrderKey,
  type AgentPageOptions,
  type AgentRecord,
  type AgentVersionRecord,
  type AgentVersionSummary,
} from '../store/types';
import { type ServerContext } from '../context';
import {
  getAgent,
  agentWithVersion,
  getVersion,
  ensureBuiltinAgents,
  agentProblems,
} from './records';
import { syncLocalAgents } from '../store/local';
import { agentApps } from './connections';
import { failedDeliveries } from '../tasks/events';
import { decodeCursor, json, notFound, page, pageLimit, paged } from '../routes/http';
import { agentEngines } from '../settings/credentials';

async function sourceUrl(
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

async function loadAgent(ctx: ServerContext, slug: string, now: number) {
  if (builtinDefinitions()[slug]) await ensureBuiltinAgents(ctx, now);
  return agentWithVersion(ctx.store, slug);
}

export async function prepareAgent(ctx: ServerContext, slug?: string) {
  const now = (ctx.now ?? Date.now)();
  if (!slug || builtinDefinitions()[slug]) await ensureBuiltinAgents(ctx, now);
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

/** Agent records in id order, at most `limit`, in one read where the store can; built-ins are seeded by the caller. */
export async function agentRecords(
  ctx: ServerContext,
  local: Array<{ record: AgentRecord; version?: AgentVersionRecord }> | undefined,
  { after, q, source, platform, limit }: AgentPageOptions & { limit: number },
): Promise<AgentRecord[]> {
  if (!local)
    return (await ctx.store.listAgentSummaries({ after, q, source, platform, limit })).map(
      ({ record }) => record,
    );

  return (local ?? [])
    .filter(({ version }) => !platform || Boolean(version?.definition?.integrations?.[platform]))
    .map(({ record }) => record)
    .filter(
      record =>
        (!after || agentOrderKey(record) > after) &&
        (!source || record.source === source) &&
        (!q ||
          [record.id, record.name, record.description, record.repo].some(value =>
            value?.toLowerCase().includes(q),
          )),
    )
    .sort((a, b) => (agentOrderKey(a) < agentOrderKey(b) ? -1 : 1))
    .slice(0, limit);
}

export async function listAgents(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const fields = url.searchParams.get('fields');
  if (fields && !['id', 'id,name'].includes(fields)) return json({ error: 'Invalid fields' }, 400);
  const { local } = await prepareAgent(ctx);
  if (!local && paged(url) && !fields) return json(await agentsPage(ctx, url));

  const limit = pageLimit(url, 200);
  if (fields) {
    const records = await agentRecords(ctx, local, {
      after: decodeCursor<string>(url),
      q: url.searchParams.get('q')?.trim().toLowerCase(),
      source: AGENT_TYPES[url.searchParams.get('type') ?? ''],
      platform: url.searchParams.get('platform') ?? undefined,
      limit: limit + (paged(url) ? 1 : 0),
    });
    const shape = (record: AgentRecord) =>
      fields === 'id' ? { id: record.id } : { id: record.id, name: record.name };
    const result = page(records, limit, agentOrderKey);
    return json(paged(url) ? { ...result, items: result.items.map(shape) } : records.map(shape));
  }

  const agents = local ?? (await ctx.store.listAgentSummaries({ limit }));
  if (paged(url)) return json(await agentsPage(ctx, url, agents));

  let apps:
    | Promise<
        Array<{
          value: AgentApp;
        }>
      >
    | undefined;

  const preferred = defaultAgent();

  return json(
    await Promise.all(
      agents.slice(0, limit).map(async ({ record, version }) => {
        if (record.source === 'repo' && record.repo) apps ??= ctx.store.list('app');

        const source = await sourceUrl(ctx, record, version, apps);

        return {
          ...record,
          problems: agentProblems(record, version, ctx.integrations),
          ...(record.id === preferred ? { default: true } : {}),
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
  const { local, loadCurrent } = await prepareAgent(ctx, slug);
  const limit = pageLimit(url, 10, 50);
  const below = decodeCursor<number>(url);
  const [record, rows] = await Promise.all([
    local ? loadCurrent().then(row => row.record) : getAgent(ctx.store, slug),
    local
      ? Promise.resolve(local.flatMap(({ version }) => (version ? [{ value: version }] : [])))
      : ctx.store.listVersions(slug, limit + 1, below),
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

  const { local } = await prepareAgent(ctx, slug);
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
  const { local, loadCurrent } = await prepareAgent(ctx, slug);
  const withVersions = url.searchParams.get('versions') !== '0';
  const withContent = url.searchParams.get('content') !== '0';
  const withHandles = url.searchParams.get('handles') === '1';
  const requestedBy = ctx.session?.user.id;
  const [{ record, version: current }, rows, apps, deliveries] = await Promise.all([
    !withContent && !local
      ? ctx.store
          .listAgentSummaries({ slug })
          .then((rows): { record?: AgentRecord; version?: AgentVersionSummary } => rows[0] ?? {})
      : loadCurrent(),
    withVersions
      ? local
        ? local.flatMap(({ version }) => (version ? [{ value: version }] : []))
        : ctx.store.listVersions(slug)
      : [],
    withHandles ? agentApps(ctx, slug) : [],
    withHandles ? failedDeliveries(ctx.store, slug) : undefined,
  ]);
  if (!record) return json({ error: `No agent named "${slug}"` }, 404);

  const { resolved, unrunnable } = withHandles
    ? await agentEngines(
        ctx,
        {
          engine: record.settings?.engine ?? current?.definition.engine,
          model: record.settings?.model ?? current?.definition.model,
        },
        requestedBy,
      )
    : {};

  // The names its apps answer to, once each, where the agent wakes on a mention.
  const wired = current?.definition.integrations ?? {};
  const mentions = (id: string) => {
    const events = wired[id]?.events;
    return Array.isArray(events)
      ? events.includes('mention')
      : Boolean(events && 'mention' in events);
  };
  const handles: Array<{ name: string; integration: string; platform: string }> = [];
  const ids = Object.keys(ctx.integrations);
  const byPlatform = (a: { value: AgentApp }, b: { value: AgentApp }) =>
    ids.indexOf(a.value.integration) - ids.indexOf(b.value.integration);
  for (const { value } of [...apps].sort(byPlatform))
    if (
      mentions(value.integration) &&
      !handles.some(
        handle =>
          handle.integration === value.integration &&
          handle.name.toLowerCase() === value.name.toLowerCase(),
      )
    )
      handles.push({
        name: value.name,
        integration: value.integration,
        platform: ctx.integrations[value.integration]?.name ?? value.integration,
      });

  const versions = rows.map(({ value }) => {
    const { systemPrompt, files, ...metadata } = value as AgentVersionRecord;

    return metadata;
  });
  const source = await sourceUrl(ctx, record, current);

  return json({
    ...record,
    problems: agentProblems(record, current, ctx.integrations),
    ...(current
      ? {
          stale: staleKeys(current.definition),
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
    ...(handles.length ? { handles } : {}),
    ...(deliveries?.failed
      ? {
          deliveries: {
            failed: deliveries.failed,
            recent: deliveries.recent.map(failure => ({
              at: failure.at,
              platform: ctx.integrations[failure.integration]?.name ?? failure.integration,
              ...(failure.type ? { type: failure.type } : {}),
              error: failure.error,
              ...(failure.url ? { url: failure.url } : {}),
            })),
          },
        }
      : {}),
    ...(resolved ? { ...(!resolved.usable ? { needsModel: true } : {}) } : {}),
    ...(unrunnable?.length ? { unrunnable } : {}),
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
  const apps = ctx.store.list('app');
  const [appRows, installations, candidates] = await Promise.all([
    apps,
    ctx.store.list('installation'),
    all
      ? all
          .filter(
            ({ record }) =>
              (!after || agentOrderKey(record) > after) &&
              (!source || record.source === source) &&
              (!q ||
                [record.id, record.name, record.description, record.repo].some(value =>
                  value?.toLowerCase().includes(q),
                )),
          )
          .sort((a, b) => (agentOrderKey(a.record) < agentOrderKey(b.record) ? -1 : 1))
      : ctx.store.listAgentSummaries({
          after,
          source,
          q,
          platform: platform ?? undefined,
          limit: limit + 1,
        }),
  ]);
  const live = new Set(
    installations
      .filter(({ value }) => !value.deletedAt && !value.uninstalled)
      .map(({ value }) => value.app),
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
  const result = page(rows, limit, last => agentOrderKey(last.record));
  const preferred = defaultAgent();

  return {
    ...result,
    items: await Promise.all(
      result.items.map(async ({ record, version, ids }) => {
        const source = await sourceUrl(ctx, record, version, apps);
        return {
          ...record,
          problems: agentProblems(record, version, ctx.integrations),
          ...(record.id === preferred ? { default: true } : {}),
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
  const rows = read ?? (await ctx.store.listVersions(record.id, limit + 1, below));
  const newest = rows
    .map(({ value }) => {
      const { systemPrompt, files, definition, ...metadata } = value as AgentVersionRecord;
      return metadata;
    })
    .filter(version => version.version < below)
    .reverse();

  return page(newest, limit, last => last.version);
}
