import { formatCompact, formatCount, formatDuration } from '@/utils/format';

export type Metric = 'tasks' | 'runnerMs' | 'tokenCount';

export const METRIC_LABEL: Record<Metric, string> = {
  tasks: 'Tasks',
  runnerMs: 'Runner time',
  tokenCount: 'Tokens',
};

export function formatMetric(metric: Metric, value: number) {
  if (metric === 'runnerMs') return formatDuration(value);
  return metric === 'tokenCount' ? formatCompact(value) : formatCount(value);
}
