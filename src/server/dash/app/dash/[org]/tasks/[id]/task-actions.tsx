'use client';

import './task-view.css';
import type { ComponentChildren } from 'preact';
import { useState } from 'preact/hooks';
import { Link } from '@wular/pnext/link';

import { client } from '@/utils/client';
import { useAction } from '@/utils/action';
import { useRouter, useSearchParams } from '@wular/pnext/navigation/client';
import { useOrg } from '@/comps/nav/org';
import type { Me, TaskRow } from '@coder/client/types';
import type { ChangeRequest, ChangeScope } from '@coder/server/tasks/changes';
import { isAdmin } from '@/api/types';
import { Button } from '@/comps/ui/button';
import { Card } from '@/comps/ui/card';
import { Field } from '@/comps/ui/field';
import { ConfirmDialog } from '@/comps/ui/confirm';
import { Menu } from '@/comps/ui/menu';
import { Modal } from '@/comps/ui/modal';
import { Segmented } from '@/comps/ui/segmented';
import { MenuItem } from '@/comps/ui/menu-items';
import { Icon } from '@/comps/ui/icon';
import { iAgent, iDots, iUser } from '@/comps/ui/icons';
import { taskTitle } from '@/app/dash/[org]/tasks/list/task';

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
  // A chat's delete link opens here asking.
  const [confirming, setConfirming] = useState(useSearchParams().get('delete') === '1');

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

/** An approval's exact actions, or a change's diff, folded under their count; `note` follows the count. */
function ApprovalActions({
  actions,
  diff,
  note,
}: {
  actions: string[];
  diff?: boolean;
  note?: string;
}) {
  return (
    <details class="approval-actions">
      <summary>
        <span>
          {`${actions.length} ${diff ? 'change' : 'action'}${actions.length === 1 ? '' : 's'}`}
          {note ? ` · ${note}` : null}
        </span>
      </summary>
      {diff ? (
        <pre class="change-diff">
          {actions
            .flatMap(entry => entry.split('\n'))
            .map((line, index) => (
              <span
                key={index}
                class={line.startsWith('+ ') ? 'add' : line.startsWith('- ') ? 'del' : undefined}
              >
                {line}
              </span>
            ))}
        </pre>
      ) : (
        <ol>
          {actions.map((action, index) => (
            <li key={index}>
              <code>{action}</code>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
}

/** A decision where the buttons were, in the card's head. */
const Decided = ({ response }: { response: NonNullable<ApprovalRow['response']> }) => (
  <strong class="decided">{decidedBy(response)}</strong>
);

/** An answered escalation where the conversation raised it: the reason, its actions and the decision. */
export function ApprovalEntry({ approval }: { approval: ApprovalRow }) {
  const response = approval.response!;

  return (
    <Card title="Approval needed" actions={<Decided response={response} />}>
      <div class="body">
        <p class="approval">{approval.reason}</p>
        <ApprovalActions actions={approval.actions} diff={Boolean(approval.change)} />
        {response.reason ? <p class="decision">{response.reason}</p> : null}
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
      <ApprovalActions actions={approval.actions} diff={Boolean(approval.change)} />
    </div>
  );
}

const SCOPES: Record<ChangeScope, [label: string, applies: string]> = {
  agent: ['This agent', 'applies to this agent'],
  workspace: ['Workspace', 'applies to the workspace'],
  personal: ['Personal', 'applies to you'],
};

/** Who asks and for whom as one joined pill, the agent then the person, from the names the task stored. */
function Asker({ task, me }: { task: TaskRow; me: Me }) {
  const person =
    task.task.requestedBy && task.task.requestedBy === me.user?.id
      ? 'you'
      : (task.task.context?.user?.name ??
        (task.task.event?.actor?.login !== task.task.event?.actor?.id
          ? task.task.event?.actor?.login
          : undefined));

  return (
    <span
      class="asker"
      title={person ? `${task.task.agent} asks, for ${person}` : `${task.task.agent} asks`}
    >
      <span>
        <Icon d={iAgent} />
        {task.task.agent}
      </span>
      {person ? (
        <span>
          <Icon d={iUser} />
          {person}
        </span>
      ) : null}
    </span>
  );
}

/** In the Tasks queue: told of each decision as it is sent, so its row hides until one fails. */
type Queue = { onSent: (sent: Promise<boolean>) => void };

/** An approval on its task's page as a card; in the queue a row with its task, its ask and the same buttons, unfolding to the same details. */
function ApprovalFrame({
  task,
  me,
  reason,
  request,
  answered,
  queue,
  actions,
  admin,
  dialog,
  children,
}: {
  task: TaskRow;
  me: Me;
  reason?: string;
  /** A change request's body, with its scope and diff. */
  request?: boolean;
  answered: boolean;
  queue?: Queue;
  actions?: ComponentChildren;
  /** Asking an admin, for a change only an admin approves. */
  admin?: ComponentChildren;
  /** A dialog its buttons open, kept out of the folded details. */
  dialog?: ComponentChildren;
  children: ComponentChildren;
}) {
  const org = useOrg();
  const body = request ? 'body request' : 'body';

  if (queue)
    return (
      <li class="queue-row">
        <details>
          <summary>
            <span class="queue-ask">
              <Asker task={task} me={me} />
              {reason ? <span class="queue-reason">{reason}</span> : null}
            </span>
            <span class="queue-task">
              <Link href="/dash/[org]/tasks/[id]" params={{ org, id: task.task.id }}>
                {taskTitle(task).split('\n')[0]}
              </Link>
              {admin}
            </span>
          </summary>
          <div class={body}>{children}</div>
        </details>
        {actions ? <span class="queue-acts">{actions}</span> : null}
        {dialog}
      </li>
    );
  return (
    <Card tone={answered ? undefined : 'accent'} title="Approval needed" actions={actions}>
      <div class={body}>
        <p class="approval">
          <Asker task={task} me={me} />
          {reason}
        </p>
        {admin ? <p>{admin}</p> : null}
        {children}
      </div>
      {dialog}
    </Card>
  );
}

/** A change the task asked for: its diff and scope, approved by whoever the scope allows, else asked of an admin. */
function ChangeRequest({
  task,
  approval,
  me,
  queue,
}: {
  task: TaskRow;
  approval: ApprovalRow;
  me: Me;
  queue?: Queue;
}) {
  const change = approval.change as ChangeRequest;
  const action = useAction({ toast: 'Not sent' });
  const busy = action.pending;
  const [scope, setScope] = useState(change.scope);
  const [sent, setSent] = useState<'accept' | 'decline' | 'ask'>();
  const allowed =
    scope === 'agent' || (scope === 'personal' ? me.user?.id === change.asker : isAdmin(me));
  // Acting as a person is theirs alone to answer, either way.
  const person = change.operation.kind === 'act-as' ? change.operation.user.name : undefined;
  const asked = sent === 'ask' || Boolean(change.askedAdmin);
  const adminNote = person
    ? `Only ${person} answers this.`
    : asked
      ? 'Asked an admin. Only a workspace admin approves this.'
      : 'Only a workspace admin approves this. Ask one.';
  const answered =
    approval.response ??
    (sent && sent !== 'ask' ? { decision: sent, by: me.user?.name } : undefined);

  const decide = (decision: 'accept' | 'decline' | 'ask') => {
    const sending = action.run(decision, () =>
      client.tasks.request(task.task.id, approval.id, decision, { scope }),
    );
    queue?.onSent(sending);
    void sending.then(ok => ok && setSent(decision));
  };

  return (
    <ApprovalFrame
      task={task}
      me={me}
      reason={approval.reason}
      request
      answered={Boolean(answered)}
      queue={queue}
      actions={
        answered ? (
          <Decided response={answered} />
        ) : (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busy) || Boolean(person && !allowed)}
              loading={busy === 'decline'}
              onClick={() => decide('decline')}
            >
              Deny
            </Button>
            {allowed ? (
              <Button
                size="sm"
                disabled={Boolean(busy)}
                loading={busy === 'accept'}
                onClick={() => decide('accept')}
              >
                Approve
              </Button>
            ) : (
              // A disabled button shows no tooltip of its own, so its wrapper names who approves.
              <span class="approve-off" title={adminNote}>
                <Button size="sm" disabled>
                  Approve
                </Button>
              </span>
            )}
          </>
        )
      }
      admin={
        allowed || answered || person ? undefined : (
          <span class="admin-ask">
            Only a workspace admin approves this.{' '}
            {asked ? (
              'Asked an admin.'
            ) : (
              <button
                type="button"
                class="link"
                disabled={Boolean(busy)}
                onClick={() => decide('ask')}
              >
                Ask an admin
              </button>
            )}
          </span>
        )
      }
    >
      {change.scopes.length > 1 && !answered ? (
        <Segmented
          label="Scope"
          options={change.scopes.map(key => [key, SCOPES[key][0]])}
          value={scope}
          onChange={value => setScope(value as ChangeScope)}
        />
      ) : null}
      <ApprovalActions
        actions={approval.actions}
        diff
        note={change.scopes.length > 1 && !answered ? undefined : SCOPES[scope][1]}
      />
    </ApprovalFrame>
  );
}

/** The task's open approval with its decision; `queue` makes it a row of the Tasks queue. */
export function Approval({ task, me, queue }: { task: TaskRow; me: Me; queue?: Queue }) {
  const action = useAction({ toast: 'Not sent' });
  const busy = action.pending;
  // A sent decision shows on the card at once; the events stream catches up after.
  const [decided, setDecided] = useState<{ id?: string; response: ApprovalRow['response'] }>();
  // Deny first asks why, in a dialog; leaving it empty is fine.
  const [denying, setDenying] = useState<string>();
  const approval = pendingApproval(task);
  const { id, reason, actions } = approval ?? { actions: [] };
  const response = approval?.response ?? (decided?.id === id ? decided?.response : undefined);

  const decide = async (decision: 'accept' | 'decline', why?: string) => {
    const sending = action.run(decision, () =>
      client.tasks.approve(task.task.id, id ?? '', decision, why ? { reason: why } : {}),
    );
    queue?.onSent(sending);
    if (!(await sending)) return;
    setDecided({
      id,
      response: { decision, by: me.user?.name, ...(why ? { reason: why } : {}) },
    });
  };

  if (!approval) return null;
  if (approval.change)
    return (
      <ChangeRequest key={approval.id} task={task} approval={approval} me={me} queue={queue} />
    );

  return (
    <ApprovalFrame
      task={task}
      me={me}
      reason={reason}
      answered={Boolean(response)}
      queue={queue}
      actions={
        response ? (
          <Decided response={response} />
        ) : task.task.flow === 'default' ? (
          <>
            <Button
              variant="outline"
              size="sm"
              disabled={Boolean(busy)}
              loading={busy === 'decline'}
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
      dialog={
        <Modal
          class="deny-why"
          open={denying === id && !response}
          title="Deny this request?"
          focus="actions"
          busy={busy === 'decline'}
          onSubmit={event => {
            event.preventDefault();
            const why = new FormData(event.currentTarget as HTMLFormElement).get('why');
            setDenying(undefined);
            void decide('decline', String(why ?? '').trim());
          }}
          onClose={() => setDenying(undefined)}
          actions={
            <Button type="submit" danger loading={busy === 'decline'}>
              Deny
            </Button>
          }
        >
          <Field label="Why?" hint="optional, the task reads it">
            <input
              name="why"
              placeholder="Use the staging bucket instead"
              autocomplete="off"
              autofocus
            />
          </Field>
        </Modal>
      }
    >
      <ApprovalActions actions={actions} />
      {response?.reason ? <p class="decision">{response.reason}</p> : null}
    </ApprovalFrame>
  );
}
