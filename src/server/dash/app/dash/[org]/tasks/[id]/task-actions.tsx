'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { useRouter } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import type { TaskRow } from '@coder/client/types';
import { Card } from '@/comps/ui/card';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { Icon } from '@/comps/ui/icon';
import { iDots } from '@/comps/ui/icons';
import { showToast } from '@/comps/frame/task-toasts';

export function approvalParts(approval: unknown): {
  id?: string;
  action?: string;
  reason?: string;
} {
  if (!approval || typeof approval !== 'object') return {};
  const record = approval as Record<string, unknown>;
  const pick = (...keys: string[]) =>
    keys.map(key => record[key]).find(value => typeof value === 'string') as string | undefined;
  return {
    id: pick('id'),
    action: pick('kind', 'tool'),
    reason: pick('summary', 'reason'),
  };
}

/** Archive, Stop while it runs, and Delete behind the ⋯ menu; phones keep Archive in the menu too, away from Stop. */
export function TaskActions({ task, live }: { task: TaskRow; live: boolean }) {
  const nav = useRouter();
  const org = useOrg();
  const action = useAction();
  const removing = useAction({ leaves: true });
  const [outcome, setOutcome] = useState('');
  const [archived, setArchived] = useState(Boolean(task.archivedAt));
  const [confirming, setConfirming] = useState(false);

  const act = async (name: 'cancel' | 'archive') => {
    setOutcome('');
    const ok = await action.run(name, () => client.tasks[name](task.task.id));
    if (ok) setOutcome(name === 'cancel' ? 'Stop requested.' : 'Archived.');
    return ok;
  };

  const remove = () =>
    void removing
      .run('delete', async () => {
        await client.tasks.delete(task.task.id);
        nav.push('/dash/[org]/tasks', { params: { org } });
      })
      .then(ok => ok || setConfirming(false));

  const archive = () => void act('archive').then(setArchived);

  return (
    <>
      <span class="flash" role="status">
        {outcome}
      </span>
      {live ? (
        <button
          type="button"
          class="btn outline"
          disabled={Boolean(action.pending)}
          aria-busy={action.pending === 'cancel'}
          onClick={() => void act('cancel')}
        >
          Stop
        </button>
      ) : archived ? null : (
        <button
          type="button"
          class="btn outline archive"
          disabled={Boolean(action.pending)}
          aria-busy={action.pending === 'archive'}
          onClick={archive}
        >
          Archive
        </button>
      )}
      <Menu summary={<Icon d={iDots} />} summaryClass="icon-btn" label="More actions">
        {live && !archived ? <MenuItem title="Archive" onClick={archive} /> : null}
        <MenuItem
          title="Copy task id"
          onClick={() =>
            void navigator.clipboard
              .writeText(task.task.id)
              .then(() => showToast('Copied', task.task.id))
          }
        />
        <MenuItem title="Delete" danger onClick={() => setConfirming(true)} />
      </Menu>
      <ConfirmDialog
        open={confirming}
        title="Delete this task?"
        body="Its conversation, activity and diff go with it."
        confirmLabel="Delete"
        busy={Boolean(removing.pending)}
        onConfirm={remove}
        onClose={() => setConfirming(false)}
      />
    </>
  );
}

export function Approval({ task }: { task: TaskRow }) {
  const action = useAction({ toast: 'Not sent' });
  const busy = action.pending;
  // A sent decision hides its card at once; the events stream catches up after.
  const [decided, setDecided] = useState<string>();
  const { id, action: tool, reason } = approvalParts(task.approval);

  const decide = async (decision: 'accept' | 'decline') => {
    const ok = await action.run(decision, () =>
      client.tasks.approve(task.task.id, id ?? '', decision),
    );
    if (!ok) return;
    setDecided(id);
    showToast(decision === 'accept' ? 'Allowed' : 'Denied', 'The task continues.');
  };

  if (id && decided === id) return null;

  return (
    <Card
      tone="accent"
      title="Approval needed"
      actions={
        task.task.flow === 'default' ? (
          <>
            <button
              type="button"
              class="btn outline sm"
              disabled={Boolean(busy)}
              aria-busy={busy === 'decline'}
              onClick={() => void decide('decline')}
            >
              Deny
            </button>
            <button
              type="button"
              class="btn sm"
              disabled={Boolean(busy)}
              aria-busy={busy === 'accept'}
              onClick={() => void decide('accept')}
            >
              Allow
            </button>
          </>
        ) : undefined
      }
    >
      <div class="body">
        <p class="muted">The task is paused until someone decides.</p>
        <p class="approval">
          The agent wants to run <b>{tool ?? 'a tool'}</b>.
        </p>
        {reason ? <p class="muted">{reason}</p> : null}
      </div>
    </Card>
  );
}
