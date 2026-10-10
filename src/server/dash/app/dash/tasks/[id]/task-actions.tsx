'use client';

import { useEffect, useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useRouter } from '@wular/pnext/navigation/client';
import type { TaskRow } from '@coder/client/types';
import { Card } from '@/comps/ui/card';
import { reasonText } from '@/utils/format';
import { ErrorText } from '@/comps/ui/field';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Menu, MenuItem } from '@/comps/ui/menu';
import { Icon } from '@/comps/ui/icon';
import { iDots } from '@/comps/ui/icons';
import { showToast, toastError } from '@/comps/frame/task-toasts';

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

const DONE = {
  approve: 'Decision sent.',
  archive: 'Archived.',
  ask: 'Question sent.',
  cancel: 'Stop requested.',
  continue: 'Sent.',
  steer: 'Steer sent.',
};

export function useAction(taskId: string) {
  const [error, setError] = useState('');
  const [outcome, setOutcome] = useState('');
  const run = async (
    name: keyof typeof DONE,
    body: {
      text?: string;
      question?: string;
      approvalId?: string;
      decision?: 'accept' | 'decline';
    } = {},
  ) => {
    setError('');
    setOutcome('');
    try {
      if (name === 'approve')
        await client.tasks.approve(taskId, body.approvalId ?? '', body.decision ?? 'decline');
      else if (name === 'ask') await client.tasks.ask(taskId, body.question ?? '');
      else if (name === 'continue' || name === 'steer')
        await client.tasks[name](taskId, body.text ?? '');
      else await client.tasks[name](taskId);
      setOutcome(DONE[name]!);
      return true;
    } catch (reason) {
      setError(reasonText(reason));
      return false;
    }
  };
  return { error, outcome, setError, run };
}

export function Flash({ error, outcome }: { error: string; outcome: string }) {
  return error ? (
    <ErrorText value={error} />
  ) : (
    <span class="flash" role="status">
      {outcome}
    </span>
  );
}

/** Archive, Stop while it runs, and Delete behind the ⋯ menu; phones keep Archive in the menu too, away from Stop. */
export function TaskActions({ task, live }: { task: TaskRow; live: boolean }) {
  const nav = useRouter();
  const action = useAction(task.task.id);
  const [archived, setArchived] = useState(Boolean(task.archivedAt));
  const [deleting, setDeleting] = useState<'ask' | 'busy'>();

  const remove = () => {
    setDeleting('busy');
    action.setError('');
    void client.tasks
      .delete(task.task.id)
      .then(() => nav.push('/dash/tasks'))
      .catch(reason => {
        setDeleting(undefined);
        action.setError(reasonText(reason));
      });
  };

  const archive = () => void action.run('archive').then(setArchived);

  return (
    <>
      <Flash {...action} />
      {live ? (
        <button type="button" class="btn outline" onClick={() => void action.run('cancel')}>
          Stop
        </button>
      ) : archived ? null : (
        <button type="button" class="btn outline archive" onClick={archive}>
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
        <MenuItem title="Delete" danger onClick={() => setDeleting('ask')} />
      </Menu>
      <ConfirmDialog
        open={Boolean(deleting)}
        title="Delete this task?"
        body="Its conversation, activity and diff go with it."
        confirmLabel="Delete"
        busy={deleting === 'busy'}
        onConfirm={remove}
        onClose={() => setDeleting(undefined)}
      />
    </>
  );
}

export function Approval({ task }: { task: TaskRow }) {
  const action = useAction(task.task.id);
  const [busy, setBusy] = useState<'accept' | 'decline'>();
  // A sent decision hides its card at once; the events stream catches up after.
  const [decided, setDecided] = useState<string>();
  const { id, action: tool, reason } = approvalParts(task.approval);

  const decide = async (decision: 'accept' | 'decline') => {
    setBusy(decision);
    const ok = await action.run('approve', { approvalId: id, decision });
    setBusy(undefined);
    if (!ok) return;
    setDecided(id);
    showToast(decision === 'accept' ? 'Allowed' : 'Denied', 'The task continues.');
  };

  useEffect(() => {
    if (action.error) toastError('Not sent', action.error);
  }, [action.error]);

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
