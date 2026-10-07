import './top-agents.css';
import { iDown, iUp } from '@/comps/ui/icons';
import { Link } from '@wular/pnext/link';
import { withSearch } from '@/comps/nav/to';
import type { UsageAmount, UsageTotal } from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Icon } from '@/comps/ui/icon';
import { formatMetric, type Metric } from '@/app/dash/usage/metric';

const COLUMNS: Array<[string, string, Metric]> = [
  ['tasks', 'Tasks', 'tasks'],
  ['runner', 'Runner time', 'runnerMs'],
  ['tokens', 'Tokens', 'tokenCount'],
];

/** The leading agents by the sorted column, the rest summed as Other agents, as the chart draws them. */
export function TopAgents({
  rows,
  known,
  other,
  sort,
  range,
  tops,
  metric,
}: {
  rows: UsageTotal[];
  /** Agents this server has; others ran from another folder or were deleted, so they have no page. */
  known: Set<string>;
  other?: UsageAmount;
  sort: string;
  /** The range query, `range=7d` or `from=…&to=…`. */
  range: string;
  /** Agents drawn in the chart, with their colors. */
  tops: Record<string, string>;
  metric: Metric;
}) {
  const max = Math.max(1, other?.[metric] ?? 0, ...rows.map(row => row[metric]));
  const sortSearch = (key: string) => {
    const search = new URLSearchParams(range);
    if (key !== 'tokens') search.set('sort', key);
    return search;
  };
  const cells = (row: UsageAmount) =>
    COLUMNS.map(([key, label, column]) => (
      <td key={key} class="num" data-label={label}>
        {formatMetric(column, row[column])}
      </td>
    ));
  const bar = (value: number, color?: string) => (
    <span
      class={color ? 'bar-in top' : 'bar-in'}
      style={`--w:${Math.max(1, (value / max) * 100)}%${color ? `;--c:${color}` : ''}`}
    />
  );
  return (
    <Card title="Top agents">
      {rows.length ? (
        <div class="table-scroll">
          <table class="rows usage stacked">
            <thead>
              <tr>
                <th>
                  <Link
                    href="/dash/usage"
                    search={sortSearch('name')}
                    scroll={false}
                    aria-current={sort === 'name' ? 'page' : undefined}
                  >
                    Agent
                    {sort === 'name' ? <Icon d={iUp} /> : null}
                  </Link>
                </th>
                {COLUMNS.map(([key, label]) => (
                  <th key={key} class="num">
                    <Link
                      href="/dash/usage"
                      search={sortSearch(key)}
                      scroll={false}
                      aria-current={sort === key ? 'page' : undefined}
                    >
                      {label}
                      {sort === key ? <Icon d={iDown} /> : null}
                    </Link>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map(row => (
                <tr key={row.key}>
                  <td>
                    {row.deleted ? (
                      <span class="unlinked gone" title="Deleted agent">
                        {row.key}
                      </span>
                    ) : known.has(row.key) ? (
                      <Link
                        class="cover"
                        href="/dash/agents/[slug]/usage"
                        params={{ slug: row.key }}
                        search={withSearch(new URLSearchParams(range), {
                          from: `/dash/usage?${range}`,
                        })}
                      >
                        {row.key}
                      </Link>
                    ) : (
                      <span class="unlinked" title="Not an agent on this server">
                        {row.key}
                      </span>
                    )}
                    {bar(row[metric], tops[row.key])}
                  </td>
                  {cells(row)}
                </tr>
              ))}
              {other ? (
                <tr>
                  <td>
                    <Link class="cover" href="/dash/agents">
                      Other agents
                    </Link>
                    {bar(other[metric], 'var(--s0)')}
                  </td>
                  {cells(other)}
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Nothing ran in this range">
          Usage is recorded as tasks finish. Pick a longer range, or run a task.
        </Empty>
      )}
    </Card>
  );
}
