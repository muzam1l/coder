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
} from '../state';
import { steerTurn, runTurn, interruptTurn } from '../engines/codex';
import { steerClaudeTurn, runClaudeTurn, type ClaudeTurnOptions } from '../engines/claude';
import {
  ACTIVE_STATUSES,
  type McpServerSpec,
  type Task,
  type Effort,
  type TurnResult,
  TERMINAL_STATUSES,
} from '../types';
import { byListKey, listRank } from '../defaults';
import { CoderError, resolveMcpServers, selectMcpServers, spawnWorker } from '../dispatch';
import { connectionEnvironment, localConnections } from '../connections';
import { isEndpointModel, loadConfig, resolveCodexModel, resolveCustomModel } from '../config';
import { startChatBridge } from '../engines/codex/chat-bridge';
import { listPendingApprovals } from '../approvals';
import { createJsonlTail } from '../../utils/fsx';
import { removeCodexControlEndpoint } from '../engines/codex/control';
import { mailboxId, type MailboxKey } from '../mailbox';
import { deleteCodexSession } from '../engines/codex/sessions';
import { deleteClaudeSession } from '../engines/claude/sessions';
import { conversationIds } from '../engines/history';
import { askPrompt } from './context/prompts';

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

function queueSteer(cwd: string, id: string, text: string): void {
  enqueueSteer(cwd, id, text);
  appendTaskLog(cwd, id, { kind: 'steer', message: `Steer queued for the next turn:\n${text}` });
}

// Print-free core (SDK `task.steer`).
export async function steerTask(
  cwd: string,
  task: Task,
  text: string,
  opts: {
    model?: string;
    effort?: string;
    permissions?: string;
    outputSchema?: object;
    command?: MailboxKey;
    onWorker?: (worker: ChildProcess) => void;
    resolveConnections?: ConnectionResolver;
  } = {},
  adapters: {
    codex?: typeof steerTurn;
    claude?: typeof steerClaudeTurn;
  } = {},
): Promise<{ taskId: string; steered: SteerOutcome }> {
  const current = loadTask(cwd, task.id) ?? task;
  task = current.rollingOver ? reconcileTask(cwd, current) : current;
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
  // One resume per finished turn: a steer racing it, or reaching it before it runs, waits for the next turn.
  const admission = await withTaskAdmission(cwd, task.id, () => {
    const fresh = loadTask(cwd, task.id) ?? task;
    const turn = [fresh?.completedAt, fresh?.resumedAt].map(at => Date.parse(at ?? '') || 0);
    const claim = path.join(resolveTaskDir(cwd, task.id), `resume-${turn.join('-')}`);
    const owning =
      fresh &&
      !fresh.steerClosed &&
      (ACTIVE_STATUSES.includes(fresh.status) ||
        (fresh.rollingOver && reconcileTask(cwd, fresh).rollingOver) ||
        (fresh.status === 'completed' && fresh.steerClosed === false && isPidAlive(fresh.pid)));
    if (owning || !claimResume(claim)) {
      if (fresh.archived) unarchiveTask(cwd, fresh);
      queueSteer(cwd, task.id, text);
      return undefined;
    }
    return { fresh, claim };
  });
  if (!admission) return 'queued';
  const { fresh, claim } = admission;
  task = fresh ?? task;
  let published = false;
  try {
    for (const name of fs.readdirSync(resolveTaskDir(cwd, task.id)))
      if (/^resume-\d+-\d+$/.test(name) && name !== path.basename(claim))
        fs.rmSync(path.join(resolveTaskDir(cwd, task.id), name), { recursive: true, force: true });
    const agent = task.agentId
      ? await (await import('../../agent/exec')).localAgentPrompt(cwd, task.agentId)
      : undefined;
    const connected = opts.resolveConnections
      ? await opts.resolveConnections(task.connections ?? [])
      : await localConnections(undefined, task.connections ?? [], undefined, agent?.access);
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
      connected.mcp,
    );
    if (task.archived) unarchiveTask(cwd, task);
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
      resumedAt: new Date().toISOString(),
      currentPrompt: text,
      ...(opts.outputSchema ? { outputSchema: opts.outputSchema } : {}),
      resumeThreadId: task.threadId,
      steerEndpoint: null,
      model: (opts.model ?? task.model ?? null) as Task['model'],
      effort: (opts.effort ?? task.effort ?? null) as Task['effort'],
      permissions: (opts.permissions ?? task.permissions) as Task['permissions'],
      error: undefined,
    });
    published = true;
    appendTaskLog(cwd, task.id, {
      kind: 'steer',
      message: `Resuming with steer:\n${text}`,
    });
    for (const warning of [...connected.warnings, ...(selected.warnings ?? [])])
      appendTaskLog(cwd, task.id, { kind: 'status', message: warning });
    const worker = spawnWorker(task.cwd ?? cwd, task.id, connected.env);
    opts.onWorker?.(worker);
  } catch (error) {
    if (published)
      writeTask(cwd, task.id, {
        status: fresh?.status ?? task.status,
        resumedAt: fresh?.resumedAt,
        currentPrompt: fresh?.currentPrompt ?? null,
        resumeThreadId: fresh?.resumeThreadId ?? null,
        error: fresh?.error,
      });
    fs.rmSync(path.join(resolveTaskDir(cwd, task.id), path.basename(claim)), {
      recursive: true,
      force: true,
    });
    throw error;
  }

  return 'resumed';
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
    permissions: 'read-only',
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
  opts: { model?: string; effort?: string; command?: MailboxKey } = {},
): Promise<TurnResult> {
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
  const effort = (opts.effort ?? task.effort ?? null) as Effort | null;
  if (task.engine === 'claude') {
    return runClaudeTurn(task.cwd ?? cwd, {
      ...claudeAskOptions(task, taskDir, prompt, { model: opts.model, effort }),
      command: opts.command,
      onResult,
    });
  }
  const config = loadConfig(cwd);
  const name = opts.model ?? task.model;
  const entry = name ? config.models?.[name] : undefined;
  const customEntry = entry && isEndpointModel(entry) ? entry : undefined;
  if (customEntry?.envKey && !process.env[customEntry.envKey]) {
    throw new Error(`Missing environment variable: \`${customEntry.envKey}\`.`);
  }
  const bridge = customEntry
    ? await startChatBridge(customEntry, customEntry.wireApi ?? 'chat')
    : null;
  const custom = resolveCustomModel(config, name, bridge ?? undefined);
  try {
    return await runTurn(task.cwd ?? cwd, {
      prompt,
      model: custom?.model ?? resolveCodexModel(name ?? null),
      modelProvider: custom?.modelProvider ?? null,
      configOverrides: custom?.configOverrides ?? null,
      effort,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ephemeral: true,
      onResult,
    });
  } finally {
    await bridge?.close();
  }
}

export interface PendingRow {
  taskId: string;
  id: string;
  summary: string;
  createdAt?: string;
}

// Unanswered approvals across every active task.
export function collectPending(cwd: string): PendingRow[] {
  return listTasks(cwd)
    .filter(task => ACTIVE_STATUSES.includes(task.status))
    .flatMap(task =>
      listPendingApprovals(resolveTaskDir(cwd, task.id))
        .filter(a => !a.response)
        .map(a => ({
          taskId: task.id,
          id: a.id,
          summary: String(a.summary ?? ''),
          createdAt: a.createdAt ? String(a.createdAt) : undefined,
        })),
    );
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
// task cancelled. Returns the interrupt detail for the caller to report.
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
    error: 'Stopped by user.',
    steerEndpoint: null,
    completedAt: new Date().toISOString(),
  });
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
