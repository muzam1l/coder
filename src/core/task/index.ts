/** The task API the CLI and the SDK share: each call works on this machine's tasks, or on a Coder server with `server`. */
import path from 'node:path';
import process from 'node:process';

import { connect, type RemoteClient, type ServerOptions } from '../remote';
import type { TaskLogLine, TaskStatus } from '../../server/store/types';
import { readJsonFile } from '../../utils/fsx';
import { answerApproval, listPendingApprovals } from '../approvals';
import { loadConfig } from '../config';
import {
  buildFallbackPayload,
  CoderError,
  dispatchTask,
  isSandboxFailure,
  isStartupError,
  readTask,
  waitTask,
  withResumeDefaults,
  type DispatchOptions,
} from '../dispatch';
import {
  ageMs,
  archiveTask,
  STALL_MS,
  findTask,
  lastActivityAt,
  listArchivedTasks,
  listTasks,
  loadTask,
  readTaskLog,
  readTurnResults,
  reconcileTask,
  resolveTaskDir,
  waitForTerminalTask,
  type TaskLogEntry,
} from '../state';
import { ACTIVE_STATUSES, TERMINAL_STATUSES, type Task, type TokenUsage } from '../types';
import { waitForTaskAttention } from '../dispatch';
import {
  deleteTask,
  stopTask,
  collectTasks,
  streamTask,
  type ListOptions,
  askTask,
  collectPending,
  steerTask,
} from './actions';

/** Where a task call runs: this machine's tasks under `cwd`, or the server named by `server`. */
export type TaskOptions = { cwd?: string } & ServerOptions;

function target(opts: TaskOptions): { cwd: string; api?: RemoteClient } {
  return {
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    ...(opts.server !== undefined ? { api: connect(opts) } : {}),
  };
}

/** A local task by id or name, else the most recent one. */
function localTask(cwd: string, reference?: string): Task {
  const task = findTask(cwd, reference);
  if (task) return task;
  throw new CoderError(
    'invalid-option',
    reference ? `No task found for "${reference}".` : 'No tasks found for this workspace.',
    {
      hint: reference
        ? ['List tasks: coder task list', 'Start one: coder run "<text>"']
        : ['Start one: coder run "<text>"'],
    },
  );
}

/** A server task by id, else the most recent one. */
async function serverTask(api: RemoteClient, reference?: string): Promise<TaskStatus> {
  if (reference) return api.tasks.get(reference);
  const [latest] = await api.tasks.list({ limit: 1 });
  if (!latest) throw new CoderError('server', 'No server tasks found.');
  return latest;
}

function missingId(hint: string[]): never {
  throw new CoderError('invalid-option', 'Missing task id.', { hint });
}

export interface TaskRunOptions {
  /** Run as a local agent; the other options override its definition. */
  agent?: string;
  outputSchema?: object;
  engine?: string;
  model?: string;
  effort?: string;
  permissions?: string;
  name?: string;
  system?: string;
  resume?: string;
  /** Extra directories the task may reach, resolved against cwd. */
  addDirs?: string[];
  /** MCP servers to attach, by name from config. */
  mcp?: string;
  /** Block until the task finishes, walking the engine chain when a turn fails to start. */
  wait?: boolean;
  simulateApproval?: boolean;
  /** Server tasks: the repository and runner to use. */
  repo?: string;
  runner?: string;
  onFallback?: (fallback: { engine: string; detail: string; next: string }) => void;
  onNote?: (note: string) => void;
  /** Each time a wait starts on a task id. */
  onWaiting?: (taskId: string) => void;
  /** Server task log lines while waiting. */
  onLog?: (line: TaskLogLine) => void;
}

export interface RunResult {
  taskId: string;
  status: string;
  startupCheck?: 'passed' | 'pending';
  commands?: Record<'result' | 'steer' | 'stop' | 'list', string>;
  finalMessage?: string | null;
  error?: string;
  tokens?: TokenUsage | null;
  model?: string | null;
}

/** Dispatch a task; with `wait`, block until it finishes. */
async function run(
  prompt: string,
  opts: TaskRunOptions & TaskOptions = {},
): Promise<RunResult | TaskStatus> {
  if (
    opts.outputSchema !== undefined &&
    (!opts.outputSchema ||
      typeof opts.outputSchema !== 'object' ||
      Array.isArray(opts.outputSchema))
  )
    throw new CoderError('invalid-option', 'outputSchema must be an object.');
  const { cwd, api } = target(opts);
  if (api) {
    const created = opts.resume
      ? await api.tasks.continue(opts.resume, prompt, { outputSchema: opts.outputSchema })
      : await api.tasks.create({
          source: 'cli',
          prompt,
          ...(opts.cwd ? { cwd: opts.cwd } : {}),
          ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
          ...(opts.repo ? { repo: opts.repo } : {}),
          ...(opts.agent ? { agent: opts.agent } : {}),
          ...(opts.engine ? { engine: opts.engine } : {}),
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.effort ? { effort: opts.effort } : {}),
          ...(opts.permissions ? { permissions: opts.permissions } : {}),
          ...(opts.runner ? { runner: opts.runner } : {}),
          ...(opts.mcp ? { mcp: opts.mcp.split(',').map(name => name.trim()) } : {}),
        });
    return opts.wait ? api.tasks.wait(created.task.id, { onLog: opts.onLog }) : created;
  }

  // A local agent's options come from its definition, loaded only when asked for.
  const agent = opts.agent
    ? await (await import('../../agent/exec')).agentTaskOptions(cwd, opts.agent, opts.mcp)
    : undefined;
  const inherited = withResumeDefaults({
    prompt,
    outputSchema: opts.outputSchema,
    cwd,
    cwdExplicit: Boolean(opts.cwd),
    engine: opts.engine ?? agent?.engine,
    model: opts.model ?? (opts.engine ? undefined : agent?.model),
    effort: opts.effort ?? (opts.engine ? undefined : agent?.effort),
    permissions: opts.permissions ?? agent?.permissions,
    name: opts.name,
    system: opts.system ?? agent?.system,
    resume: opts.resume,
    wait: opts.wait,
    simulateApproval: opts.simulateApproval,
    addDirs: opts.addDirs,
  });
  const dispatchOpts: DispatchOptions = {
    ...inherited,
    ...(opts.agent ? { agentId: opts.agent } : {}),
    mcp: agent?.mcp ?? opts.mcp,
    nativeMcp: agent?.nativeMcp,
    ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
    ...(opts.onNote ? { onNote: opts.onNote } : {}),
  };
  let dispatch = await dispatchTask(dispatchOpts);

  if (!opts.wait) {
    const taskId = dispatch.taskId;
    return {
      taskId,
      status: dispatch.task.status,
      startupCheck: dispatch.startupCheck,
      commands: {
        result: `coder task result ${taskId} --wait`,
        steer: `coder task steer ${taskId} "<follow-up>"`,
        stop: `coder task stop ${taskId}`,
        list: 'coder task list',
      },
    };
  }

  // A turn that ends with a startup-ish error (usage, auth, quota) walks the chain like a failed start.
  for (;;) {
    const taskId = dispatch.taskId;
    opts.onWaiting?.(taskId);
    const { task: final, result } = await waitTask(cwd, taskId);
    const turnError = result?.error?.message ?? '';
    if (final.status === 'failed' && isSandboxFailure(final.permissions ?? 'auto', turnError))
      throw new CoderError('read-only-unavailable', turnError);
    if (final.status === 'failed' && isStartupError(turnError)) {
      const chain = loadConfig(cwd).chain;
      const next = chain[chain.indexOf(dispatch.engine) + 1];
      if (!next)
        throw new CoderError('chain-exhausted', turnError, {
          payload: buildFallbackPayload(
            dispatch.engine,
            turnError,
            final.permissions ?? 'auto',
            opts.system,
            prompt,
          ),
        });
      opts.onFallback?.({ engine: dispatch.engine, detail: turnError, next });
      dispatch = await dispatchTask({
        ...dispatchOpts,
        engine: next,
        model: undefined,
        effort: undefined,
        name: undefined,
        resume: undefined,
        simulateApproval: undefined,
      });
      continue;
    }
    return {
      taskId,
      status: final.status,
      finalMessage: result?.finalMessage,
      ...(turnError ? { error: turnError } : {}),
      tokens: result?.tokens ?? null,
      model: result?.model ?? final.model ?? null,
    };
  }
}

export interface TaskInspection {
  taskId: string;
  status: string;
  task: Task;
  result: ReturnType<typeof readTask>['result'];
  steps: TaskLogEntry[];
  turns: ReturnType<typeof readTurnResults>;
  pendingApprovals: Array<{ id: string; summary: string; cwd: string | null }>;
  /** While running: time since the last sign of life, and whether it looks stalled. */
  idleMs?: number;
  lastActivityAt?: string | null;
  stalled?: boolean;
  /** While running: the last progress entry and the latest token snapshot. */
  lastLog?: TaskLogEntry;
  liveTokens?: TokenUsage | null;
}

/** A task's status and answer; `wait` blocks until it finishes or needs an approval. Omit the id for the latest task. */
async function result(
  id?: string,
  opts: TaskOptions & {
    wait?: boolean;
    tail?: number | 'all';
    onWaiting?: (taskId: string) => void;
  } = {},
): Promise<TaskInspection | TaskStatus> {
  const { cwd, api } = target(opts);
  if (api) {
    const status = await serverTask(api, id);
    return opts.wait ? api.tasks.wait(status.task.id) : status;
  }

  let task = localTask(cwd, id);
  if (opts.wait) {
    if (ACTIVE_STATUSES.includes(task.status)) opts.onWaiting?.(task.id);
    const outcome = await waitForTaskAttention(cwd, task);
    task = outcome.task;
    if (outcome.reason === 'approval')
      throw new CoderError(
        'approval-pending',
        `Approval needed for task ${task.id}: ${outcome.approval!.summary}`,
        {
          taskId: task.id,
          approval: outcome.approval,
        },
      );
  }
  const { steps, result } = readTask(cwd, task.id, { tail: opts.tail });
  const pending = listPendingApprovals(resolveTaskDir(cwd, task.id)).filter(a => !a.response);
  const running = ACTIVE_STATUSES.includes(task.status);
  const lastActivity = running ? lastActivityAt(cwd, task) : task.updatedAt;
  const idle = ageMs(lastActivity);
  return {
    taskId: task.id,
    status: running && pending.length ? 'waiting-approval' : task.status,
    task,
    result,
    steps,
    turns: readTurnResults(cwd, task.id),
    pendingApprovals: pending.map(a => ({ id: a.id, summary: a.summary, cwd: a.cwd ?? null })),
    ...(running
      ? {
          idleMs: idle,
          lastActivityAt: lastActivity ?? null,
          stalled: pending.length === 0 && idle > STALL_MS,
          lastLog: readTaskLog(cwd, task.id, 1)[0],
          // A task still in flight has no result to quote tokens from; its latest usage snapshot is the running count.
          liveTokens:
            (readTaskLog(cwd, task.id, 200)
              .reverse()
              .find(
                entry => entry.kind === 'usage' && String(entry.at ?? '') >= (task.resumedAt ?? ''),
              )?.tokens as TokenUsage | undefined) ?? null,
        }
      : {}),
  };
}

export interface TaskRow {
  taskId: string;
  status: Task['status'] | 'waiting-approval';
  pendingApprovals: number;
  engine: string | null;
  model: string | null;
  effort: string | null;
  name: string | null;
  cwd: string | null;
  prompt: string;
  updatedAt: string | undefined;
  archived: boolean;
  flowRunId: string | null;
  idleMs: number | null;
}

/** Recent tasks; `clipped` counts rows `limit` cut and `archived` the archived tasks, for the default view. */
async function list(
  opts: TaskOptions & ListOptions = {},
): Promise<(TaskRow[] & { clipped: number; archived: number }) | TaskStatus[]> {
  const { cwd, api } = target(opts);
  if (api) {
    const rows = await api.tasks.list({
      status: opts.running ? 'running' : undefined,
      limit: opts.limit === 'all' ? 200 : opts.limit,
      archived: opts.archived,
    });
    return opts.stopped
      ? rows.filter(row => TERMINAL_STATUSES.includes(row.status as Task['status']))
      : rows;
  }

  const { tasks, clipped } = collectTasks(cwd, { ...opts, dir: opts.dir ?? opts.cwd });
  const rows: TaskRow[] = tasks.map(task => {
    const pendingApprovals = ACTIVE_STATUSES.includes(task.status)
      ? listPendingApprovals(resolveTaskDir(cwd, task.id)).filter(a => !a.response).length
      : 0;
    return {
      taskId: task.id,
      status: pendingApprovals ? 'waiting-approval' : task.status,
      pendingApprovals,
      engine: task.engine ?? null,
      model: task.model ?? null,
      effort: task.effort ?? null,
      name: task.name ?? null,
      cwd: task.cwd ?? null,
      prompt: String(task.prompt ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80),
      updatedAt: task.updatedAt,
      archived: task.archived ?? false,
      flowRunId: task.flowRunId ?? null,
      // Idle = time since the engine last emitted anything (log, heartbeat, or task update).
      idleMs: ACTIVE_STATUSES.includes(task.status) ? ageMs(lastActivityAt(cwd, task)) : null,
    };
  });
  const archived =
    !rows.length && !opts.archived ? listArchivedTasks(cwd, { migrate: false }).length : 0;
  return Object.assign(rows, { clipped, archived });
}

export interface TaskWatch {
  task: Task | TaskStatus;
  /** Progress entries as they land, ending when the task is terminal. */
  events: AsyncGenerator<TaskLogEntry | TaskLogLine>;
  /** The task once the stream ends. */
  final(): Promise<{ taskId: string; status: string; result: any; task: Task } | TaskStatus>;
}

async function* serverLines(api: RemoteClient, taskId: string): AsyncGenerator<TaskLogLine> {
  let after = -1;
  for (;;) {
    const status = await api.tasks.get(taskId);
    for (const line of await api.tasks.logs(taskId, after)) {
      after = line.seq;
      yield line;
    }
    if (TERMINAL_STATUSES.includes(status.status as Task['status'])) return;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/** Follow a task live. `tail` replays only the last n steps (default 1). Omit the id for the latest task. */
async function watch(
  id?: string,
  opts: TaskOptions & { tail?: number | 'all' } = {},
): Promise<TaskWatch> {
  const { cwd, api } = target(opts);
  if (api) {
    const task = await serverTask(api, id);
    return {
      task,
      events: serverLines(api, task.task.id),
      final: () => api.tasks.get(task.task.id),
    };
  }
  const task = localTask(cwd, id);
  return {
    task,
    events: streamTask(cwd, task.id, { tail: opts.tail }),
    async final() {
      const current = reconcileTask(cwd, loadTask(cwd, task.id) ?? task);
      const result = readJsonFile<any>(path.join(resolveTaskDir(cwd, task.id), 'result.json'));
      return { taskId: task.id, status: current.status, result, task: current };
    },
  };
}

/** Steer a follow-up into a task (live, queued, or resumed on its thread); `wait` blocks on a live or resumed one. */
async function steer(
  id: string,
  text: string,
  opts: TaskOptions & {
    model?: string;
    effort?: string;
    permissions?: string;
    wait?: boolean;
  } = {},
) {
  const { cwd, api } = target(opts);
  if (api) return api.tasks.steer(id, text) as Promise<Record<string, unknown>>;
  const outcome = await steerTask(cwd, localTask(cwd, id), text, {
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
  });
  if (!opts.wait || outcome.steered === 'queued') return outcome;
  const current = loadTask(cwd, outcome.taskId);
  const final = current ? await waitForTerminalTask(cwd, current) : null;
  const done = readJsonFile<any>(path.join(resolveTaskDir(cwd, outcome.taskId), 'result.json'));
  return { ...outcome, status: final?.status ?? null, finalMessage: done?.finalMessage ?? null };
}

/** Ask about a task through a read-only sidecar; its thread is never touched. */
async function ask(
  id: string,
  question: string,
  opts: TaskOptions & { model?: string; effort?: string; onAsking?: (taskId: string) => void } = {},
) {
  const { cwd, api } = target(opts);
  if (api) return api.tasks.ask(id, question) as Promise<Record<string, unknown>>;
  const task = localTask(cwd, id);
  opts.onAsking?.(task.id);
  const result = await askTask(cwd, task, question, { model: opts.model, effort: opts.effort });
  return {
    taskId: task.id,
    answer: result.finalMessage || null,
    ...(result.error ? { error: result.error.message } : {}),
    ok: result.status === 0,
  };
}

export interface ApprovalRow {
  taskId: string;
  id: string;
  summary: string;
  cwd?: string | null;
  createdAt?: string;
  answered?: string | null;
}

/** A task's approvals, answered ones included; without an id, every pending approval of running tasks. */
async function approvals(
  id?: string,
  opts: TaskOptions = {},
): Promise<ApprovalRow[] | Record<string, unknown>[]> {
  const { cwd, api } = target(opts);
  if (api) {
    const tasks = id ? [await api.tasks.get(id)] : await api.tasks.list({ limit: 200 });
    return tasks.flatMap(task =>
      task.approval
        ? [{ taskId: task.task.id, ...(task.approval as Record<string, unknown>) }]
        : [],
    );
  }
  if (!id) return collectPending(cwd);
  const task = localTask(cwd, id);
  return listPendingApprovals(resolveTaskDir(cwd, task.id)).map(approval => ({
    taskId: task.id,
    id: approval.id,
    summary: approval.summary,
    cwd: approval.cwd ?? null,
    createdAt: approval.createdAt,
    answered: approval.response?.decision ?? null,
  }));
}

/** Answer an approval (accept, or `deny`). Locally the task id is optional: approval ids are unique. */
async function approve(
  reference: string | undefined,
  approvalId?: string,
  opts: TaskOptions & { deny?: boolean } = {},
) {
  const { cwd, api } = target(opts);
  const decision = opts.deny ? 'decline' : 'accept';
  if (api) {
    if (!reference || !approvalId)
      throw new CoderError('invalid-option', 'Server approvals need a task id and approval id.', {
        hint: 'Usage: coder task approve <task-id> <approval-id> --server <url>',
      });
    return api.tasks.approve(reference, approvalId, decision);
  }
  if (reference && !approvalId && reference.startsWith('apr-')) {
    approvalId = reference;
    reference = collectPending(cwd).find(row => row.id === approvalId)?.taskId;
    if (!reference)
      throw new CoderError('invalid-option', `No pending approval "${approvalId}".`, {
        hint: 'List them: coder task approvals',
      });
  }
  if (!reference || !approvalId)
    throw new CoderError('invalid-option', 'Missing approval id.', {
      hint: [
        'List them: coder task approvals',
        'Usage: coder task approve [task-id] <approval-id> [--deny]',
      ],
    });
  const task = localTask(cwd, reference);
  answerApproval(resolveTaskDir(cwd, task.id), approvalId, decision);
  return { taskId: task.id, approvalId, decision };
}

/** Stop a running task. */
async function stop(id?: string, opts: TaskOptions = {}) {
  const { cwd, api } = target(opts);
  if (api) return api.tasks.cancel(id ?? missingId([]));
  const task = localTask(cwd, id);
  const { interrupt } = await stopTask(cwd, task);
  return { taskId: task.id, status: 'cancelled' as const, interrupt };
}

/** Archive a task (hide it from the default list), or with `allStopped` every stopped one. */
async function archive(id?: string, opts: TaskOptions & { allStopped?: boolean } = {}) {
  const { cwd, api } = target(opts);
  if (api) {
    const ids = opts.allStopped
      ? (await api.tasks.list({ limit: 200 }))
          .filter(task => TERMINAL_STATUSES.includes(task.status as Task['status']))
          .map(task => task.task.id)
      : [id ?? missingId([])];
    await Promise.all(ids.map(each => api.tasks.archive(each)));
    return { archived: ids, count: ids.length };
  }
  if (opts.allStopped) {
    const targets = listTasks(cwd).filter(task => TERMINAL_STATUSES.includes(task.status));
    for (const task of targets) archiveTask(cwd, task);
    return { archived: targets.map(task => task.id), count: targets.length };
  }
  if (!id)
    missingId([
      'Archive one: coder task archive <task-id>',
      'Archive all stopped: coder task archive --all-stopped',
    ]);
  const task = localTask(cwd, id);
  archiveTask(cwd, task);
  return { taskId: task.id, archived: true as const };
}

/** Delete a stopped task and its engine session, or with `allArchived` every archived one. */
async function remove(id?: string, opts: TaskOptions & { allArchived?: boolean } = {}) {
  const { cwd, api } = target(opts);
  if (api) {
    const ids = opts.allArchived
      ? (await api.tasks.list({ limit: 200, archived: true })).map(task => task.task.id)
      : [id ?? missingId([])];
    await Promise.all(ids.map(each => api.tasks.delete(each)));
    return { deleted: ids, count: ids.length };
  }
  if (opts.allArchived) {
    const ids = listArchivedTasks(cwd)
      .filter(task => deleteTask(cwd, task))
      .map(task => task.id);
    return { deleted: ids, count: ids.length };
  }
  if (!id)
    missingId([
      'Delete one: coder task delete <task-id>',
      'Delete all archived: coder task delete --all-archived',
    ]);
  const task = localTask(cwd, id);
  if (task.status === 'running')
    throw new CoderError('invalid-option', `Task ${task.id} is still running.`, {
      hint: `Stop it first: coder task stop ${task.id}`,
    });
  deleteTask(cwd, task);
  return { taskId: task.id, deleted: true as const };
}

/** Follow a task live as an async iterable of its progress entries. */
async function* stream(id?: string, opts: TaskOptions & { tail?: number | 'all' } = {}) {
  yield* (await watch(id, opts)).events;
}

/** Run and control coder tasks. */
export const tasks = {
  run,
  result,
  list,
  watch,
  stream,
  steer,
  ask,
  approvals,
  approve,
  stop,
  archive,
  delete: remove,
};
