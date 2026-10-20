/**
 * Approvals: the engine's own reviewer decides routine actions; a task reaches a human only
 * through its `escalate` tool. Each escalation is a request file in the task's approvals dir,
 * its answer a response file beside it. Answers never block the task: the decision arrives as
 * a steer. The engines' own permission fallbacks (Claude's prompt tool, Codex's approval
 * requests) deny at once and point the task at `escalate`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { readJsonFile } from '../utils/fsx';
import { appendTaskLog, type TaskLogEntry } from './state';

import type { Approval } from './types';

/** What the engine gets when its reviewer could not decide and asked Coder. */
export const NOT_ALLOWED =
  'Not allowed here. If the task truly needs this, call the escalate tool with the exact command and why, then continue or end your turn; the decision arrives as a message, in this turn if it is still running.';

/** An escalation as the task raises it. */
export interface ApprovalRequest {
  /** One short sentence: what the actions are for. */
  reason: string;
  /** The exact commands, as the task will run them. */
  actions: string[];
}

/** An answer to an escalation; `closed` when the task was stopped before anyone answered. */
export interface ApprovalAnswer {
  decision: 'accept' | 'decline' | 'closed';
  reason?: string;
  answeredAt: string;
  /** Who answered, as the conversation shows it. */
  by?: string;
  /** Set once the task has the decision: steered, queued or resumed with it. */
  deliveredAt?: string;
}

const approvalsDir = (taskDir: string) => path.join(taskDir, 'approvals');

/** Every approval of a task, oldest first, answered ones with their answer. */
export function listApprovals(taskDir: string): Approval[] {
  const dir = approvalsDir(taskDir);
  if (!fs.existsSync(dir)) return [];

  return fs
    .readdirSync(dir)
    .filter(name => name.endsWith('.request.json'))
    .flatMap((name): Approval[] => {
      const id = name.replace(/\.request\.json$/, '');
      // A request caught mid-write parses as null; the next list picks it up.
      const request = readJsonFile<Approval>(path.join(dir, name));
      if (!request) return [];
      const response = readJsonFile<ApprovalAnswer>(path.join(dir, `${id}.response.json`));

      return [{ ...request, id, response }];
    })
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

/** Every action the user approved for this task, oldest first; each later turn tells the reviewer. */
export const approvedActions = (taskDir: string) => [
  ...new Set(
    listApprovals(taskDir).flatMap(approval =>
      approval.response?.decision === 'accept' ? approval.actions : [],
    ),
  ),
];

/** The accepted escalation with this exact command among its actions, read at call time. */
export const approvalFor = (taskDir: string, command: string) =>
  listApprovals(taskDir).find(
    approval =>
      approval.response?.decision === 'accept' &&
      approval.actions.some(action => action.trim() === command.trim()),
  );

/** The task's approvals nobody has answered. */
export const pendingApprovals = (taskDir: string) =>
  listApprovals(taskDir).filter(approval => !approval.response);

/** The task's approvals that were denied; they stay answerable. */
export const deniedApprovals = (taskDir: string) =>
  listApprovals(taskDir).filter(approval => approval.response?.decision === 'decline');

/** Why a closed approval takes no answer. */
export const stoppedMessage = (approvalId: string) =>
  `The task was stopped, so approval "${approvalId}" is closed.`;

/** The answer a stop gives an open approval; the task never hears it. */
export const closedResponse = (at = new Date().toISOString()) => ({
  decision: 'closed' as const,
  answeredAt: at,
  deliveredAt: at,
});

/** Closes the task's open approvals as it stops. */
export function closeApprovals(taskDir: string): Approval[] {
  const response = closedResponse();

  return pendingApprovals(taskDir).map(approval => {
    writeResponse(taskDir, approval.id, response);

    return { ...approval, response };
  });
}

/** Record an escalation; returns its id at once. */
export function requestApproval(taskDir: string, request: ApprovalRequest): Approval {
  const dir = approvalsDir(taskDir);
  fs.mkdirSync(dir, { recursive: true });
  const id = `apr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const approval: Approval = {
    id,
    reason: request.reason,
    actions: request.actions,
    createdAt: new Date().toISOString(),
  };
  const { id: _, response: __, ...stored } = approval;
  fs.writeFileSync(
    path.join(dir, `${id}.request.json`),
    `${JSON.stringify(stored, null, 2)}\n`,
    'utf8',
  );

  return approval;
}

/** Raise an escalation for a task and log it; what the `escalate` tool and `CODER_SIMULATE_APPROVAL` do. */
export function escalate(cwd: string, taskId: string, taskDir: string, request: ApprovalRequest) {
  const approval = requestApproval(taskDir, request);
  appendTaskLog(cwd, taskId, {
    kind: 'approval-escalated',
    approvalId: approval.id,
    summary: approval.actions.join('\n'),
    actions: approval.actions,
    reason: approval.reason,
    message: `Approval needed (${approval.id}): ${approval.reason}`,
  } as TaskLogEntry);

  return approval;
}

/** Dev hook: a new task raises one escalation at its start, as if it had called `escalate`. */
export const SIMULATE_APPROVAL_ENV = 'CODER_SIMULATE_APPROVAL';

/** Answer an approval, pending or already denied; returns it with its answer. */
export function answerApproval(
  taskDir: string,
  approvalId: string,
  decision: ApprovalAnswer['decision'],
  reason?: string,
  by?: string,
): Approval {
  const approval = listApprovals(taskDir).find(entry => entry.id === approvalId);
  if (!approval) throw new Error(`No approval "${approvalId}" for this task.`);
  if (approval.response?.decision === 'closed') throw new Error(stoppedMessage(approvalId));
  if (approval.response?.decision === 'accept')
    throw new Error(`Approval "${approvalId}" is already approved.`);
  const response: ApprovalAnswer = {
    decision,
    ...(reason ? { reason } : {}),
    answeredAt: new Date().toISOString(),
    ...(by ? { by } : {}),
  };
  writeResponse(taskDir, approvalId, response);

  return { ...approval, response };
}

/** Marks an answer delivered to the task; a retry of its delivery is then a no-op. */
export function markDelivered(taskDir: string, approval: Approval): Approval {
  // A later answer recorded while this one was delivered stays.
  const stored = listApprovals(taskDir).find(entry => entry.id === approval.id)?.response;
  if (
    stored?.decision !== approval.response?.decision ||
    stored?.answeredAt !== approval.response?.answeredAt
  )
    return approval;

  const response = { ...approval.response!, deliveredAt: new Date().toISOString() };
  writeResponse(taskDir, approval.id, response);

  return { ...approval, response };
}

function writeResponse(taskDir: string, approvalId: string, response: Approval['response']) {
  fs.writeFileSync(
    path.join(approvalsDir(taskDir), `${approvalId}.response.json`),
    `${JSON.stringify(response, null, 2)}\n`,
    'utf8',
  );
}

/** An answer the record refuses: the approval is already approved and this one differs. */
export class ApprovalRefusedError extends Error {}

/** Why `answer` cannot land over `known`, or null when it can; the same decision again is a retry. */
export function refusedAnswer(known: Approval | undefined, answer: Approval): string | null {
  if (known?.response?.decision === 'closed' && answer.response?.decision !== 'closed')
    return stoppedMessage(answer.id);

  return known?.response?.decision === 'accept' && answer.response?.decision !== 'accept'
    ? `Approval "${answer.id}" is already approved`
    : null;
}

/** Put a task's approvals, answers included, in its dir on this machine: a resumed server task carries them over. */
export function restoreApprovals(taskDir: string, approvals: Approval[]): void {
  if (!approvals.length) return;
  const dir = approvalsDir(taskDir);
  fs.mkdirSync(dir, { recursive: true });
  for (const { id, response, ...request } of approvals) {
    const file = path.join(dir, `${id}.request.json`);
    if (!fs.existsSync(file))
      fs.writeFileSync(file, `${JSON.stringify(request, null, 2)}\n`, 'utf8');
    if (response)
      fs.writeFileSync(
        path.join(dir, `${id}.response.json`),
        `${JSON.stringify(response, null, 2)}\n`,
        'utf8',
      );
  }
}

/** The known list updated by a reported one: an answer, once given anywhere, stays; the newer one wins. */
export function mergeApprovals(known: Approval[], reported: Approval[]): Approval[] {
  const answers = new Map(known.map(approval => [approval.id, approval.response]));
  const ids = new Set(reported.map(approval => approval.id));
  // Known and reported answers: a closed one stays, else the later `answeredAt` wins, the reported one on a tie.
  const newer = (known: Approval['response'], reported: Approval['response']) =>
    known?.decision !== 'closed' &&
    (!known || !reported || String(reported.answeredAt ?? '') >= String(known.answeredAt ?? ''))
      ? (reported ?? known)
      : known;

  return [
    ...reported.map(approval => ({
      ...approval,
      response: newer(answers.get(approval.id), approval.response) ?? null,
    })),
    ...known.filter(approval => !ids.has(approval.id)),
  ].sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
}

/** The message the task gets for an answer; `Approved` tells it to retry the action. */
export function approvalMessage(approval: Approval): string {
  const { decision, reason } = approval.response!;
  const { actions } = approval;
  const list = actions.map((action, index) => `${index + 1}. ${action}`).join(' ');

  if (decision === 'decline') return `Denied: ${list}${reason ? `: ${reason}` : ''}`;
  if (decision === 'closed') return `Closed, the task was stopped: ${list}`;

  return actions.length === 1
    ? `The user approved doing exactly this outside the sandbox for the rest of this task: ${actions[0]}. Retry it outside the sandbox now, exactly as written.`
    : `The user approved doing exactly these outside the sandbox for the rest of this task: ${list}. Retry them outside the sandbox now, each exactly as written.`;
}

/** Turns with each one whose prompt is a decision naming its approval, so surfaces show it as that decision. */
export const withDecisions = <T extends { prompt: string }>(
  turns: T[],
  approvals: Approval[] = [],
): Array<T & { approval?: string }> =>
  turns.map(turn => {
    const decision = approvals.find(
      approval => approval.response && approvalMessage(approval) === turn.prompt,
    );

    return decision ? { ...turn, approval: decision.id } : turn;
  });

/** The exact actions for a terminal, which cannot fold: one numbered line each. */
export const actionLines = (actions: string[]) =>
  actions
    .map((action, index) => `  ${index + 1}. ${action.replaceAll('\n', '\n     ')}`)
    .join('\n');

/** The collapsed label of an approval's actions: `1 action`, `3 actions`. */
export function approvalActionsLabel(approval: Pick<Approval, 'actions'>) {
  const count = approval.actions.length;

  return `${count} action${count === 1 ? '' : 's'}`;
}

/** Codex's approval request that reached Coder: auto review decided already, so it is declined at once with why. */
export function codexApprovalHandler(onEvent: (event: Record<string, unknown>) => void) {
  return async (method: string, params: { command?: string }) => {
    onEvent({
      kind: 'approval-decision',
      method,
      decision: 'decline',
      summary: params.command ?? method,
      reason: NOT_ALLOWED,
    });

    return { decision: 'decline' };
  };
}
