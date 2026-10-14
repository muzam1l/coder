import '@/comps/ui/segmented.css';
import '@/app/dash/[org]/usage/range-bar.css';
import './page.css';
import { formatCompact, formatCount, formatDate, formatDuration, zoneOf } from '@/utils/format';
import { daysIn, rangeFor } from '@/utils/range';
import { load, loadAgent, orgOf } from '@/api/load';
import type { AgentRow, UsageTotal } from '@coder/client/types';
import { Card, Empty } from '@/comps/ui/card';
import { Stat, Stats } from '@/app/dash/[org]/usage/stats';
import { Settle } from '@/comps/frame/stream';
import { unwrap } from '@/api/load';
import { DayChart } from '@/app/dash/[org]/usage/day-chart';
import { RangeBar } from '@/app/dash/[org]/usage/range-bar';

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
                    <td class="num" title={formatCount(row.tokenCount)}>
                      {formatCompact(row.tokenCount)}
                    </td>
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

/** Platform events the agent failed to handle in the last day, newest first. */
function Deliveries({ deliveries, tz }: { deliveries: AgentRow['deliveries']; tz: string }) {
  return (
    <Card id="deliveries" title="Deliveries" count={deliveries?.failed}>
      {deliveries ? (
        <div class="table-scroll scroll-box" style="--max:420px">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Platform</th>
                <th>Event</th>
                <th>Error</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {deliveries.recent.map((failure, index) => (
                <tr key={index} class="failed">
                  <td>{formatDate(failure.at, tz, true)}</td>
                  <td>{failure.platform}</td>
                  <td>{failure.type ?? 'Unknown'}</td>
                  <td class="mono bad">{failure.error}</td>
                  <td>
                    {failure.url ? (
                      <a class="link" href={failure.url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <Empty title="No failed deliveries in the last day" />
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
  const agent = loadAgent(request, slug);
  data.catch(() => {});
  installations.catch(() => {});
  agent.catch(() => {});

  return (
    <>
      <RangeBar
        range={range}
        to={{ href: '/dash/[org]/agents/[slug]/usage', params: { org: orgOf(request), slug } }}
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
                  <Stat
                    label="Tokens"
                    value={
                      <strong title={formatCount(sum(row => row.tokenCount))}>
                        {formatCompact(sum(row => row.tokenCount))}
                      </strong>
                    }
                  />
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
      <Settle load={() => agent.then(row => <Deliveries deliveries={row.deliveries} tz={tz} />)} />
    </>
  );
}
