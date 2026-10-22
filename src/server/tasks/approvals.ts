/** A conversation task's escalations on its platform: one post each, kept in step with the task's record, answered there by whoever may write there. */
import type { AgentApp, AgentEvent, AgentTask } from '../../agent/types';
import { approvalActionsLabel, listApprovals } from '../../core/approvals';
import { resolveTaskDir } from '../../core/state';
import type { Approval } from '../../core/types';
import type {
  Button,
  Click,
  Integration,
  MessageDraft,
  MessagePlace,
} from '../../integrations/types';
import { forInstallation, type ServerContext } from '../context';
import type { Target } from '../chat';
import { decryptSecret } from '../store/secrets';
import type { TaskStatus } from '../store/types';
import { ACCESS_UNCHECKED, linkedMember, writeCheck } from './events';
import { conversationKey } from './conversation';

/** How long a shown approval's post stays known, so a late answer still updates it. */
const SHOWN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long one sync holds an approval's post while it calls the platform. */
const LEASE_MS = 60_000;

/** How long after a failed platform call the sweep tries again. */
const RETRY_MS = 60_000;
/** A post never shown for this long (a sync that died mid-call) is due again. */
const STALE_MS = 2 * 60_000;

export const NO_WRITE_ACCESS = 'You need write access here to approve or deny this.';

/** The approval as its conversation shows it. */
export interface ApprovalNotice {
  id: string;
  task: string;
  reason: string;
  actions: string[];
  taskUrl?: string;
}

/** A decision as the post shows it; `by` is who answered, absent when it came from Coder with no name; `closed` when the task was stopped. */
interface ApprovalOutcome {
  decision: 'accept' | 'decline' | 'closed';
  reason?: string;
  by?: string;
}

/** An answer written in the conversation; without `id` it answers the conversation's only open approval; `ask` puts a change request on the admins' list. */
interface ApprovalAnswer {
  id?: string;
  decision: 'accept' | 'decline' | 'ask';
  reason?: string;
}

/** One approval's post, under `approval:<task>:<approval>`: what the conversation shows of the record. */
export interface ApprovalPost {
  at: number;
  notice: ApprovalNotice;
  /** The platform's id of the post, for its edits. */
  message?: string;
  /** The post went out. */
  shownAt?: number;
  /** The `answeredAt` of the decision the post shows. */
  shown?: string;
  /** Held by a sync while it calls the platform. */
  lease?: number;
  /** A sync found the lease held: the holder looks at the record again when done. */
  again?: true;
  /** Who was told they cannot answer, once each. */
  refused?: string[];
  /** A platform call failed: the sweep looks again from here. */
  retryAt?: number;
}

const COMMAND = /^\s*\/(approve|deny|ask-admin)\s+(apr-[\w-]+)(?:\s+([\s\S]*?))?\s*$/i;
const BARE = /^\s*(approve|deny)\s*$/i;
const DECISIONS = { approve: 'accept', deny: 'decline', 'ask-admin': 'ask' } as const;

/** An answer command: `/approve <id>`, `/deny <id> [reason]`, `/ask-admin <id>`, or a lone `Approve` or `Deny` for the only open approval. */
export function readApprovalCommand(text: string): ApprovalAnswer | undefined {
  const command = COMMAND.exec(text);
  const word = (command?.[1] ?? BARE.exec(text)?.[1])?.toLowerCase();
  if (!word) return undefined;
  const reason = command?.[3]?.trim();

  return {
    ...(command ? { id: command[2]! } : {}),
    decision: DECISIONS[word as keyof typeof DECISIONS],
    ...(reason && word === 'deny' ? { reason } : {}),
  };
}

/** A code block no backticks in `text` can close. */
function fenced(text: string): string {
  const fence = '`'.repeat(Math.max(3, ...(text.match(/`+/g) ?? []).map(run => run.length + 1)));

  return `${fence}\n${text}\n${fence}`;
}

/** The decision in words; `by` stays plain text so nobody is mentioned. */
export function outcomeText(outcome: ApprovalOutcome): string {
  if (outcome.decision === 'closed') return '**Task stopped**.';
  const word = outcome.decision === 'accept' ? 'Approved' : 'Denied';
  const text = `**${word}** ${outcome.by ? `by ${outcome.by}` : 'in Coder'}${outcome.reason ? `: ${outcome.reason}` : ''}`;

  return /[.!?]$/.test(text) ? text : `${text}.`;
}

/** One action as a list item: inline code on one line, else a code block inside the item. */
function actionItem(action: string, index: number): string {
  const marker = `${index + 1}. `;
  if (!/[\n`]/.test(action)) return `${marker}\`${action}\``;

  return marker + fenced(action).replaceAll('\n', `\n${' '.repeat(marker.length)}`);
}

/** The approval's actions as a collapsed section: `3 actions`, then one list of the exact actions. */
export function approvalActionsSection(approval: ApprovalNotice) {
  return {
    summary: approvalActionsLabel(approval),
    markdown: approval.actions.map(actionItem).join('\n'),
    items: approval.actions,
  };
}

/** The approval's header and reason, its actions unless the draft carries them, then how to answer or, once answered, the decision. */
function approvalMarkdown(
  approval: ApprovalNotice,
  next: {
    outcome?: ApprovalOutcome;
    commands?: boolean;
    /** The actions go in the draft's own collapsed section. */
    separate?: boolean;
    collapsed?: Integration['collapsed'];
  } = {},
): string {
  const answer = next.outcome
    ? outcomeText(next.outcome)
    : [
        // Where the draft carries its own link, the text does not repeat it.
        !next.separate && approval.taskUrl && `[Approve in Coder](${approval.taskUrl})`,
        next.commands && `reply \`/approve ${approval.id}\` or \`/deny ${approval.id} <reason>\``,
      ]
        .filter(Boolean)
        .join(', or ');

  const actions = approvalActionsSection(approval);

  return [
    '**Approval needed**',
    approval.reason,
    !next.separate &&
      (next.collapsed
        ? next.collapsed(actions.summary, actions.markdown)
        : `**${actions.summary}**\n\n${actions.markdown}`),
    answer && `${answer[0]!.toUpperCase()}${answer.slice(1)}${next.outcome ? '' : '.'}`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/** What a post asking again says; the approval itself is above it. */
const WAITING = 'Waiting for your answer on the approval above.';

/** The post for an approval: a card with buttons where the platform has them, else the reply commands in its text; asking `again`, one line with the buttons. */
function draftOf(
  integration: Integration,
  notice: ApprovalNotice,
  outcome?: ApprovalOutcome,
  again?: { note?: string; buttons?: Button[] },
): MessageDraft {
  const buttons: Button[] | undefined =
    integration.messages && !outcome
      ? [
          {
            label: 'Approve',
            value: `/approve ${notice.id}`,
            style: 'primary',
            confirm: `Approve ${approvalActionsLabel(notice)} for this task?`,
          },
          {
            label: 'Deny',
            value: `/deny ${notice.id}`,
            style: 'danger',
            ask: { label: 'Why?', placeholder: 'The task reads it' },
          },
        ]
      : undefined;
  if (again)
    return {
      markdown: [again.note, WAITING].filter(Boolean).join('\n\n'),
      ...(buttons ? { buttons: [...buttons, ...(again.buttons ?? [])] } : {}),
    };

  return {
    markdown: approvalMarkdown(notice, {
      outcome,
      commands: !buttons,
      separate: Boolean(integration.messages),
      collapsed: integration.collapsed,
    }),
    ...(integration.messages
      ? {
          card: {
            title: 'Approval needed',
            body: notice.reason,
            ...(outcome
              ? {
                  status: outcomeText(outcome),
                  outcome: outcome.decision === 'accept' ? 'success' : 'failure',
                }
              : {}),
          },
          collapsed: approvalActionsSection(notice),
        }
      : {}),
    ...(buttons ? { buttons } : {}),
    ...(buttons && !integration.messages?.asks
      ? { hint: `Or reply \`/deny ${notice.id} <why>\` to deny with a reason.` }
      : {}),
    ...(buttons && notice.taskUrl ? { link: { label: 'Open in Coder', url: notice.taskUrl } } : {}),
  };
}

/** Posts live in the `delivery` kind under this prefix. */
export const APPROVAL_PREFIX = 'approval:';
const postKey = (task: string, approval: string) => `${APPROVAL_PREFIX}${task}:${approval}`;

/** The integration and conversation that show a task's approvals; none for a task outside a conversation. */
function conversationOf(ctx: ServerContext, task: AgentTask) {
  const event = task.event;
  const integration =
    event?.chat && task.source === event.integration
      ? ctx.integrations[event.integration]
      : undefined;

  return integration ? { integration, event: event! } : undefined;
}

async function placeOf(
  ctx: ServerContext,
  integration: Integration,
  event: AgentEvent,
): Promise<MessagePlace> {
  const app = await ctx.store.get('app', event.appId);
  if (!app) throw new Error(`The conversation's app ${event.appId} is gone`);
  const { adapterContext, eventThread } = await import('../chat');
  const target = {
    id: event.installationId,
    ...(event.repo ? { repo: event.repo } : {}),
    ...(event.account ? { account: event.account } : {}),
  };

  return {
    ctx: adapterContext(ctx, integration, app, decryptSecret(ctx.config, app.credentials), target),
    thread: await eventThread(ctx, app, event),
  };
}

/** Posts through the integration's buttons, or as plain text through the Chat SDK thread. */
async function post(integration: Integration, place: MessagePlace, draft: MessageDraft) {
  if (integration.messages) return integration.messages.post(place, draft);

  return (await place.thread.post({ markdown: draft.markdown })).id;
}

/** Edits in place where the platform allows, else posts the new text. */
async function edit(
  integration: Integration,
  place: MessagePlace,
  message: string | undefined,
  draft: MessageDraft,
  fallback: MessageDraft,
) {
  if (integration.messages?.edit)
    return message ? integration.messages.edit(place, message, draft) : undefined;
  if (integration.messages) return void (await integration.messages.post(place, fallback));
  if (message)
    return place.thread.adapter.editMessage(place.thread.id, message, { markdown: draft.markdown });
}

const noticeOf = (task: AgentTask, approval: Approval): ApprovalNotice => ({
  id: approval.id,
  task: task.id,
  reason: approval.reason,
  actions: approval.actions,
  ...(task.taskUrl ? { taskUrl: task.taskUrl } : {}),
});

const outcomeOf = (response: NonNullable<Approval['response']>): ApprovalOutcome => ({
  decision: response.decision,
  ...(response.reason ? { reason: response.reason } : {}),
  ...(response.by ? { by: response.by } : {}),
});

/** Takes the post's lease for one platform call; undefined while another sync holds it, which then looks again. */
async function lease(ctx: ServerContext, key: string): Promise<ApprovalPost | undefined> {
  const now = (ctx.now ?? Date.now)();

  return ctx.store.withAppLock(key, async store => {
    const row = await store.get<ApprovalPost>('delivery', key);
    if (!row) return undefined;
    const held = (row.lease ?? 0) > now;
    await store.put(
      'delivery',
      key,
      held ? { ...row, again: true } : { ...row, lease: now + LEASE_MS },
      { ttlMs: SHOWN_TTL_MS },
    );
    return held ? undefined : row;
  });
}

/** Writes what a platform call changed and releases the lease; true when another sync asked for another look. */
async function release(
  ctx: ServerContext,
  key: string,
  patch: Partial<ApprovalPost>,
): Promise<boolean> {
  return ctx.store.withAppLock(key, async store => {
    const row = await store.get<ApprovalPost>('delivery', key);
    if (!row) return false;
    const { lease: _, again, retryAt, ...rest } = { ...row, ...patch };
    await store.put('delivery', key, patch.retryAt ? { ...rest, retryAt } : rest, {
      ttlMs: SHOWN_TTL_MS,
    });
    return again === true;
  });
}

/** The task's approvals as recorded now: its folder on a local server, else the queue. */
async function recorded(ctx: ServerContext, task: AgentTask): Promise<Approval[]> {
  const status = await ctx.store.get('task', task.id);
  if (ctx.local && status?.handle?.startsWith('cli:'))
    return listApprovals(resolveTaskDir(task.cwd ?? ctx.local.cwd, task.id));

  return status?.task.context?.approvals ?? [];
}

/** Brings the task's conversation in step with its approvals: each one posted once, each decision shown once. Safe to run any time; a failed call is retried by the next run. */
export async function syncApprovals(
  ctx: ServerContext,
  task: AgentTask,
  approvals: Approval[],
): Promise<void> {
  const found = conversationOf(ctx, task);
  if (!found || !approvals.length) return;
  // One read of the task's posts; only an approval never posted, or with a decision its post does not show, is touched.
  const posts = new Map(
    (await ctx.store.list<ApprovalPost>('delivery', { prefix: postKey(task.id, '') })).map(row => [
      row.id,
      row.value,
    ]),
  );
  let place: MessagePlace | undefined;
  const at = async () => (place ??= await placeOf(ctx, found.integration, found.event));
  for (let approval of approvals) {
    const key = postKey(task.id, approval.id);
    const posted = posts.get(key);
    if (posted?.shownAt && (!approval.response || posted.shown === approval.response.answeredAt))
      continue;
    if (!posted)
      await ctx.store.create(
        'delivery',
        key,
        { at: (ctx.now ?? Date.now)(), notice: noticeOf(task, approval) },
        { ttlMs: SHOWN_TTL_MS },
      );
    // Another sync that found this post busy asked for one more look, at the record as it is then.
    for (let look = 0; look < 3; look++) {
      const row = await lease(ctx, key);
      if (!row) break;
      const notice = noticeOf(task, approval);
      const outcome = approval.response ? outcomeOf(approval.response) : undefined;
      let again: boolean;
      if (row.shownAt && (!approval.response || row.shown === approval.response.answeredAt))
        again = await release(ctx, key, {});
      else
        try {
          if (!row.shownAt) {
            // A decision already taken shows in the first post, nothing to edit later.
            const message = await post(
              found.integration,
              await at(),
              draftOf(found.integration, notice, outcome),
            );
            again = await release(ctx, key, {
              shownAt: (ctx.now ?? Date.now)(),
              ...(message ? { message } : {}),
              ...(outcome ? { shown: approval.response!.answeredAt } : {}),
            });
          } else {
            await edit(
              found.integration,
              await at(),
              row.message,
              draftOf(found.integration, notice, outcome),
              { markdown: outcomeText(outcome!) },
            );
            again = await release(ctx, key, { shown: approval.response!.answeredAt });
          }
        } catch (error) {
          console.error(
            `coder server: could not show approval ${approval.id} of task ${task.id} in its conversation`,
            error,
          );
          again = await release(ctx, key, { retryAt: (ctx.now ?? Date.now)() + RETRY_MS });
        }
      if (!again) break;
      approval = (await recorded(ctx, task)).find(entry => entry.id === approval.id) ?? approval;
    }
  }
}

/** The sweep over every organization's posts due for another call: a failed post or update, or a sync that died. */
export async function syncDuePosts(ctx: ServerContext): Promise<void> {
  const now = (ctx.now ?? Date.now)();
  const due = await ctx.store.approvalPostsDue(now, STALE_MS);
  const byTask = new Map<string, { organizationId: string; ids: Set<string> }>();
  for (const row of due) {
    const organizationId = row.organizationId ?? ctx.organizationId;
    const group = byTask.get(`${organizationId}:${row.value.notice.task}`) ?? {
      organizationId,
      ids: new Set<string>(),
    };
    group.ids.add(row.value.notice.id);
    byTask.set(`${organizationId}:${row.value.notice.task}`, group);
  }
  for (const [key, { organizationId, ids }] of byTask) {
    const taskId = key.slice(organizationId.length + 1);
    const { scoped } = await import('../context');
    const tenant = scoped(ctx, organizationId);
    const status = await tenant.store.get('task', taskId);
    if (!status) continue;
    const approvals = (await recorded(tenant, status.task)).filter(entry => ids.has(entry.id));

    await syncApprovals(tenant, status.task, approvals);
  }
}

/** Ids of the task's posted approvals whose post shows no decision. */
export async function openApprovals(ctx: ServerContext, taskId: string): Promise<string[]> {
  return (await ctx.store.list<ApprovalPost>('delivery', { prefix: postKey(taskId, '') }))
    .filter(row => !row.value.shown)
    .map(row => row.value.notice.id);
}

/** Whether `text` answers an approval posted in this conversation (by id, or the only open one), so it reaches the task even where the app hears only its name. */
export async function answersShown(
  ctx: ServerContext,
  app: AgentApp,
  target: Target,
  thread: string,
  text: string,
): Promise<boolean> {
  const answer = readApprovalCommand(text);
  if (!answer) return false;
  const tenant = await forInstallation(ctx, `${app.id}:${target.id}`);
  const task =
    tenant &&
    (await tenant.store.conversationState(conversationKey(app.id, target.id, thread))).status;
  if (!task) return false;
  if (answer.id)
    return Boolean(await tenant.store.get('delivery', postKey(task.task.id, answer.id)));

  return (await openApprovals(tenant, task.task.id)).length === 1;
}

/** An answer from the conversation, `event` being where and by whom: applied when the platform lets them write there, as starting a task needs; anyone else is told once, in the thread, why not. */
export async function answerInConversation(
  ctx: ServerContext,
  integration: Integration,
  status: TaskStatus,
  answer: ApprovalAnswer,
  event: AgentEvent,
  token: () => Promise<string | undefined>,
  reply: (text: string) => Promise<unknown>,
): Promise<void> {
  const open = answer.id ? [answer.id] : await openApprovals(ctx, status.task.id);
  if (open.length !== 1) {
    await reply('Name the approval: `/approve <id>` or `/deny <id> <reason>`.');
    return;
  }
  const actor = event.actor;
  const canWrite = await writeCheck(ctx, integration, event, token);
  if (canWrite === null) {
    await reply(ACCESS_UNCHECKED);
    return;
  }
  if (canWrite === false) {
    await refuse(ctx, status.task, open[0]!, actor);
    return;
  }

  const { changeOf, decideChange } = await import('./changes');
  const requested = status.task.context?.approvals?.find(entry => entry.id === open[0]);
  const change = changeOf(requested);
  if (change) {
    const linked = ctx.auth ? await linkedMember(ctx, integration, event) : undefined;
    // The role Wular gave at the member's last sign-in, kept with their link.
    const member = linked && { ...linked, role: linked.roles?.[ctx.organizationId] };
    const decided = await decideChange(ctx, status, open[0]!, { ...answer }, member);
    // Said in the thread, where every platform shows it; where a pick used the controls up, the approval is asked again under it.
    const found = conversationOf(ctx, status.task);
    const say = async (text: string, buttons: Button[] = []) => {
      if (!found) return reply(text);
      const place = await placeOf(ctx, integration, found.event);
      if (integration.messages?.clickConsumes)
        return askAgain(
          ctx,
          integration,
          place,
          postKey(status.task.id, open[0]!),
          noticeOf(status.task, requested!),
          text,
          buttons,
        );

      return post(integration, place, { markdown: text, ...(buttons.length ? { buttons } : {}) });
    };
    if (decided.ok) {
      if (answer.decision === 'ask') await say('Asked the workspace admins to approve it.');
      return;
    }
    const error = ((await decided.json()) as { error?: string }).error ?? NO_WRITE_ACCESS;
    if (decided.status !== 403 || !member || change.scope !== 'workspace')
      return void (await say(error));
    if (!integration.messages)
      return void (await say(`${error} Reply \`/ask-admin ${open[0]}\` to ask one.`));
    await say(error, [{ label: 'Ask an admin', value: `/ask-admin ${open[0]}` }]);
    return;
  }
  if (answer.decision === 'ask') {
    await reply('Only a change the task asked for goes to an admin.');
    return;
  }
  const { decideApproval } = await import('./admin');
  const response = await decideApproval(
    ctx,
    status.task.id,
    {
      approvalId: open[0],
      decision: answer.decision,
      ...(answer.reason ? { reason: answer.reason } : {}),
    },
    actor.login || actor.id,
  );
  if (!response.ok)
    await reply(((await response.json()) as { error?: string }).error ?? NO_WRITE_ACCESS);
}

/** Tells someone without write access, once per person and approval, in the thread; where the click used the controls up, the approval is asked again under that note. */
async function refuse(
  ctx: ServerContext,
  task: AgentTask,
  approvalId: string,
  actor: AgentEvent['actor'],
) {
  const found = conversationOf(ctx, task);
  if (!found) return;
  const key = postKey(task.id, approvalId);
  const who = actor.id || actor.login || '';
  const row = await ctx.store.withAppLock(key, async store => {
    const current = await store.get<ApprovalPost>('delivery', key);
    if (!current || current.refused?.includes(who)) return undefined;
    await store.put(
      'delivery',
      key,
      { ...current, refused: [...(current.refused ?? []), who] },
      { ttlMs: SHOWN_TTL_MS },
    );
    return current;
  });
  if (!row) return;
  const place = await placeOf(ctx, found.integration, found.event);
  if (found.integration.messages?.clickConsumes && !row.shown) {
    await askAgain(ctx, found.integration, place, key, row.notice, NO_WRITE_ACCESS);
    return;
  }
  await post(found.integration, place, { markdown: NO_WRITE_ACCESS });
}

/** Posts an open approval's controls again; the new post is the one later edits change. True when a sync asked for another look meanwhile. */
async function askAgain(
  ctx: ServerContext,
  integration: Integration,
  place: MessagePlace,
  key: string,
  notice: ApprovalNotice,
  note?: string,
  buttons?: Button[],
) {
  const message = await post(
    integration,
    place,
    draftOf(integration, notice, undefined, { note, buttons }),
  );

  return release(ctx, key, { ...(message ? { message } : {}), shownAt: (ctx.now ?? Date.now)() });
}

/** After the turn's last message, where it dismissed earlier controls: each approval still open and shown before `before` is asked again under it. */
export async function askOpenAgain(
  ctx: ServerContext,
  task: AgentTask,
  before: number,
): Promise<void> {
  const found = conversationOf(ctx, task);
  if (!found?.integration.messages?.laterDismisses) return;
  const approvals = await recorded(ctx, task);
  const answered = new Set(approvals.filter(entry => entry.response).map(entry => entry.id));
  const open = (await ctx.store.list<ApprovalPost>('delivery', { prefix: postKey(task.id, '') }))
    .map(row => row.value)
    .filter(
      row => row.shownAt && row.shownAt < before && !row.shown && !answered.has(row.notice.id),
    );
  if (!open.length) return;
  const place = await placeOf(ctx, found.integration, found.event);

  for (const { notice } of open) {
    const key = postKey(task.id, notice.id);
    const row = await lease(ctx, key);
    if (!row) continue;
    let again: boolean;
    try {
      again = row.shown
        ? await release(ctx, key, {})
        : await askAgain(ctx, found.integration, place, key, notice);
    } catch (error) {
      console.error(
        `coder server: could not ask approval ${notice.id} of task ${task.id} again`,
        error,
      );
      again = await release(ctx, key, {});
    }
    // A sync that found this post busy left the next look to us.
    if (again)
      await syncApprovals(
        ctx,
        task,
        (await recorded(ctx, task)).filter(entry => entry.id === notice.id),
      );
  }
}

/** A click on an approval's button: only for a task of the conversation's own app and installation. */
export async function clickedApproval(
  ctx: ServerContext,
  integration: Integration,
  app: AgentApp,
  target: Target,
  click: Click,
): Promise<void> {
  const answer = readApprovalCommand(click.text ? `${click.value} ${click.text}` : click.value);
  if (!answer) {
    console.warn(`coder server: ${app.id} sent a click Coder does not read: ${click.value}`);
    return;
  }
  const tenant = await forInstallation(ctx, `${app.id}:${target.id}`);
  const status =
    tenant &&
    (await tenant.store.conversationState(conversationKey(app.id, target.id, click.thread))).status;
  const event = status?.task.event;
  if (!tenant || !status || event?.appId !== app.id || event.installationId !== target.id) {
    console.warn(`coder server: ${app.id} answered an approval of an unknown task`);
    return;
  }
  const place = await placeOf(tenant, integration, event);
  const token = () =>
    place.ctx.token(event.installationId, { tools: integration.tools.presets['read-only'] });

  await answerInConversation(
    tenant,
    integration,
    status,
    answer,
    { ...event, actor: click.actor },
    token,
    text => place.thread.post({ markdown: text }),
  );
}
