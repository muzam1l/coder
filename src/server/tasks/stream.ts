import fs from 'node:fs';
import path from 'node:path';
import { type Params } from '../routes/match';
import { loadTask, resolveTaskDir } from '../../core/state';
import { type TaskLogLine, type TaskStatus } from '../store/types';
import { type ServerContext } from '../context';
import { start } from './flows';
import { json, pageLimit } from '../routes/http';
import { taskRunner } from '../runners';
import { localLog, localTask } from './local';
import { copyRunnerLogs, readLog } from './logs';
import { redactTask, DONE } from './admin';

export async function taskStream(
  req: Request,
  ctx: ServerContext,
  params: Params,
  url: URL,
): Promise<Response> {
  const id = params.id!;
  const taskId = id;
  const after = Number(url.searchParams.get('after') ?? -1);
  const cursor = Number.isFinite(after) ? after : -1;
  const lines = url.searchParams.has('limit') ? pageLimit(url, 500, 2000) : undefined;
  // A stored log read needs nothing from the task row, so it starts beside it.
  const status = await ctx.store.get('task', taskId);
  if (
    !status ||
    (ctx.local && status.handle?.startsWith('cli:') && status.task.flow === 'default')
  ) {
    const cwd = status?.task.cwd ?? ctx.local?.cwd;
    if (!cwd) return json({ error: `No task "${taskId}"` }, 404);

    const local = localTask(cwd, taskId, false);
    if (!local) return json({ error: `No task "${taskId}"` }, 404);
    {
      const last = Number(req.headers.get('last-event-id') ?? cursor);

      return streamTask(req, Number.isFinite(last) ? last : cursor, async after => {
        const current = localTask(cwd, taskId);
        if (!current) return undefined;

        const task = loadTask(cwd, taskId);
        const finished = Math.max(
          current.finishedAt ?? 0,
          Date.parse(task?.resumedAt ?? task?.createdAt ?? '') || 0,
        );
        const pendingResult =
          DONE.has(current.status) &&
          !current.error &&
          current.status !== 'cancelled' &&
          (!current.result ||
            (fs.statSync(path.join(resolveTaskDir(cwd, taskId), 'result.json'), {
              throwIfNoEntry: false,
            })?.mtimeMs ?? 0) < finished);

        return {
          status: current,
          lines: localLog(cwd, taskId, after, STREAM_LINES),
          pendingResult,
        };
      });
    }
  }

  const last = Number(req.headers.get('last-event-id') ?? cursor);

  return streamTask(req, Number.isFinite(last) ? last : cursor, async after => {
    const current = await ctx.store.get('task', taskId);
    if (!current) return undefined;

    const archived = current.task.runner === 'github-actions' && current.handle;
    const pendingLogs =
      archived && DONE.has(current.status)
        ? (
            await (
              await taskRunner(ctx, current.task)
            )
              ?.status(current.handle!)
              .catch(() => undefined)
          )?.state === 'running'
        : false;
    const lines =
      (['running', 'waiting'].includes(current.status) || archived) && current.handle
        ? await copyRunnerLogs(ctx, current, after, STREAM_LINES).catch(() =>
            readLog(ctx.store, taskId, after, STREAM_LINES),
          )
        : await readLog(ctx.store, taskId, after, STREAM_LINES);

    return { status: current, lines, pendingLogs };
  });
}

export const STREAM_MS = 50_000;

export const STREAM_POLL_MS = 1000;

export const STREAM_LINES = 500;

export function liveState(status: TaskStatus) {
  const { status: state, approval, answer, result, error, startedAt, finishedAt } = status;
  return {
    status: state,
    approval: approval ?? null,
    answer,
    result,
    error,
    startedAt,
    finishedAt,
    turns: redactTask(status).turns,
  };
}

export function streamTask(
  req: Request,
  after: number,
  read: (cursor: number) => Promise<
    | {
        status: TaskStatus;
        lines: TaskLogLine[];
        pendingLogs?: boolean;
        pendingResult?: boolean;
      }
    | undefined
  >,
): Response {
  const encoder = new TextEncoder();
  const deadline = Date.now() + STREAM_MS;
  let cursor = after;
  let shown = '';
  let left = false;
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      send(`retry: ${STREAM_POLL_MS}\n\n`);
      try {
        while (!left && !req.signal.aborted && Date.now() < deadline) {
          const found = await read(cursor);
          if (!found) break;
          const { status, lines, pendingLogs, pendingResult } = found;
          for (const line of lines) {
            send(`id: ${line.seq}\nevent: log\ndata: ${JSON.stringify(line)}\n\n`);
            cursor = line.seq;
          }
          const live = JSON.stringify(liveState(status));
          const pending =
            pendingLogs ||
            pendingResult ||
            (DONE.has(status.status) && lines.length === STREAM_LINES);
          if (live !== shown && !pending) {
            send(`event: status\ndata: ${live}\n\n`);
            shown = live;
          }
          if (lines.length === STREAM_LINES) continue;
          if (DONE.has(status.status) && !pending) {
            send('event: end\ndata: {}\n\n');
            break;
          }
          await new Promise(resolve => setTimeout(resolve, STREAM_POLL_MS));
        }
      } finally {
        // A client that left has already cancelled the stream.
        if (!left) controller.close();
      }
    },
    cancel() {
      left = true;
    },
  });
  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
    },
  });
}
