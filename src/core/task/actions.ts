/** What a task can be asked to do on this machine: steer it, ask it, answer its approvals, list and stream it, stop, archive and delete it. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import {
  appendTaskLog,
  watchTask,
  enqueueSteer,
  steerKnown,
  withTaskAdmission,
  loadTask,
  unarchiveTask,
  writeTask,
  resolveTaskDir,
  LIVE_STEER,
  listTasks,
  archiveDue,
  listArchivedTasks,
  queueOwnedTasks,
  resolveWorkspaceRoot,
  reconcileTask,
  processStartMs,
  isPidAlive,
  processStarts,
  tailSteps,
  type TaskLogEntry,
  archiveTask,
  removeTaskDir,
  ageMs,
  STALL_MS,
  findTask,
  lastActivityAt,
  readTaskLog,
  formatEngineSpec,
} from '../state';
import { steerTurn, runTurn, interruptTurn } from '../engines/codex';
import { steerClaudeTurn, runClaudeTurn, type ClaudeTurnOptions } from '../engines/claude';
import {
  ACTIVE_STATUSES,
  type Approval,
  type McpServerSpec,
  type Task,
  type Effort,
  type TurnResult,
  STOPPED_BY_USER,
  TERMINAL_STATUSES,
  type TokenUsage,
} from '../types';
import { byListKey, listRank, promptTitle } from './view';
import {
  CoderError,
  resolveMcpServers,
  selectMcpServers,
  spawnWorker,
  buildFallbackPayload,
  dispatchTask,
  ignoredAddDirs,
  resolveTaskOptions,
  WORKER_ENV,
  isSandboxFailure,
  modelList,
  turnFallbackModel,
  readTask,
  waitTask,
  type DispatchOptions,
  waitForTaskAttention,
} from '../dispatch';
import { connectionEnvironment, localConnections } from '../connections';
import {
  isEndpointModel,
  loadConfig,
  resolveCodexModel,
  splitEngineSpec,
  strictestAccess,
  type Access,
} from '../config';
import {
  answerApproval,
  approvalMessage,
  closeApprovals,
  listApprovals,
  markDelivered,
  deniedApprovals,
  pendingApprovals,
} from '../approvals';
import { createJsonlTail, readJsonFile } from '../../utils/fsx';
import { removeCodexControlEndpoint } from '../engines/codex/control';
import { mailboxId, namedCommand, type MailboxKey } from '../mailbox';
import { deleteCodexSession } from '../engines/codex/sessions';
import { deleteClaudeSession, conversationIds } from '../engines/history';
import { askPrompt } from './context/turn';
import { coderClient, connect, type RemoteClient } from '../remote';
import type { TaskLogLine, TaskStatus } from '../../server/store/types';
import { decodeJson, encodeJson } from '../../utils/crypto';
import { serverSuffix } from '../../utils/args';
import { serverEvents, isLoopbackServer } from '../../client/http';
import {
  iso,
  remoteApprovals,
  remoteInspection,
  remoteResult,
  remoteStep,
  remoteTask,
} from './remote';
import type {
  ApprovalRow,
  AskResult,
  RunResult,
  SteerResult,
  TaskInspection,
  TaskOptions,
  TaskPage,
  TaskRow,
  TaskRunOptions,
  TaskWatch,
} from '.';

export type ConnectionResolver = (
  granted: string[],
) => Promise<Pick<Awaited<ReturnType<typeof localConnections>>, 'mcp' | 'env' | 'warnings'>>;

/** The granted connections among servers a task already resolved, their values from this process's env. */
export function heldConnections(
  servers: McpServerSpec[] | undefined,
  cwd?: string,
  pin = (server: McpServerSpec) => server,
): ConnectionResolver {
  return async granted => ({
    ...connectionEnvironment(
      Object.fromEntries(
        resolveMcpServers(servers, process.env, cwd).flatMap(server => {
          const id = server.connection ?? server.name;

          return granted.includes(id) ? [[id, pin(server)]] : [];
        }),
      ),
    ),
    warnings: [],
  });
}

/** A next turn's servers: the task's own, each connection-bound one taking its value from `connections`, plus the turn's new connections. */
export function turnServers(task: Task, connections: Record<string, McpServerSpec>) {
  const servers =
    task.mcp?.map(server => {
      const connection =
        server.connection ??
        (server.resolved && task.connections?.includes(server.name) ? server.name : undefined);
      return connection ? { ...server, connection, resolved: false } : server;
    }) ?? [];
  const bindings =
    task.mcpBindings ??
    servers
      .filter(server => server.connection)
      .map(({ name, connection, tools }) => ({ name, connection, ...(tools ? { tools } : {}) }));
  const declared = new Set(bindings.map(server => server.connection));
  const selected = selectMcpServers(
    [...bindings, ...servers.filter(server => !declared.has(server.connection))],
    {},
    {},
    connections,
  );

  return { selected, bindings };
}

/** How a steer was applied to a task. */
export type SteerOutcome = 'live' | 'queued' | 'resumed';

// Inject a follow-up into a running task's live turn, or queue it when it
// can't be injected live. Null means the task is not running (anymore): the
// caller should resume it as a fresh turn on its thread.
async function trySteerRunning(
  cwd: string,
  task: Task,
  text: string,
  command: MailboxKey | undefined,
  adapters: {
    codex?: typeof steerTurn;
    claude?: typeof steerClaudeTurn;
  } = {},
): Promise<{ taskId: string; steered: 'live' | 'queued' } | null> {
  if (task.status !== 'running') {
    return null;
  }
  const result =
    task.engine === 'claude'
      ? await (adapters.claude ?? steerClaudeTurn)(task.steerEndpoint, text, undefined, command)
      : await (adapters.codex ?? steerTurn)(cwd, {
          endpoint: task.steerEndpoint,
          threadId: task.threadId,
          turnId: task.turnId,
          text,
          command,
        });
  if (result.steered) {
    appendTaskLog(cwd, task.id, {
      kind: 'steer',
      message: `${LIVE_STEER}${text}`,
    });
    return { taskId: task.id, steered: 'live' };
  }
  if (!result.retryable) {
    appendTaskLog(cwd, task.id, {
      kind: 'error',
      message: `Live steer failed: ${result.detail}`,
    });
    throw new Error(`Could not steer running task ${task.id}: ${result.detail}`);
  }

  return null;
}

function queueSteer(cwd: string, id: string, text: string, key?: string): void {
  if (enqueueSteer(cwd, id, text, key))
    appendTaskLog(cwd, id, { kind: 'steer', message: `Steer queued for the next turn:\n${text}` });
}

// Print-free core (SDK `task.steer`).
export async function steerTask(
  cwd: string,
  task: Task,
  text: string,
  opts: {
    model?: string;
    access?: Access;
    outputSchema?: object;
    command?: MailboxKey;
    onWorker?: (worker: ChildProcess) => void;
    resolveConnections?: ConnectionResolver;
    credentialEnv?: NodeJS.ProcessEnv;
  } = {},
  adapters: {
    codex?: typeof steerTurn;
    claude?: typeof steerClaudeTurn;
  } = {},
): Promise<{ taskId: string; steered: SteerOutcome }> {
  task = loadTask(cwd, task.id) ?? task;
  if (!task.threadId) {
    throw new CoderError(
      'invalid-option',
      `Task ${task.id} has no thread to steer yet (status: ${task.status}).`,
      {
        hint: `Wait for it to start: coder task watch ${task.id}`,
      },
    );
  }
  const running = await trySteerRunning(cwd, task, text, opts.command, adapters);
  if (running) {
    const current = loadTask(cwd, task.id) ?? task;
    if (current.archived) unarchiveTask(cwd, current);
    return running;
  }
  return { taskId: task.id, steered: await resumeInPlace(cwd, task, text, opts) };
}

function claimResume(claim: string): boolean {
  const staging = fs.mkdtempSync(`${claim}-`);
  const owner = `${process.pid}-${processStartMs(process.pid) ?? 0}-${randomUUID()}`;
  fs.mkdirSync(path.join(staging, owner));
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.renameSync(staging, claim);
        return true;
      } catch (error) {
        if (
          !['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')
        )
          throw error;
      }
      try {
        if (fs.statSync(claim).isFile()) {
          if (Date.now() - fs.statSync(claim).mtimeMs < 60_000) return false;
          fs.unlinkSync(claim);
          continue;
        }
        for (const entry of fs.readdirSync(claim)) {
          const parts = entry.split('-');
          const pid = Number(parts[0]);
          const started = Number(parts[1]);
          let alive = false;
          if (Number.isInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
              alive = true;
            } catch (error) {
              alive = (error as NodeJS.ErrnoException).code === 'EPERM';
            }
          }
          const actual = alive ? processStartMs(pid) : null;
          if (alive && (!started || actual === null || actual === started)) return false;
          // Remove only the observed owner, so a racing takeover cannot lose its marker.
          fs.rmdirSync(path.join(claim, entry));
        }
        fs.rmdirSync(claim);
      } catch (error) {
        if (!['ENOENT', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? ''))
          throw error;
      }
    }
    return false;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// A stopped task resumes on the SAME task record (never a stray new task id),
// in the task's own cwd: claude finds session transcripts per project dir.
async function resumeInPlace(
  cwd: string,
  task: Task,
  text: string,
  opts: NonNullable<Parameters<typeof steerTask>[3]>,
): Promise<'resumed' | 'queued'> {
  if (task.connectionSource === 'server' && !opts.resolveConnections)
    throw new Error('Server connection resolver is required to resume this task');
  const { model, effort } = turnModel(cwd, task, opts.model);
  // One resume per finished turn: a steer racing it, or reaching it before it runs, waits for the next turn.
  const admission = await withTaskAdmission(cwd, task.id, () => {
    const stored = loadTask(cwd, task.id) ?? task;
    const fresh =
      stored.resumeOwner && !isPidAlive(stored.resumeOwner) ? reconcileTask(cwd, stored) : stored;
    const turn = [fresh?.completedAt, fresh?.resumedAt].map(at => Date.parse(at ?? '') || 0);
    const claim = path.join(resolveTaskDir(cwd, task.id), `resume-${turn.join('-')}`);
    const owning =
      fresh &&
      !fresh.steerClosed &&
      (ACTIVE_STATUSES.includes(fresh.status) ||
        (fresh.status === 'completed' && fresh.steerClosed === false && isPidAlive(fresh.pid)));
    if (owning || !claimResume(claim)) {
      if (fresh.archived) unarchiveTask(cwd, fresh);
      queueSteer(cwd, task.id, text);
      return undefined;
    }
    if (fresh.archived) unarchiveTask(cwd, fresh);
    const preparing = writeTask(cwd, task.id, {
      status: 'queued',
      pid: null,
      resumeOwner: process.pid,
      dispatchId: randomUUID(),
      resumedAt: new Date().toISOString(),
      currentPrompt: text,
      resumeThreadId: fresh.threadId,
      steerClosed: false,
      steerEndpoint: null,
      error: undefined,
    });
    return { fresh, claim, preparing };
  });
  if (!admission) return 'queued';
  const { fresh, claim, preparing } = admission;
  task = fresh ?? task;
  try {
    for (const name of fs.readdirSync(resolveTaskDir(cwd, task.id)))
      if (/^resume-\d+-\d+$/.test(name) && name !== path.basename(claim))
        fs.rmSync(path.join(resolveTaskDir(cwd, task.id), name), { recursive: true, force: true });
    const agent = task.agentId
      ? await (await import('../../agent/exec')).localAgentPrompt(cwd, task.agentId)
      : undefined;
    const access = strictestAccess(opts.access, task.access);
    const connected = opts.resolveConnections
      ? await opts.resolveConnections(task.connections ?? [])
      : await localConnections(
          undefined,
          task.connections ?? [],
          undefined,
          strictestAccess(agent?.access, access),
        );
    const { selected, bindings } = turnServers(task, connected.mcp);
    if (task.archived) unarchiveTask(cwd, task);
    await withTaskAdmission(cwd, task.id, () => {
      const current = loadTask(cwd, task.id);
      if (
        current?.status !== 'queued' ||
        current.dispatchId !== preparing.dispatchId ||
        current.resumeOwner !== process.pid
      )
        throw new Error('Task changed while preparing its resumed turn');
      writeTask(cwd, task.id, {
        // The agent's instructions as they are now; the notes stay this task's.
        ...(agent?.developer && task.promptParts
          ? {
              promptParts: {
                ...task.promptParts,
                developer: { ...agent.developer, notes: task.promptParts.developer?.notes },
              },
            }
          : {}),
        mcp: selected.mcp,
        mcpBindings: bindings,
        status: 'queued',
        pid: null,
        steerClosed: false,
        resumeOwner: undefined,
        currentPrompt: text,
        ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
        resumeThreadId: task.threadId,
        steerEndpoint: null,
        model,
        effort,
        access,
        error: undefined,
      });
      appendTaskLog(cwd, task.id, {
        kind: 'steer',
        message: `Resuming with steer:\n${text}`,
      });
      for (const warning of [...connected.warnings, ...(selected.warnings ?? [])])
        appendTaskLog(cwd, task.id, { kind: 'status', message: warning });
      const worker = spawnWorker(task.cwd ?? cwd, task.id, {
        ...Object.fromEntries(
          Object.keys(process.env)
            .filter(name => name.startsWith('CODER_CONNECTION_'))
            .map(name => [name, undefined]),
        ),
        ...connected.env,
        ...opts.credentialEnv,
      });
      opts.onWorker?.(worker);
    });
  } catch (error) {
    const current = loadTask(cwd, task.id);
    if (
      current &&
      current.dispatchId === preparing.dispatchId &&
      ACTIVE_STATUSES.includes(current.status)
    )
      writeTask(cwd, task.id, {
        status: 'failed',
        resumeOwner: undefined,
        steerClosed: true,
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      });
    fs.rmSync(path.join(resolveTaskDir(cwd, task.id), path.basename(claim)), {
      recursive: true,
      force: true,
    });
    throw error;
  }

  return 'resumed';
}

/** A follow-up's model spec, resolved on the task's own engine; none keeps the task's model and effort. */
function turnModel(
  cwd: string,
  task: Task,
  spec?: string,
): { model: string | null; effort: Effort | null } {
  if (!spec) return { model: task.model ?? null, effort: task.effort ?? null };
  // A model that names no engine takes the task's, not the default model's.
  const parts = splitEngineSpec(spec);
  const { engine, model, effort } = resolveTaskOptions(
    { ...(parts.model ? {} : { engine: task.engine }), model: spec },
    loadConfig(cwd),
  );
  if (engine !== task.engine)
    throw new CoderError(
      'invalid-option',
      `Task ${task.id} runs on ${task.engine}, so its follow-ups take a ${task.engine} model.`,
    );

  return { model, effort };
}

const CLAUDE_SIDECAR_INSPECTION_TOOLS = ['Read', 'Glob', 'Grep'];

export function claudeAskOptions(
  task: Task,
  taskDir: string,
  prompt: string,
  opts: { model?: string; effort: Effort | null },
): ClaudeTurnOptions {
  return {
    prompt,
    model: opts.model ?? task.model,
    effort: opts.effort,
    access: 'read-only',
    // Global task state lives outside the task workspace. Grant this sidecar
    // exactly its own task directory so it can read the progress artifacts.
    additionalDirectories: [taskDir],
    taskRoot: taskDir,
    // Machine sandboxes also grant Bash; OS-sandboxed asks use only these inspection tools.
    readOnlyAllowedTools: CLAUDE_SIDECAR_INSPECTION_TOOLS,
  };
}

// Print-free core (SDK `task.ask`).
export async function askTask(
  cwd: string,
  task: Task,
  question: string,
  opts: { model?: string; command?: MailboxKey } = {},
): Promise<TurnResult> {
  const { model: name, effort } = turnModel(cwd, task, opts.model);
  const taskDir = resolveTaskDir(cwd, task.id);
  const prompt = askPrompt(
    task,
    {
      log: path.join(taskDir, 'log.jsonl'),
      result: path.join(taskDir, 'result.json'),
      worker: path.join(taskDir, 'worker.log'),
    },
    question,
    opts.command ? mailboxId(opts.command) : undefined,
  );
  const onResult = opts.command
    ? (result: TurnResult) => {
        const dir = path.join(taskDir, 'inbox-control');
        fs.mkdirSync(dir, { recursive: true });
        fs.appendFileSync(
          path.join(dir, `${mailboxId(opts.command)}.transcript.jsonl`),
          JSON.stringify({
            command: opts.command,
            result: result.finalMessage ?? result.error?.message ?? '',
          }) + '\n',
        );
      }
    : undefined;
  if (task.engine === 'claude') {
    return runClaudeTurn(task.cwd ?? cwd, {
      ...claudeAskOptions(task, taskDir, prompt, { model: name ?? undefined, effort }),
      command: opts.command,
      onResult,
    });
  }
  const config = loadConfig(cwd);
  const entry = name ? config.models?.[name] : undefined;
  return runTurn(task.cwd ?? cwd, {
    prompt,
    model: resolveCodexModel(name ?? null),
    ...(entry && name && isEndpointModel(entry) ? { customModel: { alias: name, entry } } : {}),
    effort,
    sandbox: 'read-only',
    approvalPolicy: 'never',
    ephemeral: true,
    onResult,
  });
}

/** Approvals across every active task (or every task), picked from each task's by `pick`. */
export function collectApprovals(
  cwd: string,
  pick: (taskDir: string) => Approval[],
  tasks: 'active' | 'all' = 'active',
): Array<Approval & { taskId: string }> {
  return listTasks(cwd)
    .filter(task => tasks === 'all' || ACTIVE_STATUSES.includes(task.status))
    .flatMap(task =>
      pick(resolveTaskDir(cwd, task.id)).map(approval => ({ ...approval, taskId: task.id })),
    );
}

/** Answer a task's approval and tell the task: a steer, which resumes it if its turn ended.
 * The answer is recorded first and marked delivered last; a retry with the same decision only delivers, never records twice. */
export async function answerTaskApproval(
  cwd: string,
  task: Task,
  approvalId: string,
  decision: 'accept' | 'decline',
  opts: {
    reason?: string;
    /** Who answered, as the task's conversation shows it. */
    by?: string;
    command?: MailboxKey;
    resolveConnections?: ConnectionResolver;
    /** Runs a finished task's next turn instead of resuming it here; false when it is active again. */
    resume?: (text: string) => Promise<boolean>;
  } = {},
): Promise<Approval> {
  const taskDir = resolveTaskDir(cwd, task.id);
  const requested = listApprovals(taskDir).find(entry => entry.id === approvalId);
  // The same decision again while undelivered (a failed steer, an inbox replay, an answer restored with the task) finishes delivering it.
  const recorded =
    requested?.response?.decision === decision && !requested.response.deliveredAt
      ? requested
      : null;
  const approval = recorded ?? answerApproval(taskDir, approvalId, decision, opts.reason, opts.by);
  if (!recorded)
    appendTaskLog(cwd, task.id, {
      kind: 'approval-answered',
      approvalId,
      decision,
      summary: approval.actions.join('\n'),
      ...(opts.reason ? { reason: opts.reason } : {}),
      ...(approval.response?.by ? { by: approval.response.by } : {}),
      message: approvalMessage(approval),
    } as TaskLogEntry);
  await deliverAnswer(cwd, task, approval, opts);

  return markDelivered(taskDir, approval);
}

/** Tells the task its decision once: the steer is keyed by the answer, so a retry after a crash never steers twice. */
async function deliverAnswer(
  cwd: string,
  task: Task,
  approval: Approval,
  opts: {
    command?: MailboxKey;
    resolveConnections?: ConnectionResolver;
    resume?: (text: string) => Promise<boolean>;
  },
): Promise<void> {
  const text = approvalMessage(approval);
  const key = `${approval.id}:${approval.response!.answeredAt}`;
  const command = opts.command ?? namedCommand(task.id, key);
  const current = loadTask(cwd, task.id) ?? task;
  // A resumed turn already carries the decision as its prompt.
  if (
    (current.currentPrompt ?? current.prompt) === text &&
    ACTIVE_STATUSES.includes(current.status)
  )
    return;
  // A task that has not opened its conversation yet gets the answer as its next turn.
  const queued = await withTaskAdmission(cwd, task.id, () => {
    const fresh = loadTask(cwd, task.id) ?? current;
    if (steerKnown(cwd, task.id, key)) return true;
    if (fresh.steerClosed || !ACTIVE_STATUSES.includes(fresh.status)) return false;
    if (fresh.threadId) return false;
    queueSteer(cwd, task.id, text, key);
    return true;
  });
  const finished = !ACTIVE_STATUSES.includes((loadTask(cwd, task.id) ?? current).status);
  if (!queued && !(finished && (await opts.resume?.(text))))
    await steerTask(cwd, current, text, {
      command,
      ...(opts.resolveConnections ? { resolveConnections: opts.resolveConnections } : {}),
    });
}

/** Filters for the task list, mirroring the CLI flags. */
export interface ListOptions {
  running?: boolean;
  stopped?: boolean;
  archived?: boolean;
  /** Narrow to a workspace (matched by git root). */
  dir?: string;
  /** Max rows; 'all' or undefined means no limit. */
  limit?: number | 'all';
}

// Archive stopped tasks before collecting the recent view.
export function recentTasks(cwd: string): Task[] {
  const tasks = listTasks(cwd).filter(task => {
    if (!TERMINAL_STATUSES.includes(task.status)) return true;
    if (!archiveDue(Date.parse(task.completedAt ?? task.updatedAt ?? task.createdAt ?? '')))
      return true;
    archiveTask(cwd, task, { auto: true });
    return false;
  });

  return tasks;
}

// Print-free core: gather the tasks the CLI (and SDK) list, applying the
// auto-archive sweep, the status/workspace filters, the default-view sort, and
// the limit. Returns the resolved tasks plus how many were clipped by --limit.
export function collectTasks(
  cwd: string,
  options: ListOptions = {},
): { tasks: Task[]; clipped: number } {
  // --limit all matches the default (everything).
  const limit = options.limit === 'all' ? undefined : options.limit;

  const isStopped = (task: Task) => TERMINAL_STATUSES.includes(task.status);

  // A queue row that is a newer execution stands in for its CLI job in every view.
  const server = queueOwnedTasks(cwd);
  const owned = new Set(server.map(task => task.id));
  const jobs = (list: Task[]) => list.filter(task => !owned.has(task.id));
  let tasks = [...jobs(recentTasks(cwd)), ...server.filter(task => !task.archived)];
  if (options.archived) {
    tasks = [...jobs(listArchivedTasks(cwd)), ...server.filter(task => task.archived)];
  } else if (options.running) {
    tasks = tasks.filter(task => ACTIVE_STATUSES.includes(task.status));
  } else if (options.stopped) {
    tasks = tasks.filter(isStopped);
  }
  // Tasks are stored globally; an explicit dir narrows to tasks launched in that
  // workspace (matched by git root).
  if (options.dir) {
    const wanted = resolveWorkspaceRoot(path.resolve(String(options.dir)));
    const roots = new Map<string, string>();
    tasks = tasks.filter(task => {
      if (!task.cwd) return false;
      if (!roots.has(task.cwd)) roots.set(task.cwd, resolveWorkspaceRoot(task.cwd));
      return roots.get(task.cwd) === wanted;
    });
  }

  // Every view surfaces what needs attention: failed tasks first, then running,
  // with completed last, so --limit trims completed tasks first.
  const key = (task: Task) => ({
    rank: listRank(task.status),
    createdAt: Date.parse(task.createdAt ?? '') || 0,
    id: task.id,
  });
  tasks = [...tasks].sort((a, b) => byListKey(key(a), key(b)));
  const clipped = limit !== undefined ? Math.max(0, tasks.length - limit) : 0;
  if (limit !== undefined) {
    tasks = tasks.slice(0, limit);
  }
  return { tasks, clipped };
}

// Print-free core (SDK `task.stream`): follow a task's progress log, yielding
// each TaskLogEntry until the task reaches a terminal state. `tail` replays only
// the last n steps already logged ('all' for the whole transcript; default 1,
// so just the step in progress).
export async function* streamTask(
  cwd: string,
  taskId: string,
  opts: { tail?: number | 'all' } = {},
): AsyncGenerator<TaskLogEntry> {
  const changes = watchTask(cwd, taskId);
  try {
    const startMs = processStarts();
    let current = loadTask(cwd, taskId);
    if (!current) {
      throw new Error(`No task found for "${taskId}".`);
    }
    // Skip everything older than the last `tail` steps, then follow the file
    // incrementally. Each tick reads only appended bytes instead of
    // re-parsing the whole (unbounded) log.
    const tail = opts.tail ?? 1;
    const tailLines = createJsonlTail(path.join(resolveTaskDir(cwd, taskId), 'log.jsonl'));
    let first = true;
    const drain = (): TaskLogEntry[] => {
      const entries = tailLines().map((line): TaskLogEntry => {
        try {
          return JSON.parse(line) as TaskLogEntry;
        } catch {
          return { message: line };
        }
      });
      if (!first) return entries;
      first = false;
      return tail === 'all' ? entries : tailSteps(entries, tail);
    };
    yield* drain();
    for (;;) {
      current = reconcileTask(cwd, loadTask(cwd, taskId) ?? current, startMs);
      if (TERMINAL_STATUSES.includes(current.status)) break;
      await changes.wait(1000);
      yield* drain();
    }
    yield* drain();
  } finally {
    changes.close();
  }
}

// Print-free core: interrupt the live turn (if any), kill the worker, mark the
// task cancelled and close its open approvals. Returns the interrupt detail for the caller to report.
export async function stopTask(
  cwd: string,
  task: Task,
  adapters: { interrupt?: typeof interruptTurn } = {},
): Promise<{ taskId: string; status: 'cancelled'; interrupt: string }> {
  // Claude tasks have no app-server turn to interrupt; killing the worker
  // takes the claude child down with it (SIGTERM handler in claude-core).
  const interrupt =
    task.engine === 'claude'
      ? { detail: 'claude worker terminated' }
      : await (adapters.interrupt ?? interruptTurn)(cwd, {
          endpoint: task.steerEndpoint,
          threadId: task.threadId,
          turnId: task.turnId,
        });
  if (task.engine !== 'claude') {
    removeCodexControlEndpoint(task.steerEndpoint);
  }
  if (task.pid && task.status === 'running') {
    try {
      process.kill(task.pid, 'SIGTERM');
    } catch {
      // Worker already exited.
    }
  }
  writeTask(cwd, task.id, {
    status: 'cancelled',
    error: STOPPED_BY_USER,
    steerEndpoint: null,
    completedAt: new Date().toISOString(),
  });
  closeApprovals(resolveTaskDir(cwd, task.id));
  return { taskId: task.id, status: 'cancelled', interrupt: interrupt.detail };
}

/** Delete a task: the engine session behind it (best-effort, so it leaves codex and claude too), then its state dir. */
export function deleteTask(cwd: string, task: Task): boolean {
  for (const threadId of conversationIds(task)) {
    if (task.engine !== 'claude') void deleteCodexSession(cwd, threadId);
    else deleteClaudeSession(threadId);
  }
  return removeTaskDir(cwd, task.id);
}

/** A local conversation's Coder server: the task on this machine's server, by its attempt token, so its task commands start and reach its children; nothing else in a worker has the token. */
function parentServer(): RemoteClient | undefined {
  const { CODER_SERVER: server, CODER_TASK_TOKEN: token } = process.env;
  if (!process.env[WORKER_ENV] || process.env.CODER_MCP_MODE === 'cloud' || !server || !token)
    return undefined;

  return isLoopbackServer(server) ? coderClient(server, { token }) : undefined;
}
function target(opts: TaskOptions): { cwd: string; api?: RemoteClient } {
  const api = opts.server !== undefined ? connect(opts) : parentServer();

  return {
    cwd: opts.cwd ? path.resolve(opts.cwd) : process.cwd(),
    ...(api ? { api } : {}),
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
/** Dispatch a task; with `wait`, block until it finishes. */
export async function run(
  prompt: string,
  opts: TaskRunOptions & TaskOptions = {},
): Promise<RunResult> {
  if (
    opts.outputSchema !== undefined &&
    (!opts.outputSchema ||
      typeof opts.outputSchema !== 'object' ||
      Array.isArray(opts.outputSchema))
  )
    throw new CoderError('invalid-option', 'outputSchema must be an object.');
  const { cwd, api } = target(opts);
  const parent = opts.server === undefined;
  if (api) {
    const created = await api.tasks.create({
      source: 'cli',
      prompt,
      ...(opts.cwd && !parent ? { cwd: opts.cwd } : {}),
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      ...(opts.repo ? { repo: opts.repo } : {}),
      ...(opts.agent ? { agent: opts.agent } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.access ? { access: opts.access } : {}),
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
      ).agentTaskOptions(cwd, opts.agent, opts.mcp, undefined, opts.connections, opts.access)
    : undefined;
  const connected =
    agent?.connected ??
    (await localConnections(opts.connections, undefined, undefined, opts.access));
  for (const warning of connected.warnings) opts.onNote?.(warning);
  const config = loadConfig(cwd);
  const selectedMcp = agent ?? selectMcpServers(opts.mcp, config.mcp, {}, connected.mcp);
  const dispatchOpts: DispatchOptions = {
    prompt,
    outputSchema: opts.outputSchema,
    cwd,
    engine: opts.model ? undefined : agent?.engine,
    model: opts.model ?? agent?.model,
    effort: opts.model ? undefined : agent?.effort,
    access: agent?.access ?? opts.access,
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
  const models = modelList(config, resolveTaskOptions(dispatchOpts, config));
  let dispatch = await dispatchTask(dispatchOpts, { config, models });

  if (!opts.wait) {
    const taskId = dispatch.taskId;
    return {
      taskId,
      status: dispatch.task.status,
      startupCheck: dispatch.startupCheck,
      commands: taskCommands(taskId, opts),
    };
  }

  // A turn that ends with a startup-ish error (usage, auth, quota) falls back like a failed start.
  for (;;) {
    const taskId = dispatch.taskId;
    opts.onWaiting?.(taskId);
    const waited = await waitTask(cwd, taskId);
    const { task: final, result } = waited;
    const turnError = result?.error?.message ?? '';
    if (final.status === 'failed' && isSandboxFailure(final.access ?? 'auto', turnError))
      throw new CoderError('read-only-unavailable', turnError);
    const next = turnFallbackModel(cwd, waited, models);
    if (next !== undefined) {
      if (next === null)
        throw new CoderError('chain-exhausted', turnError, {
          payload: buildFallbackPayload(
            dispatch.engine,
            turnError,
            final.access ?? 'auto',
            opts.appendSystem,
            prompt,
          ),
        });
      opts.onFallback?.({
        model: formatEngineSpec(final),
        detail: turnError,
        next: formatEngineSpec(next),
      });
      dispatch = await dispatchTask(
        { ...dispatchOpts, name: undefined },
        { config, models: models.slice(models.indexOf(next)) },
      );
      continue;
    }
    return finished(final, result);
  }
}
/** A task's status and answer; `wait` blocks until it finishes or needs an approval. Omit the id for the latest task. */
export async function result(
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
/** A list row; idle is the time since the engine last emitted anything (log, heartbeat, or task update). */
function taskRow(
  task: Task,
  pendingApprovals: number,
  lastActivity?: string | null,
  title = promptTitle(task.prompt),
): TaskRow {
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
    prompt: String(title ?? '')
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
export async function list(
  opts: TaskOptions & ListOptions & { cursor?: string } = {},
): Promise<TaskPage> {
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
              promptTitle(row.turns?.[0]?.prompt ?? row.task.prompt, row.task.event),
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
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}
async function* each<T>(items: T[] | Promise<T[]>): AsyncGenerator<T> {
  yield* await items;
}
/** Follow a task live. `tail` replays only the last n steps (default 1); `from` lists the log from that event on, without following. Omit the id for the latest task. */
export async function watch(
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
/** Steer a follow-up into a task (live, queued, or resumed on its thread); `wait` blocks on a live or resumed one. */
export async function steer(
  id: string,
  text: string,
  opts: TaskOptions & {
    model?: string;
    access?: Access;
    wait?: boolean;
  } = {},
): Promise<SteerResult> {
  const { cwd, api } = target(opts);
  if (api) {
    const answer = (await api.tasks.steer(id, text, {
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.access ? { access: opts.access } : {}),
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
    access: opts.access,
  });
  if (!opts.wait || outcome.steered === 'queued') return outcome;
  const current = loadTask(cwd, outcome.taskId);
  const final = current ? (await waitTask(cwd, current.id)).task : null;
  const done = readJsonFile<any>(path.join(resolveTaskDir(cwd, outcome.taskId), 'result.json'));
  return { ...outcome, status: final?.status ?? null, finalMessage: done?.finalMessage ?? null };
}
/** A server task's sidecar answer: a local server's comes with the request, a runner's lands in the task's answers. */
async function askServer(
  api: RemoteClient,
  id: string,
  question: string,
  model?: string,
): Promise<AskResult> {
  const before = (await api.tasks.get(id)).answer?.length ?? 0;
  const abort = new AbortController();
  let response = await api.tasks.events([id], undefined, abort.signal);
  try {
    let answer = (
      (await api.tasks.ask(id, question, model ? { model } : {})) as { answer?: unknown }
    ).answer;
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
      if (answer === undefined && !ended) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        response = await api.tasks.events([id], last, abort.signal);
      }
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
export async function ask(
  id: string,
  question: string,
  opts: TaskOptions & { model?: string; onAsking?: (taskId: string) => void } = {},
): Promise<AskResult> {
  const { cwd, api } = target(opts);
  if (api) {
    opts.onAsking?.(id);
    return askServer(api, id, question, opts.model);
  }
  const task = localTask(cwd, id);
  opts.onAsking?.(task.id);
  const result = await askTask(cwd, task, question, { model: opts.model });
  return {
    taskId: task.id,
    answer: result.finalMessage || null,
    ...(result.error ? { error: result.error.message } : {}),
    ok: result.status === 0,
  };
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
export async function approvals(
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
export async function approve(
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
export async function stop(id?: string, opts: TaskOptions = {}) {
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
export async function archive(id?: string, opts: TaskOptions & { allStopped?: boolean } = {}) {
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
export async function remove(id?: string, opts: TaskOptions & { allArchived?: boolean } = {}) {
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
export async function* stream(id?: string, opts: TaskOptions & { tail?: number | 'all' } = {}) {
  yield* (await watch(id, opts)).events;
}
