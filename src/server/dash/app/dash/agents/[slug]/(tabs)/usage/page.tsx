import '@/comps/ui/segmented.css';
import '@/app/dash/usage/range-bar.css';
import './page.css';
import { formatCount, formatDuration, zoneOf } from '@/utils/format';
import { daysIn, rangeFor } from '@/utils/range';
import { load } from '@/api/load';
import type { UsageTotal } from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Stat, Stats } from '@/app/dash/usage/stats';
import { Settle } from '@/comps/frame/stream';
import { unwrap } from '@/api/load';
import { DayChart } from '@/app/dash/usage/day-chart';
import { RangeBar } from '@/app/dash/usage/range-bar';

function Breakdown({
  title,
  head,
  rows,
  label,
}: {
  title: string;
  head: string;
  rows: UsageTotal[];
  label: (key: string) => { name: string; sub?: string };
}) {
  const sorted = [...rows].sort((a, b) => b.tokenCount - a.tokenCount || b.tasks - a.tasks);

  return (
    <Card title={title} count={rows.length}>
      {rows.length ? (
        <div class="table-scroll scroll-box" style="--max:420px">
          <table>
            <thead>
              <tr>
                <th>{head}</th>
                <th class="num">Tasks</th>
                <th class="num">Runner time</th>
                <th class="num">Tokens</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map(row => {
                const { name, sub } = label(row.key);
                return (
                  <tr key={row.key}>
                    <td>
                      {name}
                      {sub ? <span class="sub">{sub}</span> : null}
                    </td>
                    <td class="num">{formatCount(row.tasks)}</td>
                    <td class="num">{formatDuration(row.runnerMs)}</td>
                    <td class="num">{formatCount(row.tokenCount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="Nothing in this range" />
      )}
    </Card>
  );
}

/** One agent's usage: the range at once, then figures and tasks per day, then where and on what it ran. */
export default async function AgentUsagePage({
  request,
  params,
}: {
  request?: Request;
  params: Promise<Record<string, string | string[]>>;
}) {
  if (!request) return null;
  const { slug: raw } = await params;
  const slug = Array.isArray(raw) ? raw[0]! : raw!;
  const tz = zoneOf(request);
  const range = rangeFor(request, tz);

  const totals = (by: 'day' | 'installation' | 'engine') =>
    load(request)
      .usage({
        by,
        since: range.since,
        until: range.until,
        agent: slug,
        ...(by === 'day' ? { tz } : {}),
      })
      .then(value => value.totals);
  const data = Promise.all([totals('day'), totals('installation'), totals('engine')]);
  const installations = load(request).installations.list(slug).then(unwrap);
  data.catch(() => {});
  installations.catch(() => {});

  return (
    <>
      <RangeBar
        range={range}
        to={{ href: '/dash/agents/[slug]/usage', params: { slug } }}
        tz={tz}
      />
      <Settle
        load={() =>
          Promise.all([data, installations]).then(([[days, where, engines], installed]) => {
            const sum = (pick: (row: UsageTotal) => number) =>
              engines.reduce((total, row) => total + pick(row), 0);
            const tasks = sum(row => row.tasks);
            const runner = sum(row => row.runnerMs);
            const place = (key: string) => {
              const found = installed.find(entry => entry.id === key);
              return found
                ? { name: found.account.login, sub: found.integration }
                : { name: key, sub: 'removed installation' };
            };
            return (
              <>
                <Stats label="Totals">
                  <Stat label="Tasks" value={formatCount(tasks)} />
                  <Stat label="Runner time" value={formatDuration(runner)} />
                  <Stat label="Tokens" value={formatCount(sum(row => row.tokenCount))} />
                  <Stat
                    label="Average task"
                    value={tasks ? formatDuration(runner / tasks) : 'Not available'}
                  />
                </Stats>
                <Card title="Tasks per day">
                  <div class="body">
                    {tasks ? (
                      <DayChart
                        days={daysIn(range, tz)}
                        totals={days}
                        metric="tasks"
                        label="Tasks per day"
                      />
                    ) : (
                      <Empty title="Nothing ran in this range">
                        Pick a longer range, or run a task.
                      </Empty>
                    )}
                  </div>
                </Card>
                <div class="grid-2">
                  <Breakdown
                    title="By installation"
                    head="Installed on"
                    rows={where}
                    label={place}
                  />
                  <Breakdown
                    title="By engine"
                    head="Engine"
                    rows={engines}
                    label={key => ({ name: key })}
                  />
                </div>
              </>
            );
          })
        }
      />
    </>
  );
}
