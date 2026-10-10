/** What a task can be asked to do on this machine: steer it, ask it, answer its approvals, list and stream it, stop, archive and delete it. */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

import {
  appendTaskLog,
  enqueueSteer,
  loadTask,
  unarchiveTask,
  writeTask,
  resolveTaskDir,
  listTasks,
  archiveDue,
  listArchivedTasks,
  markTaskArchived,
  queueOwnedTasks,
  resolveWorkspaceRoot,
  reconcileTask,
  tailSteps,
  type TaskLogEntry,
  archiveTask,
  findTask,
  removeTaskDir,
} from '../state';
import { steerTurn, runTurn, interruptTurn } from '../engines/codex';
import { steerClaudeTurn, runClaudeTurn, type ClaudeTurnOptions } from '../engines/claude';
import {
  ACTIVE_STATUSES,
  type Task,
  type Effort,
  type TurnResult,
  TERMINAL_STATUSES,
} from '../types';
import { byListKey, listRank } from '../defaults';
import { CoderError, spawnWorker } from '../dispatch';
import { isEndpointModel, loadConfig, resolveCodexModel, resolveCustomModel } from '../config';
import { startChatBridge } from '../engines/codex/chat-bridge';
import { listPendingApprovals } from '../approvals';
import { createJsonlTail } from '../../utils/fsx';
import { removeCodexControlEndpoint } from '../engines/codex/control';
import { mailboxId, type MailboxKey } from '../mailbox';
import { CLI_PATH } from '../runtime';
import { deleteCodexSession } from '../engines/codex/sessions';
import { deleteClaudeSession } from '../engines/claude/sessions';

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
      message: `Steer accepted live:\n${text}`,
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
  // Not injectable live during a genuine startup/completion race. Re-read: if the turn just
  // finished, fall back to the resume path; otherwise queue the follow-up
  // for the worker to run when the current turn ends.
  const fresh = loadTask(cwd, task.id) ?? task;
  if (ACTIVE_STATUSES.includes(fresh.status)) {
    enqueueSteer(cwd, fresh.id, text);
    appendTaskLog(cwd, fresh.id, {
      kind: 'steer',
      message: `Steer queued for the next turn:\n${text}`,
    });
    return { taskId: fresh.id, steered: 'queued' };
  }
  return null;
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
  } = {},
  adapters: {
    codex?: typeof steerTurn;
    claude?: typeof steerClaudeTurn;
  } = {},
): Promise<{ taskId: string; steered: SteerOutcome }> {
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
  resumeInPlace(cwd, task, text, opts);
  return { taskId: task.id, steered: 'resumed' };
}

// A stopped task resumes on the SAME task record (never a stray new task id),
// in the task's own cwd: claude finds session transcripts per project dir.
function resumeInPlace(
  cwd: string,
  task: Task,
  text: string,
  opts: { model?: string; effort?: string; permissions?: string; outputSchema?: object },
): void {
  if (task.archived) unarchiveTask(cwd, task);
  writeTask(cwd, task.id, {
    status: 'queued',
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
  appendTaskLog(cwd, task.id, {
    kind: 'steer',
    message: `Resuming with steer:\n${text}`,
  });
  spawnWorker(task.cwd ?? cwd, task.id);
}

const CLAUDE_SIDECAR_INSPECTION_TOOLS = ['Read', 'Glob', 'Grep'];

// Read-only sidecar: answers ABOUT a task from its on-disk state, never
// touching its thread or creating a task record.
export function sidecarPrompt(task: Task, taskDir: string, question: string): string {
  const meta = [
    `id: ${task.id}`,
    ...(task.name ? [`name: ${task.name}`] : []),
    `status: ${task.status}`,
    `engine: ${task.engine}${task.model ? `/${task.model}` : ''}${task.effort ? `/${task.effort}` : ''}`,
    ...(task.cwd ? [`workspace: ${task.cwd}`] : []),
    ...(task.createdAt ? [`created: ${task.createdAt}`] : []),
    ...(task.completedAt ? [`finished: ${task.completedAt}`] : []),
  ].join('\n');
  return `You are a read-only sidecar answering a question ABOUT a coder task.
You are not the task. Never continue, redo, or fix its work. Only answer the question. The task never sees this question or your answer.

Task metadata:
${meta}

Task prompt:
${task.prompt ?? '(unknown)'}

Inspect as needed (grep/read selectively; events can be large):
- progress log (jsonl, one event per line): ${path.join(taskDir, 'log.jsonl')}
- final result: ${path.join(taskDir, 'result.json')}
- worker output: ${path.join(taskDir, 'worker.log')}
${task.cwd ? `- the task's workspace (its code and changes): ${task.cwd}` : ''}

Question: ${question}

Answer the question directly and concisely.`;
}

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
    // Native inspection tools only; everything else (Bash, network, subagents)
    // is denied by CLAUDE_SIDECAR_FLAGS, since --allowedTools only ever grants.
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
  const prompt =
    sidecarPrompt(task, taskDir, question) +
    (opts.command ? `\n\nCoder command ${mailboxId(opts.command)}` : '');
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

// Active tasks after the auto-archive sweep; the swept tasks' dir moves run detached.
export function recentTasks(cwd: string): Task[] {
  const toArchive: string[] = [];
  const tasks = listTasks(cwd).filter(task => {
    if (!TERMINAL_STATUSES.includes(task.status)) return true;
    if (!archiveDue(Date.parse(task.completedAt ?? task.updatedAt ?? task.createdAt ?? '')))
      return true;
    markTaskArchived(cwd, task, { auto: true });
    toArchive.push(task.id);
    return false;
  });
  spawnArchiveSweep(cwd, toArchive);

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
  const terminal = new Set(['completed', 'failed', 'cancelled']);
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
  while (!terminal.has(current.status)) {
    await new Promise(resolve => setTimeout(resolve, 400));
    current = reconcileTask(cwd, loadTask(cwd, taskId) ?? current);
    yield* drain();
  }
  yield* drain();
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
    steerEndpoint: null,
    completedAt: new Date().toISOString(),
  });
  return { taskId: task.id, status: 'cancelled', interrupt: interrupt.detail };
}

// Finish archiving flagged tasks, including the directory move and Codex session.
// Archive flow runs in a detached child so a `list` sweep never blocks on the
// fs moves. Best-effort: if it never runs, the migration in listTasks/
// listArchivedTasks (listRuns/listArchivedRuns) completes the move later.
export function spawnArchiveSweep(cwd: string, ids: string[], opts: { flows?: boolean } = {}) {
  if (!ids.length) return;
  try {
    const child = spawn(
      process.execPath,
      [CLI_PATH, 'task', 'archive-sweep', '--cwd', cwd, ...(opts.flows ? ['--flows'] : []), ...ids],
      {
        detached: true,
        stdio: 'ignore',
      },
    );
    child.unref();
  } catch {
    /* best-effort */
  }
}

/** Delete a task: the engine session behind it (best-effort, so it leaves codex and claude too), then its state dir. */
export function deleteTask(cwd: string, task: Task): boolean {
  if (task.threadId) {
    if (task.engine !== 'claude') void deleteCodexSession(cwd, task.threadId);
    else deleteClaudeSession(task.threadId);
  }
  return removeTaskDir(cwd, task.id);
}

/** The detached half of an archive sweep: archive each flagged task that is still stopped. */
export function archiveFlagged(cwd: string, ids: string[]): void {
  for (const id of ids) {
    const task = findTask(cwd, id);
    // Skip a task steered back to life since the list flagged it.
    if (task && TERMINAL_STATUSES.includes(task.status)) archiveTask(cwd, task, { auto: true });
  }
}
