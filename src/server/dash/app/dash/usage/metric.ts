import { formatCount, formatDuration } from '@/utils/format';

export type Metric = 'tasks' | 'runnerMs' | 'tokenCount';

export const METRIC_LABEL: Record<Metric, string> = {
  tasks: 'Tasks',
  runnerMs: 'Runner time',
  tokenCount: 'Tokens',
};

export function formatMetric(metric: Metric, value: number) {
  return metric === 'runnerMs' ? formatDuration(value) : formatCount(value);
}
