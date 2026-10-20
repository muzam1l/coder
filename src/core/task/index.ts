/** The task API the CLI and the SDK share: each call works on this machine's tasks, or on a Coder server with `server`. */
import path from 'node:path';
import process from 'node:process';

import { connect, type RemoteClient, type ServerOptions } from '../remote';
import type { TaskLogLine, TaskStatus } from '../../server/store/types';
import { readJsonFile } from '../../utils/fsx';
import { decodeJson, encodeJson } from '../../utils/base64url';
import { serverSuffix } from '../../utils/args';
import { serverEvents } from '../../client';
import { deniedApprovals, listApprovals, pendingApprovals } from '../approvals';
import { loadConfig } from '../config';
import { localConnections } from '../connections';
import {
  buildFallbackPayload,
  CoderError,
  dispatchTask,
  ignoredAddDirs,
  selectMcpServers,
  isSandboxFailure,
  turnFallbackEngine,
  readTask,
  waitTask,
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
  type TaskLogEntry,
} from '../state';
import {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  type Approval,
  type Task,
  type TokenUsage,
} from '../types';
import { waitForTaskAttention } from '../dispatch';
import {
  deleteTask,
  stopTask,
  collectTasks,
  streamTask,
  type ListOptions,
  askTask,
  answerTaskApproval,
  collectApprovals,
  steerTask,
  type SteerOutcome,
} from './actions';
import { iso, remoteApprovals, remoteResult, remoteStep, remoteTask, remoteTurns } from './remote';

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

/** Follow a server task until it ends; a pending approval stops it as it stops a local wait. */
async function waitServer(api: RemoteClient, id: string): Promise<TaskStatus> {
  for (;;) {
    const status = await api.tasks.wait(id);
    // Before a terminal return: a task can escalate and end its turn before this read.
    const approval = remoteApprovals(status).find(entry => !entry.answered);
    if (approval)
      throw new CoderError(
        'approval-pending',
        `Approval needed for task ${id}: ${approval.reason}`,
        { taskId: id, approval },
      );
    // An approval answered before this read leaves the task running.
    if (TERMINAL_STATUSES.includes(status.status as Task['status'])) return status;
  }
}

/** The commands that manage a started task, on the server it runs on. */
function taskCommands(taskId: string, opts: TaskOptions): NonNullable<RunResult['commands']> {
  const flags = serverSuffix({ server: opts.server, workspace: opts.organization });

  return {
    result: `coder task result ${taskId} --wait${flags}`,
    steer: `coder task steer ${taskId} "<follow-up>"${flags}`,
    stop: `coder task stop ${taskId}${flags}`,
    list: `coder task list${flags}`,
  };
}

/** A finished task's answer, as `run --wait` returns it. */
function finished(task: Task, result: TaskInspection['result']): RunResult {
  const error = result?.error?.message || task.error;

  return {
    taskId: task.id,
    status: task.status,
    finalMessage: result?.finalMessage,
    ...(error ? { error } : {}),
    tokens: result?.tokens ?? null,
    model: result?.model ?? task.model ?? null,
  };
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
  appendSystem?: string;
  /** Extra directories the task may reach, resolved against cwd. */
  addDirs?: string[];
  /** MCP servers to attach, by name from config. */
  mcp?: string;
  /** Connection ids the task may use, within the agent's. */
  connections?: string[];
  /** Block until the task finishes, walking the engine chain when a turn fails to start. */
  wait?: boolean;
  /** Server tasks: the repository and runner to use. */
  repo?: string;
  runner?: string;
  onFallback?: (fallback: { engine: string; detail: string; next: string }) => void;
  onNote?: (note: string) => void;
  /** Each time a wait starts on a task id. */
  onWaiting?: (taskId: string) => void;
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
async function run(prompt: string, opts: TaskRunOptions & TaskOptions = {}): Promise<RunResult> {
  if (
    opts.outputSchema !== undefined &&
    (!opts.outputSchema ||
      typeof opts.outputSchema !== 'object' ||
      Array.isArray(opts.outputSchema))
  )
    throw new CoderError('invalid-option', 'outputSchema must be an object.');
  const { cwd, api } = target(opts);
  if (api) {
    const created = await api.tasks.create({
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
      ...(opts.connections ? { connections: opts.connections } : {}),
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.appendSystem ? { appendSystem: opts.appendSystem } : {}),
      ...(opts.addDirs?.length ? { addDirs: opts.addDirs.map(dir => path.resolve(cwd, dir)) } : {}),
    });
    const taskId = created.task.id;
    const ignored = opts.addDirs?.length ? ignoredAddDirs(created.task.runner) : undefined;
    if (ignored) opts.onNote?.(ignored);
    if (!opts.wait)
      return {
        taskId,
        status: created.status,
        startupCheck: 'pending',
        commands: taskCommands(taskId, opts),
      };
    opts.onWaiting?.(taskId);
    const status = await waitServer(api, taskId);

    return finished(remoteTask(status), remoteResult(status));
  }

  // A local agent's options come from its definition, loaded only when asked for.
  const agent = opts.agent
    ? await (
        await import('../../agent/exec')
      ).agentTaskOptions(cwd, opts.agent, opts.mcp, undefined, opts.connections)
    : undefined;
  const connected = agent?.connected ?? (await localConnections(opts.connections));
  for (const warning of connected.warnings) opts.onNote?.(warning);
  const config = loadConfig(cwd);
  const selectedMcp = agent ?? selectMcpServers(opts.mcp, config.mcp, {}, connected.mcp);
  const dispatchOpts: DispatchOptions = {
    prompt,
    outputSchema: opts.outputSchema,
    cwd,
    engine: opts.engine ?? agent?.engine,
    model: opts.model ?? (opts.engine ? undefined : agent?.model),
    effort: opts.effort ?? (opts.engine ? undefined : agent?.effort),
    permissions: opts.permissions ?? agent?.permissions,
    name: opts.name,
    appendSystem: opts.appendSystem,
    ...(agent ? { agentPrompt: { developer: agent.developer } } : {}),
    wait: opts.wait,
    addDirs: opts.addDirs,
    ...(opts.agent ? { agentId: opts.agent } : {}),
    mcp: selectedMcp.mcp,
    mcpBindings: selectedMcp.mcpBindings,
    mcpWarnings: selectedMcp.warnings,
    connectionEnv: connected.env,
    connections: connected.ids,
    nativeMcp: selectedMcp.nativeMcp,
    ...(opts.onFallback ? { onFallback: opts.onFallback } : {}),
    ...(opts.onNote ? { onNote: opts.onNote } : {}),
  };
  let dispatch = await dispatchTask(dispatchOpts, { config });

  if (!opts.wait) {
    const taskId = dispatch.taskId;
    return {
      taskId,
      status: dispatch.task.status,
      startupCheck: dispatch.startupCheck,
      commands: taskCommands(taskId, opts),
    };
  }

  // A turn that ends with a startup-ish error (usage, auth, quota) walks the chain like a failed start.
  for (;;) {
    const taskId = dispatch.taskId;
    opts.onWaiting?.(taskId);
    const waited = await waitTask(cwd, taskId);
    const { task: final, result } = waited;
    const turnError = result?.error?.message ?? '';
    if (final.status === 'failed' && isSandboxFailure(final.permissions ?? 'auto', turnError))
      throw new CoderError('read-only-unavailable', turnError);
    const next = turnFallbackEngine(cwd, waited, config);
    if (next !== undefined) {
      if (next === null)
        throw new CoderError('chain-exhausted', turnError, {
          payload: buildFallbackPayload(
            dispatch.engine,
            turnError,
            final.permissions ?? 'auto',
            opts.appendSystem,
            prompt,
          ),
        });
      opts.onFallback?.({ engine: dispatch.engine, detail: turnError, next });
      dispatch = await dispatchTask(
        {
          ...dispatchOpts,
          engine: next,
          model: undefined,
          effort: undefined,
          name: undefined,
        },
        { config },
      );
      continue;
    }
    return finished(final, result);
  }
}

export interface TaskInspection {
  taskId: string;
  status: string;
  task: Task;
  result: ReturnType<typeof readTask>['result'];
  steps: TaskLogEntry[];
  turns: ReturnType<typeof readTurnResults>;
  pendingApprovals: Array<{ id: string; reason: string; actions: string[] }>;
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
): Promise<TaskInspection> {
  const { cwd, api } = target(opts);
  if (api) {
    let status = await serverTask(api, id);
    if (opts.wait) {
      if (!['completed', 'failed', 'cancelled'].includes(status.status))
        opts.onWaiting?.(status.task.id);
      status = await waitServer(api, status.task.id);
    }
    const logs = opts.tail ? ((await api.tasks.logs(status.task.id)) as TaskLogLine[]) : [];
    const steps = (opts.tail === 'all' ? logs : logs.slice(-Number(opts.tail))).map(remoteStep);

    return remoteInspection(status, steps);
  }

  let task = localTask(cwd, id);
  if (opts.wait) {
    if (ACTIVE_STATUSES.includes(task.status)) opts.onWaiting?.(task.id);
    const outcome = await waitForTaskAttention(cwd, task);
    task = outcome.task;
    if (outcome.reason === 'approval')
      throw new CoderError(
        'approval-pending',
        `Approval needed for task ${task.id}: ${outcome.approval!.reason}`,
        {
          taskId: task.id,
          approval: outcome.approval,
        },
      );
  }
  const { steps, result, turns } = readTask(cwd, task.id, { tail: opts.tail, task });
  const pending = pendingApprovals(resolveTaskDir(cwd, task.id));
  const running = ACTIVE_STATUSES.includes(task.status);
  const lastActivity = running ? lastActivityAt(cwd, task) : task.updatedAt;
  const idle = ageMs(lastActivity);
  const recent = running ? readTaskLog(cwd, task.id, 200) : [];
  return {
    taskId: task.id,
    status: running && pending.length ? 'waiting-approval' : task.status,
    task,
    result,
    steps,
    turns,
    pendingApprovals: pending.map(({ id, reason, actions }) => ({ id, reason, actions })),
    ...(running
      ? {
          idleMs: idle,
          lastActivityAt: lastActivity ?? null,
          stalled: pending.length === 0 && idle > STALL_MS,
          lastLog: recent.at(-1),
          // A task still in flight has no result to quote tokens from; its latest usage snapshot is the running count.
          liveTokens:
            (recent
              .reverse()
              .find(
                entry => entry.kind === 'usage' && String(entry.at ?? '') >= (task.resumedAt ?? ''),
              )?.tokens as TokenUsage | undefined) ?? null,
        }
      : {}),
  };
}

/** A server task as `result` inspects a local one. */
function remoteInspection(status: TaskStatus, steps: TaskLogEntry[]): TaskInspection {
  const task = remoteTask(status);
  const pending = remoteApprovals(status)
    .filter(approval => !approval.answered)
    .map(({ id, reason, actions }) => ({ id, reason, actions }));
  const running = ACTIVE_STATUSES.includes(task.status);
  const lastActivity = iso(status.lastActivityAt ?? status.updatedAt);
  const idle = ageMs(lastActivity);

  return {
    taskId: task.id,
    status: running && pending.length ? 'waiting-approval' : task.status,
    task,
    result: remoteResult(status),
    steps,
    turns: remoteTurns(status),
    pendingApprovals: pending,
    ...(running
      ? {
          idleMs: idle,
          lastActivityAt: lastActivity ?? null,
          stalled: pending.length === 0 && idle > STALL_MS,
          liveTokens: null,
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

/** One page of tasks; `next` continues it, and `archived` counts archived tasks when a default view is empty. */
export interface TaskPage {
  items: TaskRow[] & { archived: number };
  next?: string;
}

/** A list row; idle is the time since the engine last emitted anything (log, heartbeat, or task update). */
function taskRow(task: Task, pendingApprovals: number, lastActivity?: string | null): TaskRow {
  const running = ACTIVE_STATUSES.includes(task.status);

  return {
    taskId: task.id,
    status: running && pendingApprovals ? 'waiting-approval' : task.status,
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
    idleMs: running ? ageMs(lastActivity ?? undefined) : null,
  };
}

/** Recent tasks, a page at a time (default 50, `limit: 'all'` for every one). */
async function list(opts: TaskOptions & ListOptions & { cursor?: string } = {}): Promise<TaskPage> {
  const { cwd, api } = target(opts);
  const limit = opts.limit ?? 50;
  if (api) {
    const items: TaskRow[] = [];
    let cursor = opts.cursor ?? '';
    let next: string | undefined;
    // A --stopped page keeps reading until it is full, so a run of active rows never ends it early.
    do {
      const page = (await api.tasks.list({
        cursor,
        limit: limit === 'all' ? 200 : Math.min(200, limit - items.length),
        status: opts.running ? 'active' : undefined,
        archived: opts.archived,
      })) as unknown as { items: TaskStatus[]; next?: string };
      for (const row of page.items)
        if (!opts.stopped || TERMINAL_STATUSES.includes(row.status as Task['status']))
          items.push(
            taskRow(
              remoteTask(row),
              remoteApprovals(row).filter(approval => !approval.answered).length,
              iso(row.lastActivityAt ?? row.updatedAt),
            ),
          );
      next = page.next;
      cursor = next ?? '';
    } while (next && (limit === 'all' || items.length < limit));

    return { items: Object.assign(items, { archived: 0 }), ...(next ? { next } : {}) };
  }

  const { tasks } = collectTasks(cwd, { ...opts, limit: 'all', dir: opts.dir ?? opts.cwd });
  const rows = tasks.map(task =>
    taskRow(
      task,
      ACTIVE_STATUSES.includes(task.status)
        ? pendingApprovals(resolveTaskDir(cwd, task.id)).length
        : 0,
      ACTIVE_STATUSES.includes(task.status) ? lastActivityAt(cwd, task) : null,
    ),
  );
  let after = 0;
  if (opts.cursor) {
    let id: string;
    try {
      id = decodeJson<string>(opts.cursor);
      if (typeof id !== 'string') throw new Error();
    } catch {
      throw new CoderError('invalid-option', 'Invalid task list cursor.');
    }
    const index = rows.findIndex(row => row.taskId === id);
    if (index < 0)
      throw new CoderError(
        'invalid-option',
        'Task list cursor is no longer available; start a new list.',
      );
    after = index + 1;
  }
  const items = rows.slice(after, limit === 'all' ? undefined : after + limit);
  const archived =
    !rows.length && !opts.archived ? listArchivedTasks(cwd, { migrate: false }).length : 0;

  return {
    items: Object.assign(items, { archived }),
    ...(after + items.length < rows.length ? { next: encodeJson(items.at(-1)!.taskId) } : {}),
  };
}

export interface TaskWatch {
  task: Task;
  /** Progress entries as they land, ending when the task is terminal. */
  events: AsyncGenerator<TaskLogEntry>;
  /** The task once the stream ends. */
  final(): Promise<{ taskId: string; status: string; result: any; task: Task }>;
}

async function* serverLines(api: RemoteClient, taskId: string): AsyncGenerator<TaskLogEntry> {
  let after = -1;
  for (;;) {
    const response = await api.tasks.stream(taskId, after);
    if (!response.ok || !response.body) {
      const status = await api.tasks.get(taskId);
      if (TERMINAL_STATUSES.includes(status.status as Task['status'])) return;
      if (response.status === 401) continue;
      throw new CoderError('server', `The task stream answered ${response.status}.`);
    }
    let ended = false;
    for await (const event of serverEvents(response.body)) {
      if (event.event === 'log') {
        const line = JSON.parse(event.data) as TaskLogLine;
        after = line.seq;
        yield remoteStep(line);
      } else if (event.event === 'end') ended = true;
    }
    if (ended) return;
  }
}

async function* each<T>(items: T[] | Promise<T[]>): AsyncGenerator<T> {
  yield* await items;
}

/** Follow a task live. `tail` replays only the last n steps (default 1); `from` lists the log from that event on, without following. Omit the id for the latest task. */
async function watch(
  id?: string,
  opts: TaskOptions & { tail?: number | 'all'; from?: number } = {},
): Promise<TaskWatch> {
  const { cwd, api } = target(opts);
  if (api) {
    const task = remoteTask(await serverTask(api, id));
    return {
      task,
      events:
        opts.from === undefined
          ? serverLines(api, task.id)
          : each(
              api.tasks
                .logs(task.id, opts.from - 1)
                .then(lines => (lines as TaskLogLine[]).map(remoteStep)),
            ),
      async final() {
        const status = await api.tasks.get(task.id);
        const current = remoteTask(status);
        return {
          taskId: task.id,
          status: current.status,
          result: remoteResult(status),
          task: current,
        };
      },
    };
  }
  const task = localTask(cwd, id);
  return {
    task,
    events:
      opts.from === undefined
        ? streamTask(cwd, task.id, { tail: opts.tail })
        : each(readTaskLog(cwd, task.id, Infinity).slice(opts.from)),
    async final() {
      const current = reconcileTask(cwd, loadTask(cwd, task.id) ?? task);
      const result = readJsonFile<any>(path.join(resolveTaskDir(cwd, task.id), 'result.json'));
      return { taskId: task.id, status: current.status, result, task: current };
    },
  };
}

export interface SteerResult {
  taskId: string;
  steered: SteerOutcome;
  /** With `wait`, once a live or resumed turn finishes. */
  status?: string | null;
  finalMessage?: string | null;
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
): Promise<SteerResult> {
  const { cwd, api } = target(opts);
  if (api) {
    const answer = (await api.tasks.steer(id, text, {
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.effort ? { effort: opts.effort } : {}),
      ...(opts.permissions ? { permissions: opts.permissions } : {}),
    })) as { steered?: SteerOutcome; task?: unknown };
    // A finished task resumes as a new turn; a live one takes the follow-up in its inbox.
    const steered = answer.steered ?? (answer.task ? 'resumed' : 'live');
    if (!opts.wait || steered === 'queued') return { taskId: id, steered };
    const status = await waitServer(api, id);

    return {
      taskId: id,
      steered,
      status: remoteTask(status).status,
      finalMessage: remoteResult(status)?.finalMessage ?? null,
    };
  }
  const outcome = await steerTask(cwd, localTask(cwd, id), text, {
    model: opts.model,
    effort: opts.effort,
    permissions: opts.permissions,
  });
  if (!opts.wait || outcome.steered === 'queued') return outcome;
  const current = loadTask(cwd, outcome.taskId);
  const final = current ? (await waitTask(cwd, current.id)).task : null;
  const done = readJsonFile<any>(path.join(resolveTaskDir(cwd, outcome.taskId), 'result.json'));
  return { ...outcome, status: final?.status ?? null, finalMessage: done?.finalMessage ?? null };
}

/** Ask about a task through a read-only sidecar; its thread is never touched. */
export interface AskResult {
  taskId: string;
  answer: string | null;
  error?: string;
  ok: boolean;
}

/** A server task's sidecar answer: a local server's comes with the request, a runner's lands in the task's answers. */
async function askServer(api: RemoteClient, id: string, question: string): Promise<AskResult> {
  const before = (await api.tasks.get(id)).answer?.length ?? 0;
  const abort = new AbortController();
  let response = await api.tasks.events([id], undefined, abort.signal);
  try {
    let answer = ((await api.tasks.ask(id, question)) as { answer?: unknown }).answer;
    let ended = false;
    let last: string | undefined;
    while (answer === undefined && !ended) {
      if (!response.ok || !response.body)
        throw new CoderError('server', `The task events stream answered ${response.status}.`);
      for await (const event of serverEvents(response.body)) {
        last = event.id ?? last;
        if (event.event !== 'task') continue;
        const state = JSON.parse(event.data) as {
          id: string;
          status?: string;
          deleted?: boolean;
          answer?: unknown[] | null;
        };
        if (state.id !== id) continue;
        if ((state.answer?.length ?? 0) > before) answer = state.answer![before];
        else
          ended =
            Boolean(state.deleted) || TERMINAL_STATUSES.includes(state.status as Task['status']);
        if (answer !== undefined || ended) break;
      }
      if (answer === undefined && !ended)
        response = await api.tasks.events([id], last, abort.signal);
    }
    const text = typeof answer === 'string' ? answer : '';

    return {
      taskId: id,
      answer: text || null,
      ...(answer === undefined ? { error: 'The task ended before it answered.' } : {}),
      ok: Boolean(text),
    };
  } finally {
    abort.abort();
  }
}

async function ask(
  id: string,
  question: string,
  opts: TaskOptions & { model?: string; effort?: string; onAsking?: (taskId: string) => void } = {},
): Promise<AskResult> {
  const { cwd, api } = target(opts);
  if (api) {
    opts.onAsking?.(id);
    return askServer(api, id, question);
  }
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
  reason: string;
  actions: string[];
  createdAt?: string;
  answered?: 'accept' | 'decline' | 'closed' | null;
  deniedReason?: string | null;
}

const approvalRow = (taskId: string, approval: Approval): ApprovalRow => ({
  taskId,
  id: approval.id,
  reason: approval.reason,
  actions: approval.actions,
  createdAt: approval.createdAt,
  answered: approval.response?.decision ?? null,
  deniedReason:
    approval.response?.decision === 'decline' ? (approval.response.reason ?? null) : null,
});

/** One task's approvals, answered ones included (`denied`: only the denied ones); without an id, the pending (or denied) approvals of every task, ended ones too. */
async function approvals(
  id?: string,
  opts: TaskOptions & { denied?: boolean } = {},
): Promise<ApprovalRow[]> {
  const { cwd, api } = target(opts);
  if (api) {
    const tasks = id ? [await api.tasks.get(id)] : await api.tasks.list({ limit: 200 });
    return tasks.flatMap(task =>
      remoteApprovals(task)
        .filter(approval =>
          opts.denied ? approval.answered === 'decline' : id || !approval.answered,
        )
        .map(approval => ({ taskId: task.task.id, ...approval })),
    );
  }
  const pick = opts.denied ? deniedApprovals : pendingApprovals;
  if (!id)
    return collectApprovals(cwd, pick, 'all').map(({ taskId, ...approval }) =>
      approvalRow(taskId, approval),
    );
  const task = localTask(cwd, id);
  return (opts.denied ? deniedApprovals : listApprovals)(resolveTaskDir(cwd, task.id)).map(
    approval => approvalRow(task.id, approval),
  );
}

/** Answer an approval, pending or denied: accept, or `deny` with a reason. Locally the task id is optional: approval ids are unique. */
async function approve(
  reference: string | undefined,
  approvalId?: string,
  opts: TaskOptions & { deny?: boolean; reason?: string } = {},
) {
  const { cwd, api } = target(opts);
  const decision = opts.deny ? 'decline' : 'accept';
  if (api) {
    if (!reference || !approvalId)
      throw new CoderError('invalid-option', 'Server approvals need a task id and approval id.', {
        hint: 'Usage: coder task approve <task-id> <approval-id> --server <url>',
      });
    await api.tasks.approve(
      reference,
      approvalId,
      decision,
      opts.reason ? { reason: opts.reason } : {},
    );
    return { taskId: reference, approvalId, decision };
  }
  if (reference && !approvalId && reference.startsWith('apr-')) {
    approvalId = reference;
    reference = collectApprovals(cwd, listApprovals, 'all').find(
      row => row.id === approvalId,
    )?.taskId;
    if (!reference)
      throw new CoderError('invalid-option', `No approval "${approvalId}".`, {
        hint: 'List them: coder task approvals',
      });
  }
  if (!reference || !approvalId)
    throw new CoderError('invalid-option', 'Missing approval id.', {
      hint: [
        'List them: coder task approvals',
        'Usage: coder task approve [task-id] <approval-id> [--deny] [--reason <why>]',
      ],
    });
  const task = localTask(cwd, reference);
  await answerTaskApproval(cwd, task, approvalId, decision, { reason: opts.reason });
  return { taskId: task.id, approvalId, decision };
}

/** Stop a running task. */
async function stop(id?: string, opts: TaskOptions = {}) {
  const { cwd, api } = target(opts);
  if (api) {
    const taskId = id ?? (await serverTask(api)).task.id;
    await api.tasks.cancel(taskId);
    return { taskId, status: 'cancelled' as const, interrupt: 'stop requested on the server' };
  }
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
      : [];
    if (!opts.allStopped) {
      if (!id) missingId(['Archive one: coder task archive <task-id> --server']);
      await api.tasks.archive(id);
      return { taskId: id, archived: true as const };
    }
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
      : [];
    if (!opts.allArchived) {
      if (!id) missingId(['Delete one: coder task delete <task-id> --server']);
      await api.tasks.delete(id);
      return { taskId: id, deleted: true as const };
    }
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
