import '@/comps/ui/segmented.css';
import '@/app/dash/usage/range-bar.css';
import './usage.css';
import { formatCount, formatDuration, zoneOf } from '@/utils/format';
import { daysIn, rangeFor } from '@/utils/range';
import { load } from '@/api/load';
import type { UsageAmount, UsagePage } from '@coder/client/types';
import { Card } from '@/comps/ui/card';
import { Page, PageHead } from '@/comps/frame/page-head';
import { Stat, Stats } from '@/app/dash/usage/stats';
import { Settle } from '@/comps/frame/stream';
import { HEADS } from '@/comps/frame/heads';
import { TopAgents } from './top-agents';
import { DayChart, type Series } from '@/app/dash/usage/day-chart';
import { RangeBar } from '@/app/dash/usage/range-bar';
import { METRIC_LABEL, type Metric } from '@/app/dash/usage/metric';

const SORT_METRIC: Record<string, Metric> = {
  tasks: 'tasks',
  runner: 'runnerMs',
  tokens: 'tokenCount',
  name: 'tokenCount',
};
const COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)'];
const TOP_AGENTS = 10;

export default function UsagePage({ request }: { request?: Request }) {
  if (!request) return null;
  const url = new URL(request.url);
  const tz = zoneOf(request);
  const range = rangeFor(request, tz);
  const asked = url.searchParams.get('sort') ?? '';
  const sort = Object.hasOwn(SORT_METRIC, asked) ? asked : 'tokens';
  const metric = SORT_METRIC[sort]!;

  const first = load(request).usage({
    by: 'agent',
    cursor: '',
    since: range.since,
    until: range.until,
    limit: TOP_AGENTS,
    sort,
  });
  const agents = load(request).agents.list();
  const days = load(request).usage({
    by: 'day',
    since: range.since,
    until: range.until,
    tz,
    top: 4,
    sort: sort === 'name' ? 'tokens' : sort,
  });

  return (
    <Page>
      <PageHead {...HEADS.usage} />
      <RangeBar
        range={range}
        to={{ href: '/dash/usage', params: {}, search: sort === 'tokens' ? undefined : { sort } }}
        tz={tz}
      />
      <Settle
        load={() =>
          Promise.all([first, days, agents]).then(([page, chart, known]) => {
            const { summary, items } = page;
            const series = (chart.top ?? []).map((key, index): Series => ({
              key,
              label: key,
              color: COLORS[index]!,
            }));
            const shown = (key: keyof UsageAmount) => items.reduce((sum, row) => sum + row[key], 0);
            return (
              <>
                <Stats label="Totals">
                  <Stat label="Agents" value={formatCount(summary.agents)} />
                  <Stat label="Tasks" value={formatCount(summary.tasks)} />
                  <Stat label="Runner time" value={formatDuration(summary.runnerMs)} />
                  <Stat label="Tokens" value={formatCount(summary.tokenCount)} />
                </Stats>
                {summary.tasks ? (
                  <Card title={`${METRIC_LABEL[metric]} per day`}>
                    <div class="body">
                      <DayChart
                        days={daysIn(range, tz)}
                        totals={chart.totals}
                        metric={metric}
                        series={series}
                        label={`${METRIC_LABEL[metric]} per day, top agents stacked`}
                      />
                    </div>
                  </Card>
                ) : null}
                <TopAgents
                  rows={items}
                  known={new Set(known.map(agent => agent.id))}
                  other={
                    summary.agents > items.length
                      ? {
                          tasks: summary.tasks - shown('tasks'),
                          runnerMs: summary.runnerMs - shown('runnerMs'),
                          tokenCount: summary.tokenCount - shown('tokenCount'),
                        }
                      : undefined
                  }
                  sort={sort}
                  range={range.query}
                  tops={Object.fromEntries(series.map(entry => [entry.key, entry.color]))}
                  metric={metric}
                />
              </>
            );
          })
        }
      />
    </Page>
  );
}
