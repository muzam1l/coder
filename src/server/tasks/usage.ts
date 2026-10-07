import { type Params } from '../routes/match';
import { builtinDefinitions, loadAgents } from '../../agent/load';
import { type ServerContext } from '../context';
import { syncLocalUsage } from './local';
import { json, decodeCursor, page, pageLimit, paged } from '../routes/http';
import { usageTotals as sumUsage } from './usage';
import {
  type UsageRecord,
  type Store,
  type UsageAmount,
  type UsageQuery,
  type UsageTotalRow,
} from '../store/types';

/** A recorded token usage's `total`, else every number in it summed; arrays are not counted. */
function countTokens(value: unknown): number {
  if (typeof value === 'number') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 0;
  if ('total' in value && typeof value.total === 'number') return value.total;
  return Object.values(value).reduce<number>((sum, entry) => sum + countTokens(entry), 0);
}

/** A known IANA zone, or UTC. */
export function timeZone(value?: string | null): string {
  if (!value) return 'UTC';
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return value;
  } catch {
    return 'UTC';
  }
}

export const addUsage = (total: UsageAmount, row: UsageAmount) => {
  total.tasks += row.tasks;
  total.runnerMs += row.runnerMs;
  total.tokenCount += row.tokenCount;
};

/** Usage in a range grouped by one key, keys ascending. */
export async function usageTotals(store: Store, query: UsageQuery): Promise<UsageTotalRow[]> {
  if (store.usageTotals) return store.usageTotals(query);
  if (query.top) {
    const { top, ...rest } = query;
    const leaders = (await usageTotals(store, { ...rest, by: 'agent', parts: undefined }))
      .sort((a, b) => b[top.by] - a[top.by] || a.key.localeCompare(b.key))
      .slice(0, top.count)
      .map(row => row.key);
    return usageTotals(store, { ...rest, parts: leaders });
  }

  const zone = timeZone(query.tz);
  const dayFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = new Set(query.parts);
  const totals = new Map<string, UsageTotalRow>();

  for (const { value: row } of await store.list('usage')) {
    if (row.at < query.since || (query.until !== undefined && row.at >= query.until)) continue;
    if (query.agent && row.agent !== query.agent) continue;
    const key =
      query.by === 'agent'
        ? row.agent
        : query.by === 'installation'
          ? (row.installationId ?? 'none')
          : query.by === 'engine'
            ? (row.engine ?? 'unknown')
            : dayFormat.format(row.at);
    const amount = {
      tasks: 1,
      runnerMs: row.runnerElapsedMs,
      tokenCount: countTokens(row.tokens),
    };
    const total = totals.get(key) ?? {
      key,
      tasks: 0,
      runnerMs: 0,
      tokenCount: 0,
    };
    addUsage(total, amount);
    if (parts.has(row.agent)) {
      total.parts ??= {};
      addUsage((total.parts[row.agent] ??= { tasks: 0, runnerMs: 0, tokenCount: 0 }), amount);
    }
    totals.set(key, total);
  }

  return [...totals.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** The agents broken out of a report's rows, leading first. */
export function leaders(rows: UsageTotalRow[], by: keyof UsageAmount): string[] {
  const sums = new Map<string, number>();
  for (const row of rows)
    for (const [agent, part] of Object.entries(row.parts ?? {}))
      sums.set(agent, (sums.get(agent) ?? 0) + part[by]);
  return [...sums].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([agent]) => agent);
}

export type UsageGroup = 'agent' | 'installation' | 'engine';

export type UsageTotal = { key: string; tasks: number; runnerMs: number; tokens?: unknown };

export type UsageTotals = {
  since: number;
  totals: UsageTotal[] | Record<UsageGroup, UsageTotal[]>;
};

function addTokens(left: unknown, right: unknown): unknown {
  if (typeof right === 'number') return (typeof left === 'number' ? left : 0) + right;
  if (!right || typeof right !== 'object' || Array.isArray(right)) return left;
  const out: Record<string, unknown> =
    left && typeof left === 'object' && !Array.isArray(left)
      ? { ...(left as Record<string, unknown>) }
      : {};
  for (const [key, value] of Object.entries(right)) out[key] = addTokens(out[key], value);
  return out;
}

function groupTotals(rows: UsageRecord[], by: UsageGroup): UsageTotal[] {
  const totals = new Map<string, UsageTotal>();
  for (const row of rows) {
    const key =
      by === 'agent'
        ? row.agent
        : by === 'installation'
          ? (row.installationId ?? 'none')
          : (row.engine ?? 'unknown');
    const total = totals.get(key) ?? { key, tasks: 0, runnerMs: 0 };
    total.tasks++;
    total.runnerMs += row.runnerElapsedMs;
    if (row.tokens !== undefined) total.tokens = addTokens(total.tokens, row.tokens);
    totals.set(key, total);
  }
  return [...totals.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Completed-task usage since `since`, grouped one way or all three. */
export function usageSummary(rows: UsageRecord[], since: number, by?: UsageGroup): UsageTotals {
  const recent = rows.filter(row => row.at >= since);
  return {
    since,
    totals: by
      ? groupTotals(recent, by)
      : {
          agent: groupTotals(recent, 'agent'),
          installation: groupTotals(recent, 'installation'),
          engine: groupTotals(recent, 'engine'),
        },
  };
}

const USAGE_MEASURE: Record<string, 'tasks' | 'runnerMs' | 'tokenCount'> = {
  tasks: 'tasks',
  runner: 'runnerMs',
  tokens: 'tokenCount',
};

const USAGE_SORT: Record<string, (row: UsageTotalRow) => number | string> = {
  tokens: row => row.tokenCount,
  tasks: row => row.tasks,
  runner: row => row.runnerMs,
  name: row => row.key,
};

export async function usageReport(ctx: ServerContext, url: URL): Promise<Response> {
  const param = (name: string) => url.searchParams.get(name);
  const since = Number(param('since') ?? 0);
  const until = param('until') === null ? undefined : Number(param('until'));
  const by = param('by') ?? 'agent';
  if (
    !Number.isFinite(since) ||
    (until !== undefined && !Number.isFinite(until)) ||
    !['agent', 'installation', 'engine', 'day'].includes(by)
  )
    return json({ error: 'Invalid usage query' }, 400);
  const parts = param('parts')?.split(',').filter(Boolean);
  const top = Math.min(Number(param('top') ?? 0), 8);
  const measure = USAGE_MEASURE[param('sort') ?? 'tokens'] ?? 'tokenCount';
  const totals = await sumUsage(ctx.store, {
    by: by as 'agent' | 'installation' | 'engine' | 'day',
    since,
    ...(until !== undefined ? { until } : {}),
    ...(param('agent') ? { agent: param('agent')! } : {}),
    ...(by === 'day' ? { tz: timeZone(param('tz')) } : {}),
    ...(parts?.length ? { parts: parts.slice(0, 20) } : {}),
    ...(top > 0 ? { top: { count: top, by: measure } } : {}),
  });
  const range = { since, ...(until !== undefined ? { until } : {}) };
  if (by === 'agent') {
    const present = new Set(
      ctx.local
        ? (await loadAgents(ctx.local.cwd, ctx.integrations)).map(agent => agent.id)
        : (await ctx.store.list('agent')).map(agent => agent.id),
    );
    for (const id of Object.keys(builtinDefinitions())) present.add(id);
    for (const row of totals) if (!present.has(row.key)) row.deleted = true;
  }
  if (top > 0) return json({ ...range, totals, top: leaders(totals, measure) });
  if (!paged(url) || by !== 'agent') return json({ ...range, totals });

  const sort = USAGE_SORT[param('sort') ?? 'tokens'] ?? USAGE_SORT.tokens!;
  const ascending = param('sort') === 'name';
  const q = param('q')?.trim().toLowerCase();
  const order = ([x, a]: [number | string, string], [y, b]: [number | string, string]) =>
    (x < y ? -1 : x > y ? 1 : 0) * (ascending ? 1 : -1) || a.localeCompare(b);
  const tuple = (row: UsageTotalRow): [number | string, string] => [sort(row), row.key];
  const after = decodeCursor<[number | string, string]>(url);
  const sorted = totals
    .filter(row => !q || row.key.toLowerCase().includes(q))
    .filter(row => !after || order(tuple(row), after) > 0)
    .sort((a, b) => order(tuple(a), tuple(b)));
  const limit = pageLimit(url);
  const sum = (pick: (row: UsageTotalRow) => number) =>
    totals.reduce((total, row) => total + pick(row), 0);
  return json({
    ...range,
    ...page(sorted.slice(0, limit + 1), limit, tuple),
    summary: {
      agents: totals.length,
      tasks: sum(row => row.tasks),
      runnerMs: sum(row => row.runnerMs),
      tokenCount: sum(row => row.tokenCount),
    },
  });
}

export async function readUsage(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  if (ctx.local) await syncLocalUsage(ctx);

  const installation = url.searchParams.get('installation');
  const usage = await ctx.store.list('usage');

  return json(
    installation ? usage.filter(entry => entry.value.installationId === installation) : usage,
  );
}

export async function readUsageTotals(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  if (ctx.local) await syncLocalUsage(ctx);

  const since = Number(url.searchParams.get('since') ?? 0);
  const by = url.searchParams.get('by');
  if (
    ['until', 'agent', 'tz', 'parts', 'top', 'cursor'].some(name => url.searchParams.has(name)) ||
    by === 'day'
  )
    return usageReport(ctx, url);
  if (!Number.isFinite(since) || (by && !['agent', 'installation', 'engine'].includes(by)))
    return json({ error: 'Invalid usage query' }, 400);

  const rows = (await ctx.store.list('usage')).map(entry => entry.value);

  return json(usageSummary(rows, since, by as UsageGroup | undefined));
}
