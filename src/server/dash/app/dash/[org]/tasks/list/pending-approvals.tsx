'use client';

import './pending-approvals.css';
import { useState } from 'preact/hooks';

import type { Me, TaskRow } from '@coder/client/types';
import { Button } from '@/comps/ui/button';
import { Card } from '@/comps/ui/card';
import { Approval, pendingApproval } from '@/app/dash/[org]/tasks/[id]/task-actions';

/** Rows the queue shows before Show all. */
const FOLDED_ROWS = 3;

/** The viewer's approval queue: each open approval a row with its buttons, unfolding to its details; a sent decision hides its row unless it fails. */
export function PendingApprovals({ rows, me }: { rows: TaskRow[]; me: Me }) {
  const [sent, setSent] = useState<string[]>([]);
  const [all, setAll] = useState(false);
  const open = rows.filter(row => !sent.includes(row.task.id) && pendingApproval(row));
  if (!open.length) return null;

  const shown = all ? open : open.slice(0, FOLDED_ROWS);
  const hide = (id: string) => (sending: Promise<boolean>) => {
    setSent(current => [...current, id]);
    void sending.then(ok => ok || setSent(current => current.filter(each => each !== id)));
  };

  return (
    <Card
      tone="accent"
      title="Pending approvals"
      count={open.length}
      actions={
        open.length > FOLDED_ROWS ? (
          <Button variant="secondary" size="sm" onClick={() => setAll(!all)}>
            {all ? 'Show fewer' : `Show all ${open.length}`}
          </Button>
        ) : undefined
      }
    >
      <ul class={all ? 'approval-queue scroll-box' : 'approval-queue'}>
        {shown.map(row => (
          <Approval key={row.task.id} task={row} me={me} queue={{ onSent: hide(row.task.id) }} />
        ))}
      </ul>
    </Card>
  );
}
