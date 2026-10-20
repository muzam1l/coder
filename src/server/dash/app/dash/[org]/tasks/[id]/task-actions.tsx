'use client';

import { useState } from 'preact/hooks';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { useRouter } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import type { TaskRow } from '@coder/client/types';
import { Button } from '@/comps/ui/button';
import { Card } from '@/comps/ui/card';
import { Field } from '@/comps/ui/field';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Menu } from '@/comps/ui/menu';
import { MenuItem } from '@/comps/ui/menu-items';
import { Icon } from '@/comps/ui/icon';
import { iDots } from '@/comps/ui/icons';
import { showToast } from '@/comps/frame/task-toasts';

/** Archive, Stop while it runs, and Delete behind the ⋯ menu; phones keep Archive in the menu too, away from Stop. */
export function TaskActions({ task, live }: { task: TaskRow; live: boolean }) {
  const nav = useRouter();
  const org = useOrg();
  const action = useAction();
  const removing = useAction({ leaves: true });
  const [outcome, setOutcome] = useState('');
  // Archived here shows at once; the task's events bring `archivedAt` after.
  const [archivedHere, setArchivedHere] = useState(false);
  const archived = archivedHere || Boolean(task.archivedAt);
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

  const archive = () => void act('archive').then(setArchivedHere);

  return (
    <>
      <span class="flash" role="status">
        {outcome}
      </span>
      {live ? (
        <Button
          variant="outline"
          disabled={Boolean(action.pending)}
          loading={action.pending === 'cancel'}
          onClick={() => void act('cancel')}
        >
          Stop
        </Button>
      ) : archived ? null : (
        <Button
          variant="outline"
          class="archive"
          disabled={Boolean(action.pending)}
          loading={action.pending === 'archive'}
          onClick={archive}
        >
          Archive
        </Button>
      )}
      <Menu summary={<Icon d={iDots} />} button="icon" label="More actions">
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

type ApprovalRow = NonNullable<TaskRow['approval']>;

/** The escalation waiting on a decision: the first unanswered one of the task's list, else the one it announced unless the list answers it. */
export const pendingApproval = (task: Pick<TaskRow, 'approval' | 'approvals'>) =>
  task.approvals?.find(approval => !approval.response) ??
  (task.approvals?.some(approval => approval.id === task.approval?.id) ? undefined : task.approval);

/** The turn an escalation was raised in: the first one still running or finished after it. */
export const raisedIn = (turns: NonNullable<TaskRow['turns']>, approval: ApprovalRow) => {
  const at = Date.parse(approval.createdAt ?? '');
  const index = turns.findIndex(turn => !turn.finishedAt || turn.finishedAt >= at);

  return index < 0 ? turns.length - 1 : index;
};

/** Who decided what, as the platforms word it: `Denied by @muzam`, `Approved in Coder`, `Task stopped`. */
const decidedBy = ({ decision, by }: NonNullable<ApprovalRow['response']>) =>
  decision === 'closed'
    ? 'Task stopped'
    : `${decision === 'accept' ? 'Approved' : 'Denied'} ${by ? `by ${by}` : 'in Coder'}`;

/** An approval's exact actions, folded under their count. */
function ApprovalActions({ actions }: { actions: string[] }) {
  return (
    <details class="approval-actions">
      <summary>
        {actions.length} action{actions.length === 1 ? '' : 's'}
      </summary>
      <ol>
        {actions.map((action, index) => (
          <li key={index}>
            <code>{action}</code>
          </li>
        ))}
      </ol>
    </details>
  );
}

/** An answered escalation where the conversation raised it: the reason, its actions and the decision. */
export function ApprovalEntry({ approval }: { approval: ApprovalRow }) {
  const response = approval.response!;

  return (
    <Card title="Approval needed">
      <div class="body">
        <p class="approval">{approval.reason}</p>
        <ApprovalActions actions={approval.actions} />
        <p class="decision">
          <strong>{decidedBy(response)}</strong>
          {response.reason ? `: ${response.reason}` : null}
        </p>
      </div>
    </Card>
  );
}

/** A decision as the conversation shows it: who decided, approved or denied, and why. */
export function DecisionTurn({ approval }: { approval: ApprovalRow }) {
  const response = approval.response!;

  return (
    <div class={`turn decision ${response.decision}`}>
      <p class="who">{decidedBy(response)}</p>
      {response.reason ? <div class="prose">{response.reason}</div> : null}
      <ApprovalActions actions={approval.actions} />
    </div>
  );
}

// Stable, so the field takes focus once, when Deny shows it.
const focus = (input: HTMLInputElement | null) => input?.focus();

export function Approval({ task }: { task: TaskRow }) {
  const action = useAction({ toast: 'Not sent' });
  const busy = action.pending;
  // A sent decision shows on the card at once; the events stream catches up after.
  const [decided, setDecided] = useState<{ id?: string; response: ApprovalRow['response'] }>();
  // Deny first asks why, in the card; leaving it empty is fine.
  const [denying, setDenying] = useState<string>();
  const approval = pendingApproval(task);
  const { id, reason, actions } = approval ?? { actions: [] };
  const response = approval?.response ?? (decided?.id === id ? decided?.response : undefined);

  const decide = async (decision: 'accept' | 'decline', why?: string) => {
    const ok = await action.run(decision, () =>
      client.tasks.approve(task.task.id, id ?? '', decision, why ? { reason: why } : {}),
    );
    if (!ok) return;
    setDecided({ id, response: { decision, ...(why ? { reason: why } : {}) } });
  };

  if (!approval) return null;

  return (
    <Card
      tone={response ? undefined : 'accent'}
      title="Approval needed"
      actions={
        !response && task.task.flow === 'default' && denying !== id ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busy)}
              onClick={() => setDenying(id)}
            >
              Deny
            </Button>
            <Button
              size="sm"
              disabled={Boolean(busy)}
              loading={busy === 'accept'}
              onClick={() => void decide('accept')}
            >
              Approve
            </Button>
          </>
        ) : undefined
      }
    >
      <div class="body">
        {denying === id && !response ? (
          <form
            class="deny-why"
            onSubmit={event => {
              event.preventDefault();
              const why = new FormData(event.currentTarget).get('why');
              void decide('decline', String(why ?? '').trim());
            }}
            onKeyDown={event => event.key === 'Escape' && setDenying(undefined)}
          >
            <Field label="Why?" hint="optional, the task reads it">
              <input
                name="why"
                placeholder="Use the staging bucket instead"
                autocomplete="off"
                ref={focus}
              />
            </Field>
            <span class="deny-why-actions">
              <Button
                variant="ghost"
                disabled={Boolean(busy)}
                onClick={() => setDenying(undefined)}
              >
                Cancel
              </Button>
              <Button type="submit" danger loading={busy === 'decline'}>
                Deny
              </Button>
            </span>
          </form>
        ) : null}
        {reason ? <p class="approval">{reason}</p> : null}
        <ApprovalActions actions={actions} />
        {response ? (
          <p class="decision">
            <strong>{decidedBy(response)}</strong>
            {response.reason ? `: ${response.reason}` : null}
          </p>
        ) : (
          <p class="muted">Your decision reaches the task as a message.</p>
        )}
      </div>
    </Card>
  );
}
