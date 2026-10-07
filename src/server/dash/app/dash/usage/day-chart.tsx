import './day-chart.css';
import type { UsageTotal } from '@coder/client/types';
import { Empty } from '@/comps/ui/card';
import { type Metric, formatMetric } from './metric';

export type Series = { key: string; label: string; color: string };

const OTHER: Series = { key: '', label: 'Other agents', color: 'var(--s0)' };

/** Bars per day; with `series`, those agents are stacked and the rest sit on top as one. */
export function DayChart({
  days,
  totals,
  metric,
  series = [],
  label,
}: {
  days: string[];
  totals: UsageTotal[];
  metric: Metric;
  series?: Series[];
  label: string;
}) {
  const byDay = new Map(totals.map(row => [row.key, row]));
  const max = Math.max(1, ...totals.map(row => row[metric]));
  const step = Math.ceil(days.length / 16);
  const text = (value: number) => formatMetric(metric, value);
  if (!totals.some(row => row[metric] > 0))
    return (
      <div class="chart empty-chart" aria-label={label}>
        <Empty title="Nothing ran in this range" />
      </div>
    );
  return (
    <>
      {series.length ? (
        <div class="legend">
          {[...series, OTHER].map(entry => (
            <span key={entry.key}>
              <i style={`--c:${entry.color}`} />
              {entry.label}
            </span>
          ))}
        </div>
      ) : null}
      <ol class="chart" aria-label={label}>
        {days.map((day, index) => {
          const row = byDay.get(day);
          const total = row?.[metric] ?? 0;
          const parts = series.map(entry => ({
            ...entry,
            value: row?.parts?.[entry.key]?.[metric] ?? 0,
          }));
          const rest = total - parts.reduce((sum, part) => sum + part.value, 0);
          const name = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
            month: 'short',
            day: 'numeric',
            timeZone: 'UTC',
          });
          return (
            <li
              key={day}
              style={`--h:${(total / max) * 100}%`}
              aria-label={`${name}, ${text(total)}`}
            >
              {total ? (
                <span class="col">
                  {series.length ? (
                    <>
                      {parts.map(part =>
                        part.value ? (
                          <i key={part.key} style={`--f:${part.value};--c:${part.color}`} />
                        ) : null,
                      )}
                      {rest > 0 ? <i style={`--f:${rest};--c:${OTHER.color}`} /> : null}
                    </>
                  ) : (
                    <i style="--f:1" />
                  )}
                </span>
              ) : null}
              <small>
                {index % step
                  ? ''
                  : index && days[index - step]!.slice(0, 7) === day.slice(0, 7)
                    ? Number(day.slice(8))
                    : name}
              </small>
              <span class="tip" role="tooltip">
                <b>
                  {name}, {text(total)}
                </b>
                {series.length
                  ? [...parts, { ...OTHER, value: rest }]
                      .filter(part => part.value > 0)
                      .map(part => (
                        <span key={part.key}>
                          <i style={`--c:${part.color}`} />
                          {part.label} {text(part.value)}
                        </span>
                      ))
                  : null}
              </span>
            </li>
          );
        })}
      </ol>
    </>
  );
}
