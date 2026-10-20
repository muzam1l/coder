import './status.css';
import type { TaskRow, TaskState } from '@coder/client/types';
import { awaitsApproval } from '@coder/core/defaults';

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

export const STATUS_LABEL: Record<TaskState, string> = {
  queued: 'waiting for slot',
  running: 'running',
  waiting: 'needs approval',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};
