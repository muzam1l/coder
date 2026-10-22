/** Async task tools: a flow run in a detached driver whose result, error, timeout or stop comes back to the task as a steer. */
import path from 'node:path';
import process from 'node:process';

import { WORKER_ENV } from '../dispatch';
import { loadTask, resolveTaskDir } from '../state';
import { heldConnections, steerTask } from './actions';
import type { Task } from '../types';
import { readJsonFile, withFileLock, writeJsonFileAtomic } from '../../utils/fsx';
import { drivePreparedRun, pidAlive, prepareRun, stopFlowTasks } from '../../flow/executor';
import { detachRun, readFlowRecord, readRawRecord } from '../../flow/runs';

/** A tool that runs a flow and answers later: one call at a time, `limit` per task. */
export interface AsyncTool<I = any> {
  name: string;
  flow: string;
  limit: number;
  /** The flow's args for a call, run in the task's directory. */
  args(input: I, cwd: string): Record<string, unknown>;
  /** The message body for the flow's result. */
  render(result: unknown, runId: string): Promise<string>;
}

/** One call: its tool, its run, the driver's pid once it drives, and whether the task got the result. */
interface AsyncCall {
  tool: string;
  runId: string;
  pid?: number;
  delivered?: boolean;
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

  return updateCalls(taskDir, calls => {
    const pending = pendingCall(taskDir, tool.name);
    if (pending)
      throw new Error(
        `${capital(tool.name)} ${pending} is still running; its result arrives as a message.`,
      );
    if (calls.filter(call => call.tool === tool.name).length >= tool.limit)
      throw new Error(`This task has used all ${tool.limit} of its ${tool.name}s.`);

    const record = prepareRun(tool.flow, { cwd, args: tool.args(input, cwd) });
    calls.push({ tool: tool.name, runId: record.runId });
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

/** Drive a call's run, then send the task its result, error, timeout or stop; never nothing. */
export async function driveAsyncTool(
  tool: AsyncTool,
  runId: string,
  cwd: string,
  taskId: string,
  timeout?: number,
): Promise<void> {
  const taskDir = resolveTaskDir(cwd, taskId);
  const mark = (patch: Partial<AsyncCall>) =>
    updateCalls(taskDir, calls => {
      const call = calls.find(candidate => candidate.runId === runId);
      if (call) Object.assign(call, patch);
    });
  const name = capital(tool.name);
  let run: { requestStop(): void; runningIds(): string[] } | undefined;
  let timer: NodeJS.Timeout | undefined;
  let stop = () => {};
  const ended = new Promise<'timeout' | 'stopped'>(resolve => {
    if (timeout) timer = setTimeout(() => resolve('timeout'), timeout * 1000);
    stop = () => resolve('stopped');
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  let outcome: string;
  try {
    await mark({ pid: process.pid });
    const record = readRawRecord(runId);
    if (!record) throw new Error(`No flow run "${runId}".`);
    const done = await Promise.race([
      drivePreparedRun(record, cwd, { onStart: started => (run = started) }),
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
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  }

  const task = loadTask(cwd, taskId);
  if (!task) throw new Error(`No task "${taskId}" to send ${tool.name} ${runId} to.`);
  const left = tool.limit - asyncCalls(taskDir).filter(call => call.tool === tool.name).length;
  const [head, ...rest] = outcome.split('\n');
  const text = [`${head} (task ${tool.name}s left ${left}/${tool.limit}).`, ...rest].join('\n');

  await steerTask(
    task.cwd ?? cwd,
    task,
    text,
    // A runner's task resumes with the connections it already resolved.
    (task.connectionSource ?? (task.connections ? 'server' : undefined)) === 'server'
      ? { resolveConnections: heldConnections(task.mcp) }
      : {},
  );
  await mark({ delivered: true });
}

const capital = (word: string) => word[0]!.toUpperCase() + word.slice(1);
