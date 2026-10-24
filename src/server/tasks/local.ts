import { agentAccess } from '../../agent/definition';
/** A local server's tasks are the CLI's own: `coder task run` tasks show here, and dashboard tasks run through the same broker. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile, spawn, type ChildProcess } from 'node:child_process';

import { processTiming } from '../../utils/process';

import { AGENT_TASK_PREFIX, execAgent, agentTaskOptions, threadReply } from '../../agent/exec';
import type { AgentEvent, AgentTask, TaskContext, TaskSource } from '../../agent/types';
import { defaultAgent } from '../../agent/load';
import { pendingCall } from '../../core/task/async';
import type { TaskTurn } from '../../client/types';
import type { TaskLogLine, TaskStatus, UsageRecord } from '../store/types';
import {
  answerTaskApproval,
  deleteTask,
  stopTask,
  askTask,
  steerTask,
  recentTasks,
} from '../../core/task/actions';
import {
  listApprovals,
  pendingApprovals,
  stoppedMessage,
  withDecisions,
} from '../../core/approvals';
import { isEndpointModel, loadConfig, splitEngineSpec, type Access } from '../../core/config';
import { logEntry, SKIPPED } from '../../core/task/view';
import {
  CoderError,
  dispatchTask,
  readResultJson,
  resolveTaskOptions,
  spawnWorker,
  selectMcpServers,
} from '../../core/dispatch';
import {
  appendTaskLog,
  archiveDue,
  archiveTask,
  generateTaskId,
  queueRowWins,
  listArchivedTasks,
  listTasks,
  loadTask,
  pidIsOurWorker,
  processStarts,
  reconcileTask,
  turnPending,
  resolveArchiveDir,
  resolveUsageFile,
  resolveUsageTempFile,
  taskDirectories,
  type TurnResultEntry,
  resolveTaskDir,
  readTurnResults,
  watchTask,
  writeTask,
} from '../../core/state';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  type Approval,
  type Task,
  type Availability,
} from '../../core/types';
import { readFlowRecord } from '../../flow/runs';
import { stopRun, stopFlowTasks } from '../../flow/executor';
import { applyTaskMessage } from '../../runner/task';
import { readJsonFile, writeJsonFileAtomic } from '../../utils/fsx';
import type { ServerContext } from '../context';
import { eventTokens, taskDashboard } from './context';
import { connectionGrants } from '../connections/records';
import { resolveConnections, taskConnectionSecrets } from '../connections/resolve';
import { connectionEnvironment, narrowConnections } from '../../core/connections';
import { nativeToolEnvironment, type ReplyEndpoint } from '../../agent/mcp';
import { taskWarnings } from './logs';
import {
  assertEnabled,
  check,
  refreshedTask,
  TaskInputError,
  taskCwd,
  unknownOption,
  type NewTask,
} from './create';
import { deliverWaiting, rememberPost } from './conversation';
import { syncApprovals, type ApprovalPost } from './approvals';
import {
  sessionKey,
  pushInbox,
  taskTimes,
  type TaskFence,
  type InboxEntry,
  type InboxAck,
} from './queue';
import { kick, scheduleKick } from './kick';
import { chooseRunner } from '../runners/select';
import { syncLocalAgents } from '../store/local';
import { agentWithVersion } from '../agents/records';
import { getClaudeAvailability } from '../../core/engines/claude';
import { getCodexAvailability } from '../../core/engines/codex';

const own = (task: Task) => !task.name?.startsWith(AGENT_TASK_PREFIX);
const at = (value?: string | null) => (value ? Date.parse(value) : undefined);

function row(cwd: string, task: Task, detail = false): TaskStatus {
  const createdAt = at(task.createdAt) ?? 0;
  const answers = readJsonFile<unknown[]>(path.join(resolveTaskDir(cwd, task.id), 'answers.json'));
  // A pending escalation shows whatever the task is doing; the task answers it when told.
  const approvals = listApprovals(resolveTaskDir(cwd, task.id));
  const approval = approvals.find(entry => !entry.response);
  const result = detail ? readResultJson(cwd, task.id, task) : null;
  const turns: TaskTurn[] = detail
    ? readTurnResults(cwd, task.id)
        .filter(
          entry =>
            !ACTIVE_STATUSES.includes(task.status) ||
            (at(entry.at) ?? 0) < (at(task.resumedAt) ?? createdAt),
        )
        .map(entry => {
          const error =
            entry.error && typeof entry.error === 'object'
              ? (entry.error as { message?: string }).message
              : undefined;
          return {
            prompt: entry.prompt ?? task.prompt ?? '',
            result: { ok: entry.status === 0, output: entry.finalMessage ?? error ?? '' },
            ...(error ? { error } : {}),
            finishedAt: at(entry.at),
          };
        })
    : [];
  if (
    detail &&
    (ACTIVE_STATUSES.includes(task.status) ||
      !turns.length ||
      (turns.at(-1)?.finishedAt ?? 0) < (at(task.resumedAt) ?? createdAt))
  )
    turns.push({
      prompt: task.currentPrompt ?? task.prompt ?? '',
      ...(result
        ? {
            result: {
              ok: result.status === 0,
              output: result.finalMessage ?? result.error?.message ?? '',
            },
          }
        : {}),
      ...(task.error ? { error: task.error } : {}),
      ...(!ACTIVE_STATUSES.includes(task.status) ? { finishedAt: at(task.completedAt) } : {}),
    });
  const flow = task.flowRunId ? readFlowRecord(task.flowRunId)?.name : undefined;
  const status: TaskStatus = {
    task: {
      id: task.id,
      source: (task.source ?? 'cli') as TaskSource,
      agent: task.agentId ?? defaultAgent() ?? '',
      flow: flow ?? 'default',
      ...(task.name
        ? { name: task.name }
        : flow
          ? { name: flow === 'review' ? 'Review' : flow }
          : {}),
      runner: 'local',
      ...(task.cwd ? { cwd: task.cwd } : {}),
      ...(task.access ? { access: task.access } : {}),
      // The row keeps the first turn's prompt, which titles the task.
      ...(task.prompt ? { prompt: task.prompt } : {}),
      definition: { integrations: {} },
      ...(task.engine
        ? {
            usage: {
              engine: task.engine,
              ...(task.model ? { model: task.model } : {}),
              ...(task.effort ? { effort: task.effort } : {}),
            },
          }
        : {}),
      tools: {},
    },
    status:
      approval && task.status === 'running'
        ? 'waiting'
        : turnPending(cwd, task)
          ? 'running'
          : task.status,
    attempts: 1,
    ...(approval ? { approval } : {}),
    ...(approvals.length ? { approvals } : {}),
    ...(answers ? { answer: answers } : {}),
    ...(result
      ? {
          result: {
            ok: result.status === 0,
            exitCode: null,
            output: result.finalMessage ?? result.error?.message ?? '',
          },
          ...(result.tokens ? { tokens: result.tokens } : {}),
        }
      : {}),
    ...(task.error ? { error: task.error } : {}),
    ...(task.fallbacks?.length ? { fallbacks: task.fallbacks } : {}),
    ...(task.archivedAt ? { archivedAt: at(task.archivedAt) } : {}),
    ...(task.autoArchived ? { autoArchived: true as const } : {}),
    createdAt,
    // The current turn's start, as a stored task's, so a resume shows as a new run.
    startedAt: at(task.resumedAt) ?? createdAt,
    // A resumed turn still carries the last turn's completedAt until it finishes.
    ...(task.completedAt && !ACTIVE_STATUSES.includes(task.status)
      ? { finishedAt: at(task.completedAt) }
      : {}),
    updatedAt: at(task.updatedAt) ?? createdAt,
    local: true,
    ...(detail ? { turns: withDecisions(turns, approvals) } : {}),
  };

  return { ...status, ...taskTimes(status) };
}

/** Local tasks after the CLI's auto-archive sweep, without the engine tasks that server tasks ran on. */
export function localTasks(cwd: string, archived: boolean): TaskStatus[] {
  const recent = recentTasks(cwd);
  const tasks = archived ? listArchivedTasks(cwd, { migrate: false }) : recent;
  return tasks.filter(own).map(task => {
    const status = row(cwd, task);
    return archived ? { ...status, archivedAt: status.archivedAt ?? status.updatedAt } : status;
  });
}

/** The CLI's auto-archive sweep on queue rows that are the task, by their own stopped time. */
export async function sweepLocalQueue(ctx: ServerContext, cwd: string): Promise<void> {
  const now = (ctx.now ?? Date.now)();
  const ids = (
    await ctx.queue.list(ctx.organizationId, { archived: false, statuses: [...TERMINAL_STATUSES] })
  )
    .filter(row => archiveDue(row.finishedAt ?? row.updatedAt, now) && queueRowWins(cwd, row))
    .map(row => row.task.id);

  if (ids.length) await ctx.queue.archiveStopped(ctx.organizationId, now, ids);
}

/** The sweep over tasks with a posted approval: posts and decisions not yet shown, and answers the task has not heard; a running task's watch does this sooner. */
export async function syncLocalApprovals(ctx: ServerContext): Promise<void> {
  const rows = await ctx.store.list<ApprovalPost>('delivery', { prefix: 'approval:' });
  for (const taskId of new Set(rows.map(row => row.value.notice.task))) {
    const status = await ctx.store.get('task', taskId);
    if (!status) continue;
    const cwd = status.task.cwd ?? ctx.local!.cwd;
    const approvals = listApprovals(resolveTaskDir(cwd, taskId));

    await redeliverAnswers(ctx, cwd, taskId, approvals);
    await syncApprovals(ctx, status.task, approvals);
  }
}

/** How long an answer's own delivery gets before the sweep delivers it again. */
const REDELIVER_AFTER_MS = 60_000;

/** Answers recorded in the task's folder that never reached it (a steer or resume that failed) are delivered again; the sweep's job, since a resume waits for the task's watch to end. */
async function redeliverAnswers(
  ctx: ServerContext,
  cwd: string,
  id: string,
  approvals: Approval[],
): Promise<void> {
  const now = (ctx.now ?? Date.now)();
  for (const approval of approvals) {
    if (
      !approval.response ||
      approval.response.deliveredAt ||
      approval.response.decision === 'closed'
    )
      continue;
    // A fresh answer is still being delivered by whoever recorded it.
    if (now - Date.parse(approval.response.answeredAt ?? '') < REDELIVER_AFTER_MS) continue;
    const task = loadTask(cwd, id);
    if (!task) return;
    await answerTaskApproval(cwd, task, approval.id, approval.response.decision, {
      ...(approval.response.reason ? { reason: approval.response.reason } : {}),
      resume: text => resumeLocalTask(ctx, cwd, id, text),
    }).catch(error =>
      console.error(`coder server: could not deliver the answer to approval ${approval.id}`, error),
    );
  }
}

/** Spawn a dashboard task; its worker records startup failures on the task. */
export async function startLocalTask(
  ctx: ServerContext,
  input: NewTask,
  taskId?: string,
): Promise<TaskStatus | undefined> {
  if (
    !ctx.local ||
    input.repo ||
    (input.flow ?? 'default') !== 'default' ||
    (input.runner && input.runner !== 'local')
  )
    return undefined;
  const cwd = taskCwd(ctx, input) ?? ctx.local.cwd;
  await syncLocalAgents(ctx.store, cwd, ctx.integrations);
  const preferred = defaultAgent();
  const slug = input.agent ?? preferred;
  if (!slug) throw new TaskInputError('Name an agent: this server has no default agent.');
  const { record, version } = await agentWithVersion(ctx.store, slug);
  assertEnabled(ctx, slug, record);
  const route = await chooseRunner(ctx, {
    requestedBy: ctx.session?.user.id,
    runner: input.runner,
    agent: version?.definition.runner,
  }).catch((error: Error) => {
    throw new TaskInputError(error.message);
  });
  if (route.runner !== 'local' || route.runnerId) return undefined;
  check(input);
  if (!taskId) {
    const task: AgentTask = {
      id: generateTaskId(),
      source: 'dashboard',
      agent: slug,
      flow: 'default',
      runner: 'local',
      cwd,
      ...(input.name ? { name: input.name } : {}),
      ...(input.access ? { access: input.access } : {}),
      prompt: input.prompt,
      definition: version?.definition ?? { integrations: {} },
      ...(record?.settings ? { usage: record.settings } : {}),
      connections: await connectionGrants(
        ctx,
        undefined,
        narrowConnections(record?.settings?.connections, input.connections),
      ),
      tools: {},
    };
    return enqueueLocalTask(ctx, task, { input, cwd });
  }
  try {
    const saved = taskId ? await ctx.store.get('task', taskId) : undefined;
    const granted =
      saved?.task.connections ??
      (await connectionGrants(
        ctx,
        undefined,
        narrowConnections(record?.settings?.connections, input.connections),
      ));
    const resolved = await resolveConnections(
      ctx,
      saved?.task ??
        ({
          connections: granted,
          access: input.access,
          tools: {},
          definition: version?.definition ?? { integrations: {} },
          ...(record?.settings ? { usage: record.settings } : {}),
        } as AgentTask),
    );
    const connected = connectionEnvironment(resolved.mcp, resolved.env);
    const agent =
      slug !== preferred
        ? await agentTaskOptions(
            cwd,
            slug,
            input.mcp?.join(','),
            connected.mcp,
            undefined,
            input.access,
          )
        : undefined;
    const selectedMcp =
      agent ?? selectMcpServers(input.mcp?.join(','), loadConfig(cwd).mcp, {}, connected.mcp);
    const fallbacks: NonNullable<Task['fallbacks']> = [];
    const dispatched = await dispatchTask(
      {
        taskId,
        prompt: input.prompt ?? '',
        outputSchema: input.outputSchema,
        cwd,
        name: input.name,
        appendSystem: input.appendSystem,
        addDirs: input.addDirs,
        engine: input.model ? undefined : agent?.engine,
        model: input.model ?? agent?.model,
        effort: input.model ? undefined : agent?.effort,
        access: agent?.access ?? input.access,
        ...(agent
          ? {
              agentPrompt: {
                developer: agent.developer,
                access: agentAccess(
                  {
                    definition: version?.definition ?? { integrations: {} },
                    ...(record?.settings ? { usage: record.settings } : {}),
                  },
                  saved?.task.access,
                ),
              },
            }
          : {}),
        mcp: selectedMcp.mcp,
        mcpBindings: selectedMcp.mcpBindings,
        mcpWarnings: [...(selectedMcp.warnings ?? []), ...resolved.warnings],
        connectionEnv: connected.env,
        connections: granted,
        nativeMcp: selectedMcp.nativeMcp,
        ...(agent ? { agentId: input.agent } : {}),
        source: 'dashboard',
        onFallback: info => fallbacks.push(info),
      },
      { waitForStartup: false },
    );
    const task = fallbacks.length
      ? writeTask(cwd, dispatched.taskId, { fallbacks })
      : dispatched.task;
    return row(cwd, task);
  } catch (error) {
    if (error instanceof CoderError) throw new TaskInputError(error.message, 409);
    throw error;
  }
}

export interface LocalCompletion {
  task: AgentTask;
  cwd: string;
  fence?: TaskFence;
  /** Turns the task had before this run; the run posts the ones after them. */
  turns?: number;
}

export interface LocalStart {
  cwd: string;
  input?: NewTask;
  resume?: boolean;
  /** The model or a lower access the resumed turn runs with instead of the task's. */
  overrides?: { model?: string; access?: Access };
  startedId?: string;
}

async function enqueueLocalTask(
  ctx: ServerContext,
  task: AgentTask,
  start: LocalStart,
): Promise<TaskStatus> {
  const now = (ctx.now ?? Date.now)();

  await ctx.store.put('snapshot', `local-start:${task.id}`, start);
  await ctx.queue.enqueue(ctx.organizationId, task, now, undefined, ctx.config.maxQueued ?? 1000);
  await kick(ctx, false, true, true);

  const saved = await ctx.store.get('task', task.id);

  return saved?.status === 'queued' ? saved : (localTask(start.cwd, task.id) ?? saved!);
}

export async function startQueuedLocalTask(
  ctx: ServerContext,
  status: TaskStatus,
  token?: string,
): Promise<boolean> {
  if (
    !ctx.local ||
    status.task.runner !== 'local' ||
    status.task.runnerId ||
    status.task.event?.repo
  )
    return false;
  const start = await ctx.store.get<LocalStart>('snapshot', `local-start:${status.task.id}`);
  if (!start) return false;
  try {
    let startedId = status.task.id;
    let worker: ChildProcess | undefined;
    const turns = start.resume ? readTurnResults(start.cwd, status.task.id).length : 0;
    const existing =
      status.task.flow === 'default' ? loadTask(start.cwd, status.task.id) : undefined;
    const reply = token
      ? replyEndpoint(ctx, status.task.id, token, await taskDashboard(ctx))
      : undefined;
    if (existing && !start.resume) startedId = existing.id;
    else if (start.resume) {
      const task = loadTask(start.cwd, status.task.id);
      if (!task) throw new Error('Local task is missing');
      await steerTask(start.cwd, task, status.task.prompt ?? '', {
        onWorker: child => {
          worker = child;
        },
        outputSchema: status.task.context?.outputSchema,
        ...start.overrides,
        resolveConnections: granted => turnConnections(ctx, status.task, granted, reply),
      });
    } else if (start.input)
      await startLocalTask(
        ctx,
        {
          ...start.input,
          prompt: status.task.prompt,
          outputSchema: status.task.context?.outputSchema ?? start.input.outputSchema,
        },
        status.task.id,
      );
    else startedId = (await runLocalTask(ctx, status.task, status.task.id, true, reply)).task.id;
    await ctx.store.put('snapshot', `local-start:${status.task.id}`, { ...start, startedId });
    const fence: TaskFence = {
      attempts: status.attempts,
      tokenHash: status.tokenHash,
      generation: status.generation ?? 0,
      statuses: ['running', 'waiting'],
    };
    if (
      !(await ctx.queue.patchTask(
        ctx.organizationId,
        status.task.id,
        { handle: `cli:${startedId}` },
        (ctx.now ?? Date.now)(),
        fence,
      ))
    ) {
      const task = loadTask(start.cwd, startedId);
      if (task) await stopTask(start.cwd, task);
      return true;
    }
    if (status.task.flow === 'default') {
      const completion: LocalCompletion = { task: status.task, cwd: start.cwd, fence, turns };
      await ctx.store.put('snapshot', `completion:${startedId}`, completion);
      watchCompletion(ctx, startedId, completion, worker);
      const inbox = pushInbox(ctx, status.task.id);
      if (ctx.waitUntil) ctx.waitUntil(inbox);
      else void inbox;
    }
  } catch (error) {
    if (
      await ctx.queue.finish(
        ctx.organizationId,
        status.task.id,
        { status: 'failed', error: error instanceof Error ? error.message : String(error) },
        (ctx.now ?? Date.now)(),
        { attempts: status.attempts, tokenHash: status.tokenHash },
      )
    ) {
      const { reportTaskFailure } = await import('./events');
      await reportTaskFailure(ctx, status, error);
    }
  }
  return true;
}

export async function inspectLocalTask(
  ctx: ServerContext,
  status: TaskStatus,
  now: number,
): Promise<boolean> {
  if (status.status !== 'running' && status.status !== 'waiting') return false;
  if (
    status.task.flow === 'default' &&
    ctx.store.localFlows?.has(status.task.id) &&
    status.cancelRequestedAt === undefined &&
    (status.startedAt === undefined || now - status.startedAt < ctx.config.taskTimeoutMs)
  )
    return false;
  const start = await ctx.store.get<LocalStart>('snapshot', `local-start:${status.task.id}`);
  if (!start) return false;
  const fence: TaskFence = {
    attempts: status.attempts,
    tokenHash: status.tokenHash,
    generation: status.generation ?? 0,
    statuses: ['running', 'waiting'],
  };
  if (status.task.flow !== 'default') {
    let flow = readFlowRecord(status.task.id);
    if (
      flow?.status === 'running' &&
      (status.cancelRequestedAt !== undefined ||
        (status.startedAt !== undefined && now - status.startedAt >= ctx.config.taskTimeoutMs))
    ) {
      const control = ctx.store.localFlows?.get(status.task.id);
      if (control) {
        await control.stop();
        await control.work.catch(() => {});
      } else if (flow.pid !== process.pid) await stopRun(status.task.id);
      flow = readFlowRecord(status.task.id);
    }
    if (!flow || flow.status === 'running') return false;
    return ctx.queue.finish(
      ctx.organizationId,
      status.task.id,
      {
        status:
          status.cancelRequestedAt !== undefined
            ? 'cancelled'
            : flow.status === 'completed'
              ? 'completed'
              : 'failed',
        error: flow.error,
      },
      now,
      fence,
    );
  }
  let current = localTask(start.cwd, start.startedId ?? status.task.id);
  if (!current) return false;
  if (['queued', 'running', 'waiting'].includes(current.status)) {
    if (
      status.cancelRequestedAt !== undefined ||
      (status.startedAt !== undefined && now - status.startedAt >= ctx.config.taskTimeoutMs)
    ) {
      const task = loadTask(start.cwd, start.startedId ?? status.task.id);
      if (task) await stopTask(start.cwd, task);
      current = localTask(start.cwd, status.task.id)!;
    } else return false;
  }
  const state = current.status;
  if (state !== 'completed' && state !== 'failed' && state !== 'cancelled') return false;
  const finished = await ctx.queue.finish(
    ctx.organizationId,
    status.task.id,
    { status: state, result: current.result, error: current.error },
    now,
    fence,
  );
  if (finished) deliverWaiting(ctx, status.task);

  return finished;
}

function watchCompletion(
  ctx: ServerContext,
  id: string,
  saved: LocalCompletion,
  worker?: ChildProcess,
): void {
  const watches = (ctx.store.completionWatches ??= new Map());
  if (watches.has(id)) return;
  const watch = { stopped: false, work: Promise.resolve() };
  watches.set(id, watch);
  watch.work = (async () => {
    const key = `completion:${id}:${saved.fence?.generation ?? 0}`;
    const previous = await ctx.store.get<{
      owner?: string;
      pid?: number;
      turns?: number;
      posting?: number;
    }>('delivery', key);
    if (previous && !previous.owner) return;
    if (previous?.posting !== undefined) {
      console.error(
        `coder server: local completion ${id} has an interrupted post for turn ${previous.posting + 1}; retained for reconciliation`,
      );
      return;
    }
    if (previous?.pid) {
      try {
        process.kill(previous.pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
    }

    const owner = randomUUID();
    let receipt: typeof previous & { owner: string; pending: boolean; turns: number } = {
      owner,
      pid: process.pid,
      pending: true,
      turns: previous?.turns ?? saved.turns ?? 0,
    };
    if (previous?.owner) {
      if (!(await ctx.store.updateDelivery(key, previous.owner, receipt))) return;
    } else if (!(await ctx.store.create('delivery', key, receipt))) return;

    const owns = async () => {
      if (!saved.fence) return true;
      const current = await ctx.store.get('task', saved.task.id);
      return (
        current &&
        (current.generation ?? 0) === saved.fence.generation &&
        current.attempts === saved.fence.attempts &&
        current.tokenHash === saved.fence.tokenHash &&
        current.status !== 'queued'
      );
    };
    let replies: Awaited<ReturnType<(typeof import('../chat'))['eventReplies']>> | undefined;
    const conversationReplies = async () => {
      const event = saved.task.event;
      if (!event || saved.task.source !== event.integration)
        throw new Error('The task has no conversation');

      if (!(await owns())) throw new Error('The conversation task is no longer running');

      if (!replies) {
        const app = await ctx.store.get('app', event.appId);
        if (!app) throw new Error('Local completion has no app');
        const { eventReplies } = await import('../chat');
        const turn = await ctx.store.get('task', saved.task.id);
        replies = await eventReplies(ctx, app, event, turn);
      }

      return replies;
    };
    const post = async (text: string, notice?: string) => {
      const replies = await conversationReplies();
      const sent = await replies.post(text, notice);
      if (receipt.posting !== undefined)
        receipt = { ...receipt, turns: receipt.posting + 1, posting: undefined };
      if (sent)
        await rememberPost(
          ctx,
          saved.task.event!,
          sent.ids ?? (sent.id ? [sent.id] : []),
          Date.now(),
        );
    };
    const startMs = processStarts();
    const resultSignal = watchTask(saved.cwd, id, worker);
    let pollMs = 100;
    const synced = new Map<string, string>();
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const reply = async (
            result: Parameters<typeof threadReply>[1],
            cancelled: boolean,
            turn?: TurnResultEntry,
          ) => {
            if (saved.task.source !== saved.task.event?.integration) return;
            processTiming('completion.reply', { id });
            const answer = threadReply(saved.task, result, cancelled, turn);
            if (answer.skipped) appendTaskLog(saved.cwd, id, { kind: 'status', message: SKIPPED });
            // The notice goes with this run's first reply.
            const notice = receipt.turns === (saved.turns ?? 0) ? answer.notice : undefined;
            if (answer.text && !answer.duplicate) await post(answer.text, notice);
          };

          for (;;) {
            if (watch.stopped) return;
            if (!(await owns())) return;
            const found = loadTask(saved.cwd, id);
            if (!found) return;
            const turns = readTurnResults(saved.cwd, id);

            for (const turn of turns.slice(receipt.turns)) {
              if (turn.status !== 0 && ctx.local) ctx.local.engineChecks = undefined;
              const result = { finalMessage: turn.finalMessage, error: turn.error };
              const answer = threadReply(saved.task, result, false, turn);
              const sending =
                saved.task.source === saved.task.event?.integration &&
                answer.text &&
                !answer.duplicate;
              if (sending) await conversationReplies();
              const next = receipt.turns + 1;
              receipt = { ...receipt, posting: sending ? receipt.turns : undefined };
              if (!(await ctx.store.updateDelivery(key, owner, receipt))) return;
              await reply(result, false, turn);
              receipt = { ...receipt, turns: next, posting: undefined };
              if (!(await ctx.store.updateDelivery(key, owner, receipt))) return;
            }
            // Each approval syncs when it appears or its answer changes; a failed call waits for the sweep.
            const approvals = listApprovals(resolveTaskDir(saved.cwd, id));
            const changed = approvals.filter(
              entry =>
                synced.get(entry.id) !==
                `${entry.response?.answeredAt ?? ''}:${entry.response?.deliveredAt ?? ''}`,
            );
            if (changed.length) {
              await syncApprovals(ctx, { ...saved.task, id }, changed);
              for (const entry of listApprovals(resolveTaskDir(saved.cwd, id)))
                synced.set(
                  entry.id,
                  `${entry.response?.answeredAt ?? ''}:${entry.response?.deliveredAt ?? ''}`,
                );
            }
            const task = reconcileTask(saved.cwd, found, startMs);
            // A completed turn's worker may still run queued steers, a summary or a review's result.
            const ended =
              !ACTIVE_STATUSES.includes(task.status) &&
              !(task.pid && pidIsOurWorker(task.pid, task, startMs)) &&
              !pendingCall(resolveTaskDir(saved.cwd, id));
            const done =
              ended && (task.status !== 'completed' || turns.length > (saved.turns ?? 0));
            if (done) {
              const queued = await ctx.store.get('task', saved.task.id);
              if (
                saved.fence &&
                queued &&
                (queued.generation ?? 0) === saved.fence.generation &&
                queued.attempts === saved.fence.attempts &&
                queued.tokenHash === saved.fence.tokenHash &&
                (await inspectLocalTask(ctx, queued, (ctx.now ?? Date.now)()))
              )
                scheduleKick(ctx, true);

              // A turn that ended without a recorded result still answers with its failure.
              const cancelled = task.status === 'cancelled';
              if (
                (cancelled || task.error) &&
                turns.at(-1)?.prompt !== (task.currentPrompt ?? task.prompt ?? null)
              ) {
                if (!(await ctx.store.updateDelivery(key, owner, receipt))) return;
                await reply({ error: { message: task.error ?? 'Task cancelled' } }, cancelled);
              }
              // Read after the replies, so a turn they cleared does nothing more.
              const ended = await ctx.store.get('task', saved.task.id);
              const { endTyping } = await import('../chat');
              if (ended)
                await endTyping(ctx, ended).catch(error =>
                  console.error(
                    `coder server: could not clear the working indicator of ${id}`,
                    error,
                  ),
                );
              break;
            }
            await resultSignal.wait(pollMs);
            pollMs = Math.min(1000, pollMs * 2);
          }

          if (
            await ctx.store.updateDelivery(key, owner, {
              posted: true,
              turns: receipt.turns,
              at: Date.now(),
            })
          ) {
            const current = await ctx.store.get<LocalCompletion>('snapshot', `completion:${id}`);
            if (current?.fence?.generation === saved.fence?.generation)
              await ctx.store.delete('snapshot', `completion:${id}`);
          }

          return;
        } catch (error) {
          if (attempt === 4) throw error;
          console.error(
            `coder server: local completion ${id} attempt ${attempt + 1} failed, retrying`,
            error,
          );
          const now = ctx.now ?? Date.now;
          const retryAt = now() + 5000 * 2 ** attempt;
          while (!watch.stopped && now() < retryAt)
            await new Promise(resolve => setTimeout(resolve, Math.min(100, retryAt - now())));
        }
      }
    } finally {
      resultSignal.close();
      await ctx.store.updateDelivery(key, owner, { ...receipt, pid: undefined });
    }
  })()
    .catch(error => {
      console.error(`coder server: local completion ${id} failed`, error);
    })
    .finally(() => {
      watches!.delete(id);
    });
}

export async function recoverLocalTasks(ctx: ServerContext): Promise<void> {
  if (!ctx.local) return;
  for (const { id, value } of await ctx.store.list<LocalCompletion>('snapshot', {
    prefix: 'completion:',
  }))
    if (loadTask(value.cwd, id.slice('completion:'.length)))
      watchCompletion(ctx, id.slice('completion:'.length), value);
}

export async function stopLocalTasks(ctx: ServerContext): Promise<void> {
  await Promise.all(
    [...(ctx.store.localFlows?.values() ?? [])].map(async flow => {
      await flow.stop();
      await flow.work.catch(() => {});
    }),
  );
  const watches = ctx.store.completionWatches;
  if (!watches) return;
  for (const watch of watches.values()) watch.stopped = true;
  await Promise.all([...watches.values()].map(watch => watch.work));
}

/** A resumed turn's connections and tool tokens, resolved afresh the way its first turn's were. */
/** The conversation tools post to this server's own task callback path on the attempt's token. */
function replyEndpoint(
  ctx: ServerContext,
  taskId: string,
  token: string,
  dashboard?: string,
): ReplyEndpoint {
  return {
    url: `http://127.0.0.1:${ctx.local!.port}/tasks/${encodeURIComponent(taskId)}`,
    token,
    ...(dashboard ? { dashboard } : {}),
  };
}

async function turnConnections(
  ctx: ServerContext,
  task: AgentTask,
  granted: string[],
  reply?: ReplyEndpoint,
) {
  const { tokens: handles } = await eventTokens(ctx, task);
  const resolved = await resolveConnections(ctx, { ...task, connections: granted }, handles);
  await taskConnectionSecrets(ctx, task.id, [
    ...resolved.secrets,
    ...Object.values(resolved.tokens),
  ]);
  const connected = connectionEnvironment(resolved.mcp, resolved.env);
  const native = nativeToolEnvironment(task, resolved.tokens, reply);

  return {
    mcp: connected.mcp,
    env: { ...connected.env, ...native.env },
    warnings: resolved.warnings,
  };
}

/** Run a server task as CLI tasks on this machine, as a runner would, and answer once the first one exists. */
export async function runLocalTask(
  ctx: ServerContext,
  task: AgentTask,
  taskId?: string,
  admitted = false,
  reply?: ReplyEndpoint,
): Promise<TaskStatus> {
  if (task.event?.repo) {
    const now = (ctx.now ?? Date.now)();
    const id = taskId ?? task.id;
    const queued = await ctx.store.get('task', id);
    if (!queued)
      await ctx.queue.enqueue(
        ctx.organizationId,
        { ...task, id },
        now,
        undefined,
        ctx.config.maxQueued ?? 1000,
      );

    await kick(ctx, false, false, true);

    return (await ctx.store.get('task', id))!;
  }
  if (!admitted) {
    const cwd = taskCwd(ctx, task) ?? ctx.local!.cwd;
    return enqueueLocalTask(ctx, { ...task, id: taskId ?? generateTaskId(), cwd }, { cwd });
  }

  const { tokens: handles } = await eventTokens(ctx, task);
  const resolved = await resolveConnections(ctx, task, handles);
  await taskWarnings(ctx, taskId ?? task.id, resolved.warnings);
  await taskConnectionSecrets(ctx, taskId ?? task.id, [
    ...resolved.secrets,
    ...Object.values(resolved.tokens),
  ]);
  const tokens = resolved.tokens;
  const token = task.event && handles[task.event.integration];
  const cwd = taskCwd(ctx, task) ?? ctx.local!.cwd;
  const queued = await ctx.store.get('task', taskId ?? task.id);
  const completion: LocalCompletion = {
    task,
    cwd,
    ...(queued
      ? {
          fence: {
            generation: queued.generation ?? 0,
            attempts: queued.attempts,
            tokenHash: queued.tokenHash,
            statuses: ['running', 'waiting'],
          },
        }
      : {}),
  };
  const flow = task.flow !== 'default' && taskId ? readFlowRecord(taskId) : undefined;
  if (flow) {
    const existing = listTasks(cwd).find(row => row.flowRunId === taskId);
    const now = (ctx.now ?? Date.now)();
    return existing
      ? row(cwd, existing)
      : {
          task,
          status:
            flow.status === 'running'
              ? 'running'
              : flow.status === 'completed'
                ? 'completed'
                : 'failed',
          attempts: 1,
          createdAt: now,
          updatedAt: now,
          local: true,
        };
  }
  if (task.flow === 'default') {
    taskId ??= generateTaskId();
    const key = `completion:${taskId}`;
    const saved = await ctx.store.get<LocalCompletion>('snapshot', key);
    if (saved && sessionKey(saved.task) !== sessionKey(task))
      throw new Error('Local completion belongs to another session');
    if (!saved) await ctx.store.create('snapshot', key, completion);
  }

  const existing = task.flow === 'default' && taskId ? loadTask(cwd, taskId) : undefined;
  if (existing) {
    let worker: ChildProcess | undefined;
    if (existing.status === 'queued' && !existing.pid)
      worker = spawnWorker(cwd, existing.id, {
        ...connectionEnvironment(resolved.mcp, resolved.env).env,
        ...nativeToolEnvironment(task, tokens, reply).env,
      });
    watchCompletion(ctx, existing.id, completion, worker);
    return row(cwd, existing);
  }

  let started!: (id: string) => void;
  const first = new Promise<string>(resolve => (started = resolve));
  let run: Promise<unknown>;
  let worker: ChildProcess | undefined;

  run = execAgent({
    cwd,
    agent: task.agent,
    flow: task.flow,
    task,
    taskId,
    toolEnvironment: { tokens },
    ...(reply ? { replyEndpoint: reply } : {}),
    connections: resolved.mcp,
    connectionEnv: resolved.env,
    availability:
      ctx.local?.engineChecks && ctx.local.engineChecks.expiresAt > Date.now()
        ? ctx.local.engineChecks.availability
        : undefined,
    onModel: machineAttempts(ctx),
    post: false,
    ...(token ? { postToken: token } : {}),
    source: task.source,
    onStart: control => {
      const flows = (ctx.store.localFlows ??= new Map());
      flows.set(task.id, {
        stop: async () => {
          control.requestStop();
          await stopFlowTasks(control.runId, control.runningIds());
        },
        work: run,
      });
      started(task.id);
    },
    onWorker: (_id, child) => {
      worker = child;
    },
    onTask: id => {
      started(id);
    },
  })
    .then(async result => {
      if (task.flow === 'default' && result.taskId) {
        completion.turns = result.turn ?? completion.turns;
        await ctx.store.put('snapshot', `completion:${result.taskId}`, completion);
        watchCompletion(ctx, result.taskId, completion, worker);
      }
      return result;
    })
    .finally(async () => {
      ctx.store.localFlows?.delete(task.id);
      if (task.flow !== 'default') {
        const current = await ctx.store.get('task', task.id);
        if (
          current &&
          current.attempts === completion.fence?.attempts &&
          current.tokenHash === completion.fence?.tokenHash &&
          (current.generation ?? 0) === completion.fence?.generation
        )
          await inspectLocalTask(ctx, current, (ctx.now ?? Date.now)());

        scheduleKick(ctx, true);
      }
    });
  if (task.flow === 'default')
    (ctx.store.localFlows ??= new Map()).set(task.id, {
      stop: async () => {
        const current = loadTask(cwd, taskId ?? task.id);
        if (current) await stopTask(cwd, current);
      },
      work: run,
    });
  run.catch(() => {
    if (ctx.local) ctx.local.engineChecks = undefined;
  });

  const id = await Promise.race([first, run.then(() => undefined)]);
  const startedTask = id ? loadTask(cwd, id) : undefined;
  const now = (ctx.now ?? Date.now)();

  return (
    (startedTask && row(cwd, startedTask)) || {
      task,
      status:
        task.flow !== 'default' && readFlowRecord(task.id)?.status === 'running'
          ? 'running'
          : 'completed',
      attempts: 1,
      createdAt: now,
      updatedAt: now,
      local: true,
    }
  );
}

export async function pushLocalInbox(
  ctx: ServerContext,
  status: TaskStatus,
  entries: InboxEntry[],
): Promise<InboxAck> {
  const id = status.handle!.slice(4);
  const start = await ctx.store.get<LocalStart>('snapshot', `local-start:${status.task.id}`);
  if (!start) throw new Error('Local task launch is missing');

  const ack: InboxAck = { generation: status.generation ?? 0, seq: -1, answers: [] };

  for (const entry of entries) {
    const current = await ctx.store.get('task', status.task.id);
    if (
      !current ||
      current.attempts !== status.attempts ||
      current.tokenHash !== status.tokenHash ||
      (current.generation ?? 0) !== entry.generation ||
      !['running', 'waiting'].includes(current.status)
    )
      break;

    const task = loadTask(start.cwd, id);
    if (!task) throw new Error('Local task is missing');

    const value =
      entry.kind === 'cancel'
        ? await stopTask(start.cwd, task)
        : await applyTaskMessage(start.cwd, { ...task, name: undefined }, entry, granted =>
            turnConnections(ctx, status.task, granted),
          );
    if (entry.kind === 'ask') ack.answers!.push({ seq: entry.seq, value });

    ack.seq = entry.seq;
  }

  return ack;
}

/** A task's `log.jsonl` as runner log lines, each entry's line number its seq. */
export function localLog(cwd: string, id: string, after = -1, limit?: number): TaskLogLine[] {
  let text = '';
  try {
    text = fs.readFileSync(path.join(resolveTaskDir(cwd, id), 'log.jsonl'), 'utf8');
  } catch {}
  const lines = text.split('\n').flatMap((raw, seq): TaskLogLine[] => {
    if (!raw || seq <= after) return [];
    const entry = logEntry(raw);
    if (!entry) return [{ seq, at: 0, level: 'out', line: raw }];
    const level =
      entry.kind === 'error'
        ? 'err'
        : ['status', 'info', 'steer'].includes(entry.kind ?? '')
          ? 'sys'
          : 'out';
    return [{ seq, at: at(entry.at) ?? 0, level, line: entry.message ?? '', entry }];
  });
  return limit === undefined ? lines : lines.slice(0, limit);
}

/** The CLI task behind `id` with its detail, or undefined when the CLI has none. */
export function localTask(cwd: string, id: string, detail = true): TaskStatus | undefined {
  const task = loadTask(cwd, id);
  return task && own(task) ? row(cwd, reconcileTask(cwd, task), detail) : undefined;
}

/** A finished local task runs again on the same id with `text` as its next turn, in place with its engine history; false when it is still active. */
export async function resumeLocalTask(
  ctx: ServerContext,
  cwd: string,
  id: string,
  text: string,
  outputSchema?: object,
  overrides: LocalStart['overrides'] = {},
  context: Partial<TaskContext> = {},
  event?: AgentEvent,
): Promise<boolean> {
  const priorWatch = ctx.store.completionWatches?.get(id);
  if (priorWatch) await priorWatch.work;

  const now = (ctx.now ?? Date.now)();
  let previous = await ctx.store.get('task', id);
  if (previous && ['running', 'waiting'].includes(previous.status)) {
    await inspectLocalTask(ctx, previous, now);
    previous = await ctx.store.get('task', id);
  }

  const next = {
    ...(previous ? await refreshedTask(ctx, previous.task) : {}),
    prompt: text,
    context: { ...previous?.task.context, ...context, ...(outputSchema ? { outputSchema } : {}) },
    ...(event ? { event } : {}),
  };

  await ctx.store.put('snapshot', `local-start:${id}`, {
    cwd,
    resume: true,
    ...(Object.keys(overrides).length ? { overrides } : {}),
  } satisfies LocalStart);
  if (previous) {
    if (
      !(await ctx.queue.continueTask(ctx.organizationId, id, next, now, {
        attempts: previous.attempts,
        generation: previous.generation ?? 0,
      }))
    )
      return false;
  } else {
    const task = loadTask(cwd, id);
    if (!task) throw new Error(`No task "${id}"`);
    await ctx.queue.enqueue(
      ctx.organizationId,
      { ...row(cwd, task).task, ...next },
      now,
      undefined,
      ctx.config.maxQueued ?? 1000,
    );
  }

  await kick(ctx, false, true, true);

  return true;
}

/** `/admin/tasks/<id>` actions on a CLI task. */
export async function localTaskAction(
  req: Request,
  cwd: string,
  id: string,
  action: string | undefined,
  ctx?: ServerContext,
): Promise<Response> {
  const found = loadTask(cwd, id);
  if (!found || !own(found)) return Response.json({ error: `No task "${id}"` }, { status: 404 });

  const task = reconcileTask(cwd, found);
  const active = ACTIVE_STATUSES.includes(task.status);
  const body =
    req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {};
  const refuse = (error: string, status = 409) => Response.json({ error }, { status });
  const unknown = unknownOption(body, ['engine', 'effort']);
  if (unknown) return refuse(unknown, 400);

  if (req.method === 'DELETE' && !action) {
    if (active) await stopTask(cwd, task);
    deleteTask(cwd, task);
    if (ctx) {
      const watch = ctx.store.completionWatches?.get(id);
      if (watch) {
        watch.stopped = true;
        await watch.work;
      }
      await ctx.store.delete('task', id);
      await ctx.store.delete('snapshot', `local-start:${id}`);
      await ctx.store.delete('snapshot', `completion:${id}`);
      scheduleKick(ctx, true);
    }
    return Response.json({ ok: true });
  }
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  if (action === 'cancel') {
    if (!active) return refuse(`No running or queued task "${id}"`, 404);
    await stopTask(cwd, task);
    return Response.json({ ok: true });
  }
  if (action === 'archive') {
    archiveTask(cwd, task);
    if (ctx)
      await ctx.queue.patchTask(
        ctx.organizationId,
        id,
        { archivedAt: (ctx.now ?? Date.now)(), autoArchived: undefined },
        (ctx.now ?? Date.now)(),
      );
    return Response.json({ ok: true });
  }
  if (action === 'steer') {
    const text = String(body.text ?? '');
    if (!text.trim()) return refuse('text is required', 400);
    // A live task takes the follow-up now; a finished one resumes on the same id with these.
    const outputSchema = active ? undefined : body.outputSchema;
    const overrides = Object.fromEntries(
      (['model', 'access'] as const).flatMap(key =>
        typeof body[key] === 'string' && body[key] ? [[key, body[key] as string]] : [],
      ),
    );
    if (
      outputSchema !== undefined &&
      (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema))
    )
      return refuse('outputSchema must be an object', 400);
    try {
      if (!active && ctx) {
        if (!(await resumeLocalTask(ctx, cwd, id, text, outputSchema as object, overrides)))
          return refuse('Task is already active');

        const saved = await ctx.store.get('task', id);

        return Response.json(
          saved?.status === 'queued'
            ? { ...saved, statusReason: 'Waiting for a task slot' }
            : localTask(cwd, id),
        );
      }
      const result = await steerTask(cwd, task, text, {
        ...(typeof outputSchema === 'object' && outputSchema ? { outputSchema } : {}),
        ...overrides,
      });
      return Response.json(active ? result : localTask(cwd, id));
    } catch (error) {
      return refuse((error as Error).message);
    }
  }
  if (action === 'ask') {
    const question = String(body.question ?? body.text ?? '');
    if (!question.trim()) return refuse('question is required', 400);
    const result = await askTask(cwd, task, question, {
      ...(typeof body.model === 'string' && body.model ? { model: body.model } : {}),
    });
    const answer = result.finalMessage ?? result.error?.message ?? '';
    const file = path.join(resolveTaskDir(cwd, id), 'answers.json');
    writeJsonFileAtomic(file, [...(readJsonFile<unknown[]>(file) ?? []), answer]);
    return Response.json({ ok: true, answer });
  }
  if (action === 'approve') return answerLocalApproval(cwd, id, body, ctx);

  return new Response('Not found', { status: 404 });
}

/** Answers a CLI task's approval; on a server, a finished task resumes through it, so its conversation hears the next turn. */
export async function answerLocalApproval(
  cwd: string,
  id: string,
  body: Record<string, unknown>,
  ctx?: ServerContext,
): Promise<Response> {
  const found = loadTask(cwd, id);
  if (!found || !own(found)) return Response.json({ error: `No task "${id}"` }, { status: 404 });
  const task = reconcileTask(cwd, found);
  const approvals = listApprovals(resolveTaskDir(cwd, id));
  const answerable = approvals.filter(
    entry => entry.response?.decision !== 'accept' && entry.response?.decision !== 'closed',
  );
  const approvalId = String(
    body.approvalId ?? body.id ?? pendingApprovals(resolveTaskDir(cwd, id))[0]?.id ?? '',
  );
  if (approvals.some(entry => entry.id === approvalId && entry.response?.decision === 'closed'))
    return Response.json({ error: stoppedMessage(approvalId) }, { status: 409 });
  if (!answerable.some(entry => entry.id === approvalId))
    return Response.json(
      { error: `Task "${id}" has no approval "${approvalId}" to answer` },
      { status: 409 },
    );
  try {
    await answerTaskApproval(
      cwd,
      task,
      approvalId,
      body.decision === 'deny' || body.decision === 'decline' ? 'decline' : 'accept',
      {
        ...(typeof body.reason === 'string' ? { reason: body.reason } : {}),
        ...(typeof body.by === 'string' && body.by ? { by: body.by } : {}),
        ...(ctx ? { resume: (text: string) => resumeLocalTask(ctx, cwd, id, text) } : {}),
      },
    );
  } catch (error) {
    if (error instanceof CoderError)
      return Response.json({ error: error.message }, { status: 400 });
    throw error;
  }

  return Response.json({ ok: true });
}

/** Finished CLI turns as usage rows, skipping completion keys already known. */
export function localUsage(
  cwd: string,
  known = new Set<string>(),
  archived = true,
): Array<[string, UsageRecord]> {
  const completions = usageCompletions(known);

  return [...listTasks(cwd), ...(archived ? listArchivedTasks(cwd, { migrate: false }) : [])]
    .filter(own)
    .flatMap(task => taskUsage(task, completions));
}

function usageCompletions(keys: Iterable<string>): Map<string, number[]> {
  const completions = new Map<string, number[]>();
  for (const key of keys) {
    const end = key.lastIndexOf(':');
    const id = key.slice(4, end);
    const times = completions.get(id) ?? [];
    times.push(Number(key.slice(end + 1)));
    completions.set(id, times);
  }

  return completions;
}

function taskUsage(task: Task, known: Map<string, number[]>): Array<[string, UsageRecord]> {
  const results = task.turnUsage ?? [];
  const completions = known.get(task.id) ?? [];
  known.set(task.id, completions);
  let previous = at(task.createdAt) ?? 0;

  return results.flatMap((result): Array<[string, UsageRecord]> => {
    const finishedAt = at(result.at);
    if (finishedAt === undefined || !Number.isFinite(finishedAt)) return [];
    const resumedAt = at(task.resumedAt);
    const startedAt =
      resumedAt !== undefined && resumedAt >= previous && resumedAt <= finishedAt
        ? resumedAt
        : previous;
    const knownTurn = completions.includes(finishedAt);
    previous = finishedAt;
    if (knownTurn) return [];
    completions.push(finishedAt);

    return [
      [
        `cli:${task.id}:${finishedAt}`,
        {
          taskId: task.id,
          agent: task.agentId ?? defaultAgent() ?? '',
          target: task.source ?? 'cli',
          ...(task.engine ? { engine: task.engine } : {}),
          ...((result.model ?? task.model) ? { model: (result.model ?? task.model)! } : {}),
          credential: 'local',
          runnerElapsedMs: Math.max(0, finishedAt - startedAt),
          ...(result.tokens ? { tokens: result.tokens } : {}),
          at: finishedAt,
        },
      ],
    ];
  });
}

/** The usage page counts CLI tasks beside server tasks; unchanged archives need only file stats. */
export function syncLocalUsage(ctx: ServerContext): Promise<void> {
  const local = ctx.local!;

  return (local.usageSync ??= scanLocalUsage(ctx).finally(() => (local.usageSync = undefined)));
}

type SavedUsage = {
  archive: number;
  counted?: Record<string, string>;
  rows: Record<string, UsageRecord>;
};

async function readUsageJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.promises.readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

async function archiveStamp(dir: string): Promise<string> {
  const stamps = await Promise.all(
    ['job.json', 'results.jsonl', 'result.json'].map(async name => {
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => undefined);

      return stat ? `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}` : '';
    }),
  );

  return stamps.join('|');
}

async function scanLocalUsage(ctx: ServerContext): Promise<void> {
  const local = ctx.local!;
  await local.cacheMaintenance;
  const file = resolveUsageFile();
  const saved = await readUsageJson<SavedUsage>(file);
  const stored = await ctx.store.list('usage', { prefix: 'cli:' });
  const known = new Set(stored.map(entry => entry.id));
  let batch = 0;
  const yieldBatch = async () => {
    if (++batch % 4 === 0) await new Promise<void>(resolve => setImmediate(resolve));
  };
  if (local.archiveScan === undefined) {
    for (const [key, row] of Object.entries(saved?.rows ?? {})) {
      if (!known.has(key)) {
        await ctx.store.put('usage', key, row);
        known.add(key);
      }
      await yieldBatch();
    }
  }

  const completions = usageCompletions(known);
  const archive =
    (await fs.promises.stat(resolveArchiveDir(local.cwd)).catch(() => undefined))?.mtimeMs ?? 0;
  const counted: Record<string, string> = {};
  const seen = new Set<string>();
  let changed = false;
  for await (const { id, dir, archived } of taskDirectories(local.cwd)) {
    await yieldBatch();
    if (seen.has(id)) continue;
    const stamp = archived ? await archiveStamp(dir) : undefined;
    if (archived && saved?.counted?.[id] === stamp) {
      counted[id] = stamp!;
      seen.add(id);
      continue;
    }
    const task = await readUsageJson<Task & { agent?: Task['engine'] }>(path.join(dir, 'job.json'));
    if (!task) continue;
    if (task.agent) task.engine = task.agent;
    seen.add(id);
    if (own(task)) {
      for (const [key, row] of taskUsage(task, completions)) {
        await ctx.store.put('usage', key, row);
        changed = true;
        await yieldBatch();
      }
    }
    if (archived) counted[id] = stamp!;
  }

  if (
    changed ||
    saved?.archive !== archive ||
    JSON.stringify(saved?.counted) !== JSON.stringify(counted)
  ) {
    const rows = await ctx.store.list('usage', { prefix: 'cli:' });
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    const temp = resolveUsageTempFile(file);
    try {
      await fs.promises.writeFile(
        temp,
        `${JSON.stringify({ archive, counted, rows: Object.fromEntries(rows.map(entry => [entry.id, entry.value])) })}\n`,
      );
      await fs.promises.rename(temp, file);
    } finally {
      await fs.promises.rm(temp, { force: true });
    }
  }

  local.archiveScan = archive;
}

export const LOCAL_LOGINS =
  "A local server stores no engine credentials. Tasks use this machine's own claude and codex sign-in.";

export type EngineStatus = Record<'claude' | 'codex', { signedIn: boolean; command: string }>;

const CHECKS = {
  claude: {
    file: 'claude',
    args: ['auth', 'status', '--json'],
    command: 'claude auth login',
    login: ['auth', 'login'],
    logout: ['auth', 'logout'],
    ok: (stdout: string) => (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true,
  },
  codex: {
    file: 'codex',
    args: ['login', 'status'],
    command: 'codex login',
    login: ['login'],
    logout: ['logout'],
    ok: () => true,
  },
};

export const isLoginEngine = (engine: string): engine is keyof typeof CHECKS => engine in CHECKS;

/** Starts the engine's own sign-in on this machine; it opens the browser itself, and the status shows when it is done. */
export function engineSignIn(engine: keyof typeof CHECKS): void {
  const check = CHECKS[engine];
  spawn(check.file, check.login, { detached: true, stdio: 'ignore' })
    .on('error', () => {})
    .unref();
}

/** Signs this machine out of the engine. */
export function engineSignOut(engine: keyof typeof CHECKS): Promise<void> {
  const check = CHECKS[engine];
  return new Promise(resolve =>
    execFile(check.file, check.logout, { timeout: 15_000 }, () => resolve()),
  );
}

function signedIn(check: (typeof CHECKS)[keyof typeof CHECKS]): Promise<boolean> {
  return new Promise(resolve =>
    execFile(check.file, check.args, { timeout: 15_000 }, (error, stdout) => {
      try {
        resolve(!error && check.ok(stdout));
      } catch {
        resolve(false);
      }
    }),
  );
}

export async function engineStatus(ctx?: ServerContext): Promise<EngineStatus> {
  const local = ctx?.local;
  if (local?.engineChecks && local.engineChecks.expiresAt > Date.now())
    return local.engineChecks.work;
  const availability: Partial<Record<'claude' | 'codex', Availability>> = {};
  const work = Promise.all([signedIn(CHECKS.claude), signedIn(CHECKS.codex)])
    .then(([claude, codex]) => {
      if (local) {
        availability.claude = getClaudeAvailability('claude', process.env, local.cwd);
        availability.codex = getCodexAvailability(local.cwd);
      }
      return {
        claude: { signedIn: claude, command: CHECKS.claude.command },
        codex: { signedIn: codex, command: CHECKS.codex.command },
      };
    })
    .catch(error => {
      if (local?.engineChecks?.work === work) local.engineChecks = undefined;
      throw error;
    });
  if (local) local.engineChecks = { expiresAt: Date.now() + 30_000, availability, work };

  return work;
}

/** A local server runs each model of a turn's attempts once, on this machine's own logins. */
function machineAttempts(ctx: ServerContext) {
  let last: string | undefined;

  return async (attempt: { model: string }) => {
    if (attempt.model === last) return false;
    last = attempt.model;

    return machineSignedIn(ctx, splitEngineSpec(attempt.model) as { engine: string });
  };
}

/** Whether this machine's own logins run a model. */
export async function machineSignedIn(
  ctx: ServerContext,
  option: { engine: string; model?: string | null },
): Promise<boolean> {
  if (!ctx.local) return false;
  if (option.engine !== 'custom')
    return (await engineStatus(ctx))[option.engine as 'claude' | 'codex']?.signedIn === true;
  const entry = option.model ? loadConfig(ctx.local.cwd).models?.[option.model] : undefined;

  return Boolean(entry && isEndpointModel(entry) && process.env[entry.envKey ?? 'OPENAI_API_KEY']);
}
