/** A local server's tasks are the CLI's own: `coder task run` tasks show here, and dashboard tasks run through the same broker. */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

import { AGENT_TASK_PREFIX, execAgent, agentTaskOptions } from '../../agent/exec';
import type { AgentTask, TaskSource } from '../../agent/types';
import type { TaskTurn } from '../../client/types';
import type { TaskLogLine, TaskStatus, UsageRecord } from '../store/types';
import { deleteTask, stopTask, askTask, steerTask, recentTasks } from '../../core/task/actions';
import { answerApproval, listPendingApprovals } from '../../core/approvals';
import { loadConfig } from '../../core/config';
import { logEntry } from '../../core/task/log-view';
import { CoderError, dispatchTask, readResultJson, spawnWorker } from '../../core/dispatch';
import {
  archiveDue,
  archiveTask,
  generateTaskId,
  queueRowWins,
  listArchivedTasks,
  listTasks,
  loadTask,
  reconcileTask,
  resolveArchiveDir,
  resolveUsageFile,
  resolveUsageTempFile,
  taskDirectories,
  type TurnResultEntry,
  resolveTaskDir,
  readTurnResults,
  writeTask,
} from '../../core/state';
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type Task } from '../../core/types';
import { readFlowRecord } from '../../flow/runs';
import { stopRun, stopFlowTasks } from '../../flow/executor';
import { applyTaskMessage } from '../../runner/task';
import { readJsonFile, writeJsonFileAtomic } from '../../utils/fsx';
import type { ServerContext } from '../context';
import { eventTokens } from './context';
import { check, TaskInputError, taskCwd, type NewTask } from './create';
import { noteKey } from './thread';
import { sessionKey, pushInbox, type TaskFence, type InboxEntry, type InboxAck } from './queue';
import { kick, scheduleKick } from './kick';
import { chooseRunner } from '../runners';
import { syncLocalAgents } from '../store/local';
import { agentWithVersion } from '../agents/records';

const own = (task: Task) => !task.name?.startsWith(AGENT_TASK_PREFIX);
const at = (value?: string | null) => (value ? Date.parse(value) : undefined);

function row(cwd: string, task: Task, detail = false): TaskStatus {
  const createdAt = at(task.createdAt) ?? 0;
  const answers = readJsonFile<unknown[]>(path.join(resolveTaskDir(cwd, task.id), 'answers.json'));
  const approval =
    task.status === 'running'
      ? listPendingApprovals(resolveTaskDir(cwd, task.id)).find(entry => !entry.response)
      : undefined;
  const result =
    detail && !ACTIVE_STATUSES.includes(task.status) ? readResultJson(cwd, task.id) : null;
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
  return {
    task: {
      id: task.id,
      source: (task.source ?? 'cli') as TaskSource,
      agent: task.agentId ?? 'coder',
      flow: flow ?? 'default',
      ...(task.name
        ? { name: task.name }
        : flow
          ? { name: flow === 'review' ? 'Review' : flow }
          : {}),
      runner: 'local',
      ...(task.cwd ? { cwd: task.cwd } : {}),
      ...(task.permissions ? { permissions: task.permissions } : {}),
      ...(task.prompt ? { prompt: task.currentPrompt ?? task.prompt } : {}),
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
    status: approval ? 'waiting' : task.status,
    attempts: 1,
    ...(approval ? { approval } : {}),
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
    ...(detail ? { turns } : {}),
  };
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
  const { version } = await agentWithVersion(ctx.store, input.agent ?? 'coder');
  const route = await chooseRunner(ctx, {
    requester: ctx.session?.user.id,
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
      agent: input.agent ?? 'coder',
      flow: 'default',
      runner: 'local',
      cwd,
      prompt: input.prompt,
      definition: { integrations: {} },
      tools: {},
    };
    return enqueueLocalTask(ctx, task, { input, cwd });
  }
  try {
    const agent =
      input.agent && input.agent !== 'coder'
        ? await agentTaskOptions(cwd, input.agent, input.mcp?.join(','))
        : undefined;
    const fallbacks: NonNullable<Task['fallbacks']> = [];
    const dispatched = await dispatchTask(
      {
        taskId,
        prompt: input.prompt ?? '',
        outputSchema: input.outputSchema,
        cwd,
        engine: input.engine ?? agent?.engine,
        model: input.model ?? (input.engine ? undefined : agent?.model),
        effort: input.effort ?? (input.engine ? undefined : agent?.effort),
        permissions: input.permissions ?? agent?.permissions,
        system: agent?.system,
        mcp: agent ? agent.mcp : input.mcp?.join(','),
        nativeMcp: agent?.nativeMcp,
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
}

export interface LocalStart {
  cwd: string;
  input?: NewTask;
  resume?: boolean;
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
    const existing =
      status.task.flow === 'default' ? loadTask(start.cwd, status.task.id) : undefined;
    if (existing && !start.resume) startedId = existing.id;
    else if (start.resume) {
      const task = loadTask(start.cwd, status.task.id);
      if (!task) throw new Error('Local task is missing');
      await steerTask(start.cwd, task, status.task.prompt ?? '', {
        outputSchema: status.task.context?.outputSchema,
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
    else startedId = (await runLocalTask(ctx, status.task, status.task.id, true)).task.id;
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
      const completion: LocalCompletion = { task: status.task, cwd: start.cwd, fence };
      await ctx.store.put('snapshot', `completion:${startedId}`, completion);
      watchCompletion(ctx, startedId, completion);
      const inbox = pushInbox(ctx, status.task.id);
      if (ctx.waitUntil) ctx.waitUntil(inbox);
      else void inbox;
    }
  } catch (error) {
    await ctx.queue.finish(
      ctx.organizationId,
      status.task.id,
      { status: 'failed', error: error instanceof Error ? error.message : String(error) },
      (ctx.now ?? Date.now)(),
      { attempts: status.attempts, tokenHash: status.tokenHash },
    );
  }
  return true;
}

export async function inspectLocalTask(
  ctx: ServerContext,
  status: TaskStatus,
  now: number,
): Promise<boolean> {
  if (status.status !== 'running' && status.status !== 'waiting') return false;
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
  return ctx.queue.finish(
    ctx.organizationId,
    status.task.id,
    { status: state, result: current.result, error: current.error },
    now,
    fence,
  );
}

function watchCompletion(ctx: ServerContext, id: string, saved: LocalCompletion): void {
  const watches = (ctx.store.completionWatches ??= new Map());
  if (watches.has(id)) return;
  const watch = { stopped: false, work: Promise.resolve() };
  watches.set(id, watch);
  watch.work = (async () => {
    const key = `completion:${id}:${saved.fence?.generation ?? 0}`;
    const previous = await ctx.store.get<{ owner?: string; pid?: number; posted?: boolean }>(
      'delivery',
      key,
    );
    if (previous && !previous.owner) return;
    if (previous?.pid) {
      try {
        process.kill(previous.pid, 0);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return;
      }
    }

    const owner = randomUUID();
    let receipt: { owner: string; pid?: number; pending: boolean; posted: boolean } = {
      owner,
      pid: process.pid,
      pending: true,
      posted: previous?.posted ?? false,
    };
    if (previous?.owner) {
      if (!(await ctx.store.updateDelivery(key, previous.owner, receipt))) return;
    } else if (!(await ctx.store.create('delivery', key, receipt))) return;

    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          let result: ReturnType<typeof readResultJson> = null;

          for (;;) {
            if (watch.stopped) return;
            if (saved.fence) {
              const current = await ctx.store.get('task', saved.task.id);
              if (
                !current ||
                (current.generation ?? 0) !== saved.fence.generation ||
                current.attempts !== saved.fence.attempts ||
                current.tokenHash !== saved.fence.tokenHash ||
                current.status === 'queued'
              )
                return;
            }
            const found = loadTask(saved.cwd, id);
            if (!found) return;
            const task = reconcileTask(saved.cwd, found);
            if (!ACTIVE_STATUSES.includes(task.status)) {
              const file = path.join(resolveTaskDir(saved.cwd, id), 'result.json');
              const finished = Math.max(
                at(task.completedAt) ?? 0,
                at(task.resumedAt) ?? at(task.createdAt) ?? 0,
              );
              if (fs.existsSync(file) && fs.statSync(file).mtimeMs >= finished)
                result = readResultJson(saved.cwd, id);
              if (result) break;
              if (task.error || task.status === 'cancelled') {
                result = {
                  status: 1,
                  threadId: task.threadId ?? null,
                  error: { message: task.error ?? 'Task cancelled' },
                };
                break;
              }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }

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

          if (!(await ctx.store.updateDelivery(key, owner, receipt))) return;
          if (!receipt.posted && saved.task.source === saved.task.event?.integration) {
            const app = await ctx.store.get('app', saved.task.event.appId);
            if (!app) throw new Error('Local completion has no app');

            const { eventReplies } = await import('../chat');
            const replies = await eventReplies(ctx, app, saved.task.event);
            if (!(await ctx.store.updateDelivery(key, owner, receipt))) return;

            await replies.post((result.finalMessage ?? result.error?.message ?? '').trim());
            receipt = { ...receipt, posted: true };
            if (!(await ctx.store.updateDelivery(key, owner, receipt))) return;
          }

          const noteFile = path.join(resolveTaskDir(saved.cwd, id), 'agent-note');
          const note = fs.existsSync(noteFile)
            ? fs.readFileSync(noteFile, 'utf8').trim()
            : (saved.task.context?.note ?? '').trim();
          if (!(await ctx.store.updateDelivery(key, owner, receipt))) return;
          if (note !== (saved.task.context?.note ?? '').trim()) {
            if (note) await ctx.store.put('note', noteKey(saved.task), note);
            else await ctx.store.delete('note', noteKey(saved.task));
          }

          if (
            await ctx.store.updateDelivery(key, owner, { posted: receipt.posted, at: Date.now() })
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
          const retryAt = Date.now() + 5000 * 2 ** attempt;
          while (!watch.stopped && Date.now() < retryAt)
            await new Promise(resolve => setTimeout(resolve, Math.min(100, retryAt - Date.now())));
        }
      }
    } finally {
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

/** Run a server task as CLI tasks on this machine, as a runner would, and answer once the first one exists. */
export async function runLocalTask(
  ctx: ServerContext,
  task: AgentTask,
  taskId?: string,
  admitted = false,
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

  const tokens = task.event ? await eventTokens(ctx, task) : {};
  const token = task.event && tokens[task.event.integration];
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
    const noteFile = path.join(resolveTaskDir(cwd, taskId), 'agent-note');
    if (!fs.existsSync(noteFile)) {
      fs.mkdirSync(path.dirname(noteFile), { recursive: true });
      fs.writeFileSync(noteFile, task.context?.note ?? '', { mode: 0o600 });
    }
  }

  const existing = task.flow === 'default' && taskId ? loadTask(cwd, taskId) : undefined;
  if (existing) {
    if (existing.status === 'queued' && !existing.pid) spawnWorker(cwd, existing.id);
    watchCompletion(ctx, existing.id, completion);
    return row(cwd, existing);
  }

  let started!: (id: string) => void;
  const first = new Promise<string>(resolve => (started = resolve));
  let run: Promise<void>;

  run = execAgent({
    cwd,
    agent: task.agent,
    flow: task.flow,
    task,
    taskId,
    toolEnvironment: { tokens },
    post: task.flow === 'default' ? false : task.source === task.event?.integration,
    ...(task.flow === 'default'
      ? { noteFile: path.join(resolveTaskDir(cwd, taskId!), 'agent-note') }
      : {}),
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
    onTask: id => {
      if (task.flow === 'default') watchCompletion(ctx, id, completion);
      started(id);
    },
  })
    .then(async result => {
      if (task.flow === 'default' || result.note === undefined) return;
      if (result.note) await ctx.store.put('note', noteKey(task), result.note);
      else await ctx.store.delete('note', noteKey(task));
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
  run.catch(() => {});

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
        : await applyTaskMessage(start.cwd, { ...task, name: undefined }, entry);
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

/** `/admin/tasks/<id>` actions on a CLI task, answered as the queue's would be. */
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
  if (action === 'steer' || action === 'continue') {
    const text = String(body.text ?? '');
    if (!text.trim()) return refuse('text is required', 400);
    if (action === 'steer' && !active) return refuse(`Task "${id}" is not active`);
    if (action === 'continue' && active)
      return refuse(`Task "${id}" is still active; steer or ask it instead`);
    const outputSchema = action === 'continue' ? body.outputSchema : undefined;
    if (
      outputSchema !== undefined &&
      (!outputSchema || typeof outputSchema !== 'object' || Array.isArray(outputSchema))
    )
      return refuse('outputSchema must be an object', 400);
    try {
      if (action === 'continue' && ctx) {
        const priorWatch = ctx.store.completionWatches?.get(id);
        if (priorWatch) await priorWatch.work;

        const now = (ctx.now ?? Date.now)();
        let previous = await ctx.store.get('task', id);
        if (previous && ['running', 'waiting'].includes(previous.status)) {
          await inspectLocalTask(ctx, previous, now);
          previous = await ctx.store.get('task', id);
        }

        const next = {
          prompt: text,
          context: { ...previous?.task.context, ...(outputSchema ? { outputSchema } : {}) },
        };

        await ctx.store.put('snapshot', `local-start:${id}`, {
          cwd,
          resume: true,
        } satisfies LocalStart);
        if (previous) {
          if (
            !(await ctx.queue.continueTask(ctx.organizationId, id, next, now, {
              attempts: previous.attempts,
              generation: previous.generation ?? 0,
            }))
          )
            return refuse('Task is already active');
        } else
          await ctx.queue.enqueue(
            ctx.organizationId,
            { ...row(cwd, task).task, ...next },
            now,
            undefined,
            ctx.config.maxQueued ?? 1000,
          );

        await kick(ctx, false, true, true);

        const saved = await ctx.store.get('task', id);

        return Response.json(
          saved?.status === 'queued'
            ? { ...saved, statusReason: 'Waiting for a task slot' }
            : localTask(cwd, id),
        );
      }
      const result = await steerTask(cwd, task, text, {
        ...(typeof outputSchema === 'object' && outputSchema ? { outputSchema } : {}),
      });
      return Response.json(action === 'continue' ? localTask(cwd, id) : result);
    } catch (error) {
      return refuse((error as Error).message);
    }
  }
  if (action === 'ask') {
    const question = String(body.question ?? body.text ?? '');
    if (!question.trim()) return refuse('question is required', 400);
    const result = await askTask(cwd, task, question);
    const answer = result.finalMessage ?? result.error?.message ?? '';
    const file = path.join(resolveTaskDir(cwd, id), 'answers.json');
    writeJsonFileAtomic(file, [...(readJsonFile<unknown[]>(file) ?? []), answer]);
    return Response.json({ ok: true, answer });
  }
  if (action === 'approve') {
    const pending = listPendingApprovals(resolveTaskDir(cwd, id)).filter(entry => !entry.response);
    const approvalId = String(body.approvalId ?? body.id ?? pending[0]?.id ?? '');
    if (!pending.some(entry => entry.id === approvalId))
      return refuse(`Task "${id}" has no pending approval`);
    answerApproval(
      resolveTaskDir(cwd, id),
      approvalId,
      body.decision === 'deny' || body.decision === 'decline' ? 'decline' : 'accept',
    );
    return Response.json({ ok: true });
  }

  return new Response('Not found', { status: 404 });
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
    .flatMap(task => {
      const turns = readTurnResults(cwd, task.id);
      const result =
        !turns.length && !ACTIVE_STATUSES.includes(task.status)
          ? readResultJson(cwd, task.id)
          : null;

      return taskUsage(task, turns, result, completions);
    });
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

function taskUsage(
  task: Task,
  turns: TurnResultEntry[],
  result: Pick<TurnResultEntry, 'tokens' | 'model'> | null,
  known: Map<string, number[]>,
): Array<[string, UsageRecord]> {
  const results = turns.length
    ? turns
    : result
      ? [{ ...result, at: task.completedAt ?? task.updatedAt ?? task.createdAt }]
      : [];
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
    const knownTurn = completions.some(
      time => time === finishedAt || (time > previous && time <= finishedAt),
    );
    previous = finishedAt;
    if (knownTurn) return [];
    completions.push(finishedAt);

    return [
      [
        `cli:${task.id}:${finishedAt}`,
        {
          taskId: task.id,
          agent: task.agentId ?? 'coder',
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
      const history = await fs.promises
        .readFile(path.join(dir, 'results.jsonl'), 'utf8')
        .catch(() => '');
      const turns = history.split(/\r?\n/).flatMap((line): TurnResultEntry[] => {
        try {
          return line ? [JSON.parse(line) as TurnResultEntry] : [];
        } catch {
          return [];
        }
      });
      const result =
        !turns.length && !ACTIVE_STATUSES.includes(task.status)
          ? await readUsageJson<TurnResultEntry>(path.join(dir, 'result.json'))
          : null;
      for (const [key, row] of taskUsage(task, turns, result, completions)) {
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
  "A local server stores no credentials. Tasks use this machine's own claude and codex sign-in.";

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

export async function engineStatus(): Promise<EngineStatus> {
  const [claude, codex] = await Promise.all([signedIn(CHECKS.claude), signedIn(CHECKS.codex)]);
  return {
    claude: { signedIn: claude, command: CHECKS.claude.command },
    codex: { signedIn: codex, command: CHECKS.codex.command },
  };
}

/** A local server runs tasks with this machine's own logins. */
export async function machineSignedIn(ctx: ServerContext, engine: string): Promise<boolean> {
  return (
    !!ctx.local &&
    (engine === 'custom' || (await engineStatus())[engine as 'claude' | 'codex']?.signedIn === true)
  );
}
