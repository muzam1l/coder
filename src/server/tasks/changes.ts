/** Writes a task asks for that a person confirms: a typed operation kept as one of the task's approvals, applied with the routes' own core functions once the approver's role allows it. */
import type { AgentTask, AgentUsage, Connection } from '../../agent/types';
import { APPROVERS, changeDecisionMessage } from '../../core/approvals';
import type { CustomModelConfig } from '../../core/config';
import { CoderError } from '../../core/errors';
import type { Approval } from '../../core/types';
import {
  agentSettings,
  publishUpload,
  saveAgentSettings,
  type AgentUpload,
} from '../agents/publishing';
import { getVersion } from '../agents/records';
import { json } from '../routes/http';
import { adminRole, bearerToken } from '../routes/guards';
import type { Params } from '../routes/match';
import type { ServerContext, SessionInfo } from '../context';
import { serverRunnerId } from '../runners/select';
import { shownConfig, updateConfig } from '../settings/config';
import { aliasEntry, toggleEntry, updateEntry } from '../settings/models';
import { clearDefaults } from '../settings/runners';
import type { TaskStatus } from '../store/types';
import { syncApprovals } from './approvals';
import { taskClaims, taskTokenHash, type TaskPrincipal } from './access';
import { ACTIVE_STATES, addInbox, readInbox } from './queue';

/** A Confirm write: what changes, applied by the same core function its route calls. */
export type Change =
  | { kind: 'agent-settings'; agent: string; settings: AgentUsage; before?: AgentUsage }
  | { kind: 'agent-version'; agent: string; upload: AgentUpload; version?: number }
  | { kind: 'model-update'; name: string; fields: Partial<CustomModelConfig> }
  | { kind: 'model-alias'; name: string; spec: string }
  | { kind: 'model-enable' | 'model-disable'; name: string }
  | { kind: 'runner-default'; runner: string }
  | {
      kind: 'act-as';
      connection: Pick<Connection, 'id' | 'name'>;
      user: Pick<SessionInfo['user'], 'name'>;
    };

/** The changes a route asks for; acting as a person comes only from using their connection. */
export type ChangeKind = Exclude<Change['kind'], 'act-as'>;
export type ChangeScope = keyof typeof APPROVERS;

/** A task's Confirm request: the change, the scope it applies to, and who may approve it. */
export interface ChangeRequest {
  operation: Change;
  scope: ChangeScope;
  /** The scopes an approver may pick. */
  scopes: ChangeScope[];
  /** The linked member who asked. */
  asker?: string;
  /** Who put it on the admins' list. */
  askedAdmin?: string;
}

/** A person answering a request, with their role in the request's workspace. */
type Approver = SessionInfo['user'] & { role?: string };

/** The signed-in person as an approver; an API token carries no name, so theirs comes from a platform link. */
export async function sessionApprover(ctx: ServerContext): Promise<Approver | undefined> {
  if (!ctx.session) return undefined;
  const { user, role } = ctx.session;
  const links = user.name ? [] : await ctx.auth?.linkedAccounts?.(user.id).catch(() => []);

  return { ...user, name: user.name || links?.find(link => link.name)?.name || '', role };
}

/** How long a request stays on the admins' list. */
const ASKED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const askedKey = (task: string, approval: string) => `admin-ask:${task}:${approval}`;

/** An entry of the admins' list. */
export interface PendingApproval {
  task: string;
  approval: string;
  reason: string;
  by: string;
  at: number;
}

/** The scopes each kind of change may take. */
const SCOPES: Record<Change['kind'], ChangeScope[]> = {
  'agent-settings': ['agent'],
  'agent-version': ['agent'],
  'model-update': ['workspace'],
  'model-alias': ['workspace'],
  'model-enable': ['workspace'],
  'model-disable': ['workspace'],
  'runner-default': ['workspace', 'personal'],
  'act-as': ['personal'],
};

const MODEL_FIELDS = ['baseUrl', 'model', 'envKey', 'wireApi', 'contextWindow'] as const;

export const changeOf = (approval: Approval | undefined) =>
  approval?.change as ChangeRequest | undefined;

/** The keys whose values differ between `before` and `after`. */
function changedKeys(before: object = {}, after: object = {}): string[] {
  const [was, now] = [before as Record<string, unknown>, after as Record<string, unknown>];

  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
    key => JSON.stringify(was[key]) !== JSON.stringify(now[key]),
  );
}

/** One line per changed key: `+ key: after` added, `- key: before` removed, `key: before → after` changed. */
function diffLines(before: object = {}, after: object = {}): string[] {
  const [was, now] = [before as Record<string, unknown>, after as Record<string, unknown>];

  return changedKeys(was, now).flatMap(key => {
    const [left, right] = [JSON.stringify(was[key]), JSON.stringify(now[key])];
    if (left === undefined) return [`+ ${key}: ${right}`];
    if (right === undefined) return [`- ${key}: ${left}`];

    return [`${key}: ${left} → ${right}`];
  });
}

const DIFF_CELLS = 1_000_000;

/** A text's line diff under `title`, in order: `- ` for each line gone, `+ ` for each line new; none when equal. */
function textLines(title: string, before: string, after: string): string[] {
  if (before === after) return [];
  const lines = (text: string) => (text ? text.split('\n') : []);
  const [all, next] = [lines(before), lines(after)];
  // Lines both texts start and end with stay out of the diff.
  let head = 0;
  while (head < all.length && head < next.length && all[head] === next[head]) head++;
  let tail = 0;
  while (
    tail < all.length - head &&
    tail < next.length - head &&
    all[all.length - 1 - tail] === next[next.length - 1 - tail]
  )
    tail++;
  const was = all.slice(head, all.length - tail);
  const now = next.slice(head, next.length - tail);
  // Past this many cells the middle shows as wholly replaced, keeping memory bounded.
  if (was.length * now.length > DIFF_CELLS)
    return [[title, ...was.map(line => `- ${line}`), ...now.map(line => `+ ${line}`)].join('\n')];
  // Longest common subsequence, so a moved line shows as gone and new.
  const common = was.map(() => new Array<number>(now.length + 1).fill(0));
  common.push(new Array<number>(now.length + 1).fill(0));
  for (let i = was.length - 1; i >= 0; i--)
    for (let j = now.length - 1; j >= 0; j--)
      common[i]![j] =
        was[i] === now[j]
          ? common[i + 1]![j + 1]! + 1
          : Math.max(common[i + 1]![j]!, common[i]![j + 1]!);
  const diff = [title];
  let [i, j] = [0, 0];
  while (i < was.length || j < now.length)
    if (i < was.length && j < now.length && was[i] === now[j]) [i, j] = [i + 1, j + 1];
    else if (i < was.length && (j === now.length || common[i + 1]![j]! >= common[i]![j + 1]!))
      diff.push(`- ${was[i++]}`);
    else diff.push(`+ ${now[j++]}`);

  return [diff.join('\n')];
}

/** Every file of an upload against the current version's, added, removed or changed. */
function fileLines(before: Record<string, string> = {}, after: Record<string, string> = {}) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .sort()
    .flatMap(name =>
      before[name] === undefined && !after[name]
        ? [`file ${name}\n+ (empty file)`]
        : after[name] === undefined && !before[name]
          ? [`file ${name}\n- (empty file)`]
          : textLines(`file ${name}`, before[name] ?? '', after[name] ?? ''),
    );
}

/** An agent's saved settings in the shape a request resolves to; as stored when they no longer resolve. */
async function savedSettings(ctx: ServerContext, agent: string): Promise<AgentUsage | undefined> {
  const saved = (await ctx.store.get('agent', agent))?.settings;

  return saved && (await agentSettings(ctx, agent, saved).catch(() => saved));
}

const newerVersion = (agent: string) =>
  `Agent ${agent} has a newer version since this request, so it was not applied. Ask again.`;

/** The change an approval applies: settings as their reviewed fields on top of the current ones, a version only over the one it was diffed against; refused when what it changes moved since the request. */
async function reviewed(ctx: ServerContext, change: Change): Promise<Change | string> {
  if (change.kind === 'agent-version')
    return (await getVersion(ctx.store, change.agent))?.version === change.version
      ? change
      : newerVersion(change.agent);
  if (change.kind !== 'agent-settings') return change;
  const current: Record<string, unknown> = { ...(await savedSettings(ctx, change.agent)) };
  const before: Record<string, unknown> = { ...change.before };
  const after: Record<string, unknown> = { ...change.settings };
  const fields = changedKeys(before, after);
  const moved = fields.filter(key => JSON.stringify(current[key]) !== JSON.stringify(before[key]));
  if (moved.length)
    return `Agent ${change.agent}'s ${moved.join(', ')} changed since this request, so it was not applied. Ask again.`;

  for (const key of fields)
    if (after[key] === undefined) delete current[key];
    else current[key] = after[key];

  return { ...change, settings: current };
}

/** The change a `confirm` route's call asks for, read from its parameters and body. */
function operationOf(
  kind: ChangeKind,
  params: Params,
  body: Record<string, unknown>,
): Change | string {
  if (kind === 'agent-settings') return { kind, agent: params.slug!, settings: body as AgentUsage };
  if (kind === 'agent-version') return { kind, agent: params.slug!, upload: body };
  if (kind === 'model-update') {
    const fields = Object.fromEntries(
      MODEL_FIELDS.filter(key => body[key] !== undefined).map(key => [key, body[key]]),
    );
    return { kind, name: params.name!, fields };
  }
  if (kind === 'model-alias')
    return typeof body.spec === 'string'
      ? { kind, name: params.name!, spec: body.spec }
      : 'An alias needs a spec.';
  if (kind === 'model-enable' || kind === 'model-disable') return { kind, name: params.name! };

  return body.default === true && Object.keys(body).length === 1
    ? { kind, runner: params.id! }
    : "A task changes only a runner's default.";
}

/** The config edit a model change makes, the same one its route makes. */
function modelEdit(change: Extract<Change, { name: string }>) {
  return (config: Parameters<typeof toggleEntry>[0]) =>
    change.kind === 'model-update'
      ? updateEntry(config, change.name, change.fields)
      : change.kind === 'model-alias'
        ? aliasEntry(config, change.name, change.spec)
        : toggleEntry(config, change.name, change.kind === 'model-disable');
}

/** What the change is in words, its diff, and the scopes it may take; refused when the task may not ask for it. */
async function describe(
  ctx: ServerContext,
  change: Change,
  principal: TaskPrincipal,
): Promise<{ reason: string; actions: string[]; scopes: ChangeScope[] } | string> {
  if (change.kind === 'act-as')
    return 'A task asks to act as a person only by using their connection.';
  if (change.kind === 'agent-settings' || change.kind === 'agent-version') {
    if (change.agent !== principal.agent) return 'A task changes only its own agent.';
    if (change.kind === 'agent-settings')
      return {
        reason: `Change agent ${change.agent}'s settings.`,
        actions: diffLines(change.before, change.settings),
        scopes: SCOPES[change.kind],
      };
    const [record, current] = await Promise.all([
      ctx.store.get('agent', change.agent),
      getVersion(ctx.store, change.agent),
    ]);
    const { definition, systemPrompt, files, name, description } = change.upload;
    const actions = [
      ...diffLines({ name: record?.name, description: record?.description }, { name, description }),
      ...diffLines(current?.definition, definition as object),
      ...textLines('instructions', current?.systemPrompt ?? '', String(systemPrompt ?? '')),
      ...fileLines(current?.files, files as Record<string, string> | undefined),
    ];
    if (!actions.length) return 'This publishes nothing new.';

    return {
      reason: `Publish a new version of agent ${change.agent}.`,
      actions,
      scopes: SCOPES[change.kind],
    };
  }
  if (change.kind !== 'runner-default') {
    const config = await shownConfig(ctx);
    const next = structuredClone(config);
    try {
      modelEdit(change)(next);
    } catch (error) {
      return (error as Error).message;
    }
    const verb = {
      'model-update': 'Update',
      'model-alias': 'Alias',
      'model-enable': 'Enable',
      'model-disable': 'Disable',
    }[change.kind];
    const actions = diffLines(config.models?.[change.name] ?? {}, next.models?.[change.name] ?? {});

    return {
      reason: `${verb} model ${change.name} for the workspace.`,
      actions: actions.length ? actions : [`${verb.toLowerCase()} ${change.name}`],
      scopes: SCOPES[change.kind],
    };
  }
  const runner =
    change.runner === serverRunnerId(ctx)
      ? { name: 'Default runner', default: false, scope: 'workspace', owner: undefined }
      : await ctx.store.get('runner', change.runner);
  if (!runner || (runner.scope === 'personal' && runner.owner !== principal.asker))
    return 'Unknown runner';

  return {
    reason: `Make runner ${runner.name} the default.`,
    actions: diffLines({ default: runner.default ?? false }, { default: true }),
    scopes: [runner.scope === 'personal' ? 'personal' : 'workspace'],
  };
}

/** The task a request comes from, read through its own attempt token. */
async function ownTask(req: Request, ctx: ServerContext): Promise<TaskStatus | undefined> {
  const token = bearerToken(req)!;
  const claims = taskClaims(token);
  const state = await ctx.queue.authorize(
    claims.task!,
    taskTokenHash(token),
    claims.attempt!,
    ctx.organizationId,
    (ctx.now ?? Date.now)(),
  );

  return state?.status;
}

/** A Confirm write from a task: recorded as its approval and posted in its conversation; nothing changes yet. */
export async function requestChange(
  req: Request,
  ctx: ServerContext,
  kind: ChangeKind,
  params: Params,
): Promise<Response> {
  const principal = ctx.taskPrincipal!;
  const body = ((await req.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;
  const operation = operationOf(kind, params, body);
  if (typeof operation === 'string') return json({ error: operation }, 400);
  if (operation.kind === 'agent-settings') {
    try {
      operation.settings = await agentSettings(ctx, operation.agent, operation.settings);
    } catch (error) {
      return json({ error: (error as Error).message }, 400);
    }
    operation.before = await savedSettings(ctx, operation.agent);
  }
  // An upload keeps the stored name or description it leaves out, and applies only over the version it was diffed against.
  if (operation.kind === 'agent-version') {
    const [record, current] = await Promise.all([
      ctx.store.get('agent', operation.agent),
      getVersion(ctx.store, operation.agent),
    ]);
    operation.version = current?.version;
    const { name, description } = (operation.upload.definition ?? {}) as AgentUpload;
    operation.upload = {
      ...operation.upload,
      name: operation.upload.name ?? name ?? record?.name,
      description: operation.upload.description ?? description ?? record?.description,
    };
  }
  const described = await describe(ctx, operation, principal);
  if (typeof described === 'string') return json({ error: described }, 403);
  const status = await ownTask(req, ctx);
  if (!status) return json({ error: 'The task has ended.' }, 401);

  const { reason, actions } = described;
  const scopes = described.scopes.filter(scope => scope !== 'personal' || principal.asker);
  if (!scopes.length) return json({ error: 'Only the member who owns this can ask for it.' }, 403);
  const asked = principal.dm && principal.asker ? 'personal' : 'workspace';
  const now = (ctx.now ?? Date.now)();
  const approval: Approval = {
    id: approvalId(now),
    reason,
    actions,
    createdAt: new Date(now).toISOString(),
    change: {
      operation,
      scope: scopes.includes(asked) ? asked : scopes[0]!,
      scopes,
      ...(principal.asker ? { asker: principal.asker } : {}),
    } satisfies ChangeRequest,
  };
  await ctx.queue.patchTask(ctx.organizationId, status.task.id, { approvals: [approval] }, now);
  (ctx.waitUntil ?? (() => {}))(
    syncApprovals(ctx, status.task, [approval]).catch(error =>
      console.error(`coder server: could not post request ${approval.id}`, error),
    ),
  );

  return json(
    {
      pending: true,
      approval: approval.id,
      reason,
      changes: actions,
      scope: changeOf(approval)!.scope,
      ...(status.task.taskUrl ? { url: status.task.taskUrl } : {}),
    },
    202,
  );
}

const approvalId = (now: number) =>
  `apr-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Why a task may not act as `connection`'s owner, for the model; none once the owner approved it for this task. The first use asks them, once. */
export async function actAsRefusal(
  ctx: ServerContext,
  task: AgentTask,
  connection: Connection,
): Promise<string | undefined> {
  const owner = connection.owner!;
  const current = (await ctx.store.get('task', task.id))?.task ?? task;
  const asks = (current.context?.approvals ?? []).filter(approval => {
    const operation = changeOf(approval)?.operation;
    return operation?.kind === 'act-as' && operation.connection.id === connection.id;
  });
  const asked = asks.find(approval => approval.response?.decision !== 'closed');
  // A message from anyone else while this turn runs ends acting as the owner until the next turn.
  const steered = (await readInbox(ctx, task.id)).some(
    entry =>
      entry.kind === 'steer' &&
      typeof entry.value === 'object' &&
      entry.value !== null &&
      'asker' in entry.value &&
      entry.value.asker !== owner,
  );
  if (asked?.response?.decision === 'accept' && !steered) return undefined;
  const links = await ctx.auth?.linkedAccounts?.(owner).catch(() => []);
  const person =
    links?.find(link => link.name)?.name ||
    (owner === current.requestedBy ? current.context?.user?.name : undefined) ||
    'its owner';
  const waiting = `Waiting for ${person} to approve acting as them on ${connection.name}.`;
  if (steered) return waiting;
  if (asked?.response)
    return `${person} declined acting as them on ${connection.name} for this task.`;
  const now = (ctx.now ?? Date.now)();
  // One ask per open round, however many first uses race; a stop closes it, so the next use asks again.
  const first =
    !asked &&
    (await ctx.store.create(
      'delivery',
      `act-as:${task.id}:${connection.id}:${asks.length}`,
      { at: now },
      { ttlMs: ctx.config.taskTimeoutMs ?? 60 * 60 * 1000 },
    ));
  if (first) {
    const approval: Approval = {
      id: approvalId(now),
      reason: `Act as you on ${connection.name} for this task?`,
      actions: [`Act as ${person} on ${connection.name} until this task ends.`],
      createdAt: new Date(now).toISOString(),
      change: {
        operation: {
          kind: 'act-as',
          connection: { id: connection.id, name: connection.name },
          user: { name: person },
        },
        scope: 'personal',
        scopes: ['personal'],
        asker: owner,
      } satisfies ChangeRequest,
    };
    await ctx.queue.patchTask(ctx.organizationId, task.id, { approvals: [approval] }, now);
    (ctx.waitUntil ?? (() => {}))(
      syncApprovals(ctx, current, [approval]).catch(error =>
        console.error(`coder server: could not post request ${approval.id}`, error),
      ),
    );
  }

  return waiting;
}

/** Why `approver` may not approve `request` in `scope`; undefined when they may. */
function approvalProblem(
  ctx: ServerContext,
  request: ChangeRequest,
  scope: ChangeScope,
  approver: Approver | undefined,
): string | undefined {
  if (!request.scopes.includes(scope) || !SCOPES[request.operation.kind].includes(scope))
    return `This change cannot apply to ${scope}.`;
  const allowed =
    !ctx.auth ||
    (approver &&
      (scope === 'agent' ||
        (scope === 'personal' ? approver.id === request.asker : adminRole(approver.role))));

  if (allowed) return undefined;

  return request.operation.kind === 'act-as'
    ? `Only ${request.operation.user.name} answers this.`
    : `Only ${APPROVERS[scope]} approves this.`;
}

/** Makes the change once approved, with the core function its route calls; `approver` owns a personal runner made the default. */
async function apply(
  ctx: ServerContext,
  change: Change,
  scope: ChangeScope,
  approver: Approver | undefined,
): Promise<unknown> {
  if (change.kind === 'act-as') return;
  if (change.kind === 'agent-settings')
    return saveAgentSettings(ctx, change.agent, change.settings);
  // Publishes only over the version it was diffed against, checked in the same store write.
  if (change.kind === 'agent-version')
    return publishUpload(ctx, change.agent, change.upload, { currentVersion: change.version ?? 0 });
  if (change.kind !== 'runner-default') return updateConfig(ctx, modelEdit(change));

  const now = (ctx.now ?? Date.now)();
  return ctx.store.withAppLock(`runners:${ctx.organizationId}`, async store => {
    const builtin = change.runner === serverRunnerId(ctx);
    const existing = builtin ? undefined : await store.get('runner', change.runner);
    const owner = scope === 'personal' ? approver?.id : undefined;
    if (!builtin && (existing?.scope !== scope || existing.owner !== owner))
      throw new CoderError('server', 'Unknown runner', { status: 404 });
    await clearDefaults(store, change.runner, existing, now);
    if (existing)
      await store.put('runner', change.runner, { ...existing, default: true, updatedAt: now });
  });
}

/** Applies an approved change unless what it changes moved since the request, else says what moved; a settings check and write hold the agent's lock, so two approvals never overwrite each other. */
async function applyReviewed(
  ctx: ServerContext,
  change: Change,
  scope: ChangeScope,
  approver: Approver | undefined,
): Promise<string | undefined> {
  const work = async (ctx: ServerContext) => {
    const operation = await reviewed(ctx, change);
    if (typeof operation === 'string') return operation;
    const applied = await apply(ctx, operation, scope, approver);
    if (operation.kind === 'agent-version' && !applied) return newerVersion(operation.agent);
  };
  if (change.kind !== 'agent-settings') return work(ctx);

  return ctx.store.withAppLock(`agent-settings:${ctx.organizationId}:${change.agent}`, store =>
    work({ ...ctx, store }),
  );
}

const answeredBefore = (id: string) => json({ error: `Request "${id}" is already answered` }, 409);

/** Writes the request unless it has an answer already, in one write under the task's row lock; false when another answer landed first. */
const record = (ctx: ServerContext, status: TaskStatus, approval: Approval) =>
  ctx.queue.patchTask(
    ctx.organizationId,
    status.task.id,
    { approvals: [approval] },
    (ctx.now ?? Date.now)(),
    { unanswered: approval.id },
  );

/** Shows a recorded answer in the conversation; a running task hears it as a message. */
async function announce(ctx: ServerContext, status: TaskStatus, answered: Approval) {
  await ctx.store.delete('delivery', askedKey(status.task.id, answered.id));
  (ctx.waitUntil ?? (() => {}))(
    syncApprovals(ctx, status.task, [answered]).catch(error =>
      console.error(`coder server: could not show the decision on ${answered.id}`, error),
    ),
  );
  const current = await ctx.store.get('task', status.task.id);
  const operation = changeOf(answered)!.operation;
  const text =
    operation.kind !== 'act-as'
      ? changeDecisionMessage(answered)
      : answered.response!.decision === 'accept'
        ? `${operation.user.name} approved acting as them on ${operation.connection.name} for this task. Use it now.`
        : `${operation.user.name} declined acting as them on ${operation.connection.name} for this task.`;
  if (current && ACTIVE_STATES.includes(current.status))
    await addInbox(ctx, current, 'steer', { text });

  return answered;
}

/** Approve, deny or ask an admin about a task's Confirm request; approving needs the role its scope asks for. Only the first answer lands, and the change applies only after its accept is recorded. */
export async function decideChange(
  ctx: ServerContext,
  status: TaskStatus,
  approvalId: string,
  value: Record<string, unknown>,
  approver: Approver | undefined,
): Promise<Response> {
  if (ctx.taskPrincipal) return json({ error: 'A person answers this, not a task.' }, 403);
  const approval = (status.task.context?.approvals ?? []).find(entry => entry.id === approvalId);
  const change = changeOf(approval);
  if (!approval || !change)
    return json({ error: `Task "${status.task.id}" has no request "${approvalId}"` }, 409);
  if (approval.response) return answeredBefore(approvalId);
  const scope = (typeof value.scope === 'string' ? value.scope : change.scope) as ChangeScope;
  const decision = value.decision;
  const by = approver?.name || undefined;
  // Acting as a person is theirs alone to answer, either way.
  if (change.operation.kind === 'act-as') {
    const problem = approvalProblem(ctx, change, scope, approver);
    if (problem || decision === 'ask')
      return json({ error: problem ?? 'Only the person it acts as answers this.' }, 403);
  }

  if (decision === 'ask') {
    if (!approver) return json({ error: 'Asking an admin needs a member linked to Coder.' }, 403);
    const asked: ChangeRequest = { ...change, scope, askedAdmin: by ?? approver.id };
    if (!(await record(ctx, status, { ...approval, change: asked })))
      return answeredBefore(approvalId);
    await ctx.store.put(
      'delivery',
      askedKey(status.task.id, approval.id),
      {
        task: status.task.id,
        approval: approval.id,
        reason: approval.reason,
        by: asked.askedAdmin!,
        at: (ctx.now ?? Date.now)(),
      } satisfies PendingApproval,
      { ttlMs: ASKED_TTL_MS },
    );

    return json({ asked: true });
  }

  const answeredAt = new Date((ctx.now ?? Date.now)()).toISOString();
  if (decision === 'deny' || decision === 'decline') {
    const reason = typeof value.reason === 'string' && value.reason ? value.reason : undefined;
    const denied: Approval = {
      ...approval,
      change,
      response: {
        decision: 'decline',
        answeredAt,
        ...(reason ? { reason } : {}),
        ...(by ? { by } : {}),
      },
    };
    if (!(await record(ctx, status, denied))) return answeredBefore(approvalId);

    return json(await announce(ctx, status, denied));
  }

  if (decision !== 'accept')
    return json({ error: 'Give a decision: accept, decline or ask.' }, 400);
  const problem = approvalProblem(ctx, change, scope, approver);
  if (problem) return json({ error: problem }, 403);
  const accepted: Approval = {
    ...approval,
    change: { ...change, scope },
    response: { decision: 'accept', answeredAt, ...(by ? { by } : {}) },
  };
  if (!(await record(ctx, status, accepted))) return answeredBefore(approvalId);
  let moved: string | undefined;
  try {
    moved = await applyReviewed(ctx, change.operation, scope, approver);
  } catch (error) {
    // The change did not happen, so the request is open again.
    await ctx.queue.patchTask(
      ctx.organizationId,
      status.task.id,
      { approvals: [{ ...approval, change, response: null }] },
      (ctx.now ?? Date.now)(),
    );
    const code = error instanceof CoderError ? (error.status ?? 400) : 400;
    return json({ error: (error as Error).message }, code);
  }
  if (moved) {
    // The accept stays this request's one answer, recorded as refused for what moved.
    const refused: Approval = {
      ...approval,
      change,
      response: { decision: 'decline', answeredAt, reason: moved },
    };
    await ctx.queue.patchTask(
      ctx.organizationId,
      status.task.id,
      { approvals: [refused] },
      (ctx.now ?? Date.now)(),
    );
    await announce(ctx, status, refused);

    return json({ error: moved }, 409);
  }

  return json(await announce(ctx, status, accepted));
}

/** A decision from the dashboard: the signed-in member is the approver. */
export async function decideRequest(
  req: Request,
  ctx: ServerContext,
  params: Params,
): Promise<Response> {
  const status = ctx.routeTask ?? (await ctx.store.get('task', params.id!));
  if (!status) return json({ error: `No task "${params.id}"` }, 404);
  const value = ((await req.json().catch(() => undefined)) ?? {}) as Record<string, unknown>;

  return decideChange(ctx, status, params.approval!, value, await sessionApprover(ctx));
}

/** Changes waiting for an admin's approval, newest first. */
export async function adminApprovals(ctx: ServerContext): Promise<PendingApproval[]> {
  const rows = await ctx.store.list<PendingApproval>('delivery', { prefix: 'admin-ask:' });

  return rows.map(row => row.value).sort((left, right) => right.at - left.at);
}

export async function listPendingApprovals(ctx: ServerContext): Promise<Response> {
  return json(await adminApprovals(ctx));
}
