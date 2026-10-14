import './status.css';
import type { TaskState } from '@coder/client/types';

export function Status({ status }: { status: TaskState }) {
  return (
    <span class={`st ${status}`}>
      <i />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export const STATUS_LABEL: Record<TaskState, string> = {
  queued: 'waiting for slot',
  running: 'running',
  waiting: 'needs approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};
