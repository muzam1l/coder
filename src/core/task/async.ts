/** Async task tools: a flow run in a detached driver whose result, error, timeout or stop comes back to the task as a steer. */
import path from 'node:path';
import process from 'node:process';

import { WORKER_ENV } from '../dispatch';
import { tokenEnvName } from '../../agent/mcp';
import { loadTask, readTurnResults, resolveTaskDir } from '../state';
import { heldConnections, steerTask } from './actions';
import type { Task } from '../types';
import { readJsonFile, withFileLock, writeJsonFileAtomic } from '../../utils/fsx';
import { drivePreparedRun, pidAlive, prepareRun, stopFlowTasks } from '../../flow/executor';
import { detachRun, readFlowRecord, readRawRecord } from '../../flow/runs';
import type { FlowHooks } from '../../flow/runtime';
import type { ReviewLinks } from './review';

/** A tool that runs a flow and answers later: one call at a time, `limit` per turn. */
export interface AsyncTool<I = any> {
  name: string;
  flow: string;
  limit: number;
  /** Integration whose tool server token the flow posts with. */
  platform?: string;
  /** The flow's args for a call, run in the task's directory; `author` when it posts as the task's app. */
  args(input: I, cwd: string, author?: string): Record<string, unknown>;
  /** The message body for the flow's result. */
  render(result: unknown, runId: string): Promise<string>;
}

/** One call: its tool, its run, the turn whose calls it spends, its timeout, the driver's pid once it drives, whether the task got the result, and the turn that result started. */
interface AsyncCall {
  tool: string;
  runId: string;
  turn: number;
  timeout?: number;
  pid?: number;
  delivered?: boolean;
  landed?: { turn: number; budget: number };
}

const callsFile = (taskDir: string) => path.join(taskDir, 'async.json');

const asyncCalls = (taskDir: string) => readJsonFile<AsyncCall[]>(callsFile(taskDir)) ?? [];

/** Change the task's calls under their lock. */
function updateCalls<T>(taskDir: string, work: (calls: AsyncCall[]) => T) {
  return withFileLock(`${callsFile(taskDir)}.lock`, () => {
    const calls = asyncCalls(taskDir);
    const result = work(calls);
    writeJsonFileAtomic(callsFile(taskDir), calls);

    return result;
  });
}

/** The turn whose calls an engine turn spends: its own, or for a turn a result started, the one that result's call spent. */
const budgetTurn = (calls: AsyncCall[], turn: number) =>
  calls.find(call => call.landed?.turn === turn)?.landed!.budget ?? turn;

/** The flow that started a task, if any; its tasks get no async tools, so calls never nest. */
export const taskFlow = (task: Pick<Task, 'flowRunId'>) =>
  task.flowRunId ? readRawRecord(task.flowRunId)?.name : undefined;

/** The task's call whose result is still on its way, of one tool or any. */
export function pendingCall(taskDir: string, tool?: string): string | undefined {
  return asyncCalls(taskDir).find(
    call =>
      (!tool || call.tool === tool) &&
      !call.delivered &&
      (readFlowRecord(call.runId)?.status === 'running' ||
        (call.pid !== undefined && pidAlive(call.pid))),
  )?.runId;
}

/** Start a call in a detached driver; resolves with its run id once it is on its way. */
export async function startAsyncTool<I>(
  taskDir: string,
  tool: AsyncTool<I>,
  input: I,
  timeout?: number,
): Promise<string> {
  const task = readJsonFile<Task>(path.join(taskDir, 'job.json'));
  if (!task) throw new Error('This task has no record');
  if (taskFlow(task) === tool.flow)
    throw new Error(`A ${tool.name} task cannot start a ${tool.name}`);
  if (timeout !== undefined && !(timeout > 0))
    throw new Error('timeout must be a positive number of seconds');
  const cwd = task.cwd ?? process.cwd();
  const posts = Boolean(tool.platform && process.env[tokenEnvName(tool.platform)]);

  return updateCalls(taskDir, calls => {
    const pending = pendingCall(taskDir, tool.name);
    if (pending)
      throw new Error(
        `${capital(tool.name)} ${pending} is still running; its result arrives as a message.`,
      );
    const turn = budgetTurn(calls, readTurnResults(cwd, task.id).length);
    if (calls.filter(call => call.tool === tool.name && call.turn === turn).length >= tool.limit)
      throw new Error(`This turn has used all ${tool.limit} of its ${tool.name}s.`);

    const record = prepareRun(tool.flow, {
      cwd,
      args: {
        ...tool.args(input, cwd, posts ? task.author : undefined),
        ...(task.pullRequest !== undefined ? { eventPr: task.pullRequest } : {}),
      },
    });
    calls.push({ tool: tool.name, runId: record.runId, turn, ...(timeout ? { timeout } : {}) });
    // A cloud task's runner drives its calls, with the credential each model runs on.
    if (process.env.CODER_MCP_MODE === 'cloud') return record.runId;
    // The driver dispatches the flow's tasks, which a worker's environment refuses.
    const { [WORKER_ENV]: _, ...env } = process.env;
    detachRun(record, cwd, {
      env,
      drive: [
        '--task',
        task.id,
        '--tool',
        tool.name,
        ...(timeout ? ['--timeout', String(timeout)] : []),
      ],
    });

    return record.runId;
  });
}

/** The calls a task's runner has yet to drive, claimed for this process. */
export function claimCalls(taskDir: string): Promise<AsyncCall[]> {
  return updateCalls(taskDir, calls =>
    calls.flatMap(call => {
      if (call.pid !== undefined || call.delivered) return [];
      call.pid = process.pid;

      return [{ ...call }];
    }),
  );
}

/** Drive a call's run, then send the task its result, error, timeout or stop; never nothing. A runner drives in its own process: it gives the app's token, each model's credentials and its stop signal; a detached driver reads its token from its environment and stops on a signal. */
export async function driveAsyncTool(
  tool: AsyncTool,
  runId: string,
  cwd: string,
  taskId: string,
  timeout?: number,
  runner?: {
    integrationToken?: string;
    links?: ReviewLinks;
    onModel: FlowHooks['onModel'];
    stop: AbortSignal;
  },
): Promise<void> {
  const taskDir = resolveTaskDir(cwd, taskId);
  const mark = (patch: Partial<AsyncCall>) =>
    updateCalls(taskDir, calls => {
      const call = calls.find(candidate => candidate.runId === runId);
      if (call) Object.assign(call, patch);
    });
  const name = capital(tool.name);
  const tokenName = tool.platform && tokenEnvName(tool.platform);
  const integrationToken = runner
    ? runner.integrationToken
    : tokenName
      ? process.env[tokenName]
      : undefined;
  // The flow's tasks never see the app's token.
  if (tokenName && !runner) delete process.env[tokenName];
  let run: { requestStop(): void; runningIds(): string[] } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stop = () => {};
  const ended = new Promise<'timeout' | 'stopped'>(resolve => {
    if (timeout) timer = setTimeout(() => resolve('timeout'), timeout * 1000);
    stop = () => resolve('stopped');
    if (runner) runner.stop.addEventListener('abort', stop, { once: true });
    else {
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    }
  });
  let outcome: string;
  try {
    await mark({ pid: process.pid });
    const record = readRawRecord(runId);
    if (!record) throw new Error(`No flow run "${runId}".`);
    const done = await Promise.race([
      drivePreparedRun(
        record,
        cwd,
        { onStart: started => (run = started), ...(runner ? { onModel: runner.onModel } : {}) },
        integrationToken,
        runner?.links,
        loadTask(cwd, taskId)?.access,
      ),
      ended,
    ]);
    if (typeof done === 'string') {
      await stopFlowTasks(runId, run?.runningIds());
      run?.requestStop();
      outcome =
        done === 'timeout'
          ? `${name} timed out after ${timeout}s and was stopped`
          : `${name} was stopped`;
    } else outcome = `${name} finished\n\n${await tool.render(done.result, runId)}`;
  } catch (error) {
    outcome = `${name} ${runId} failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    clearTimeout(timer);
    runner?.stop.removeEventListener('abort', stop);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }

  const task = loadTask(cwd, taskId);
  if (!task) throw new Error(`No task "${taskId}" to send ${tool.name} ${runId} to.`);
  const calls = asyncCalls(taskDir);
  const turns = readTurnResults(cwd, taskId).length;
  // A running task takes the result into its turn; a stopped one into a new turn that spends the call's turn.
  const running = task.status === 'running';
  const budget = running
    ? budgetTurn(calls, turns)
    : (calls.find(call => call.runId === runId)?.turn ?? turns);
  const left =
    tool.limit - calls.filter(call => call.tool === tool.name && call.turn === budget).length;
  const [head, ...rest] = outcome.split('\n');
  const text = [`${head} (${tool.name}s left this turn ${left}/${tool.limit}).`, ...rest].join(
    '\n',
  );

  const { steered } = await steerTask(
    task.cwd ?? cwd,
    task,
    text,
    // A runner's task resumes with the connections it already resolved.
    (task.connectionSource ?? (task.connections ? 'server' : undefined)) === 'server'
      ? { resolveConnections: heldConnections(task.mcp) }
      : {},
  );
  await mark({
    delivered: true,
    ...(steered === 'live' ? {} : { landed: { turn: running ? turns + 1 : turns, budget } }),
  });
}

const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);
