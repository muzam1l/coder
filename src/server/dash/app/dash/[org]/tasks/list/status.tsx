import './status.css';
import type { TaskRow, TaskState } from '@coder/client/types';
import { awaitsApproval } from '@coder/core/task/view';
import { Badge } from '@/comps/ui/badge';

/** A task's state; an open escalation reads as needing approval whatever its turn does. */
export function Status({
  status,
  approvals,
}: {
  status: TaskState;
  approvals?: TaskRow['approvals'];
}) {
  const shown = awaitsApproval(status, approvals) ? 'waiting' : status;

  return (
    <span class={`st ${shown}`}>
      <i />
      {STATUS_LABEL[shown] ?? shown}
    </span>
  );
}

/** A task that ran with read-only access, on its page head and its list row. */
export const ReadOnlyBadge = () => <Badge title="Ran with read-only access">read-only</Badge>;

export const STATUS_LABEL: Record<TaskState, string> = {
  queued: 'waiting for slot',
  running: 'running',
  waiting: 'needs approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};
