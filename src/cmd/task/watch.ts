/** `coder task watch`: follow a task live, then its summary and answer; exits with the task's outcome. */
import process from 'node:process';

import * as z from 'zod/mini';

import type { TaskWatch } from '../../core/task';
import type { TaskLogEntry } from '../../core/state';
import { ACTIVE_STATUSES, type Style, type Task, type TokenUsage } from '../../core/types';
import type { TaskLogLine } from '../../server/store/types';
import { outStyle } from '../../tui/output';
import { termCols } from '../../tui/live';
import { arg, serverOptions, str, tailOption } from '../../utils/args';
import { command, nextSteps } from '../../cli';
import {
  finalMessageLine,
  LogRenderer,
  OUTPUT_PREVIEW_CHARS,
  promptBlock,
  taskHeaderLines,
  taskSummaryLines,
  trimStep,
} from './result';

export function printLine(line: TaskLogLine, s: Style): void {
  const text =
    line.level === 'sys'
      ? s.dim(`· ${line.line}`)
      : line.level === 'err'
        ? s.light(line.line)
        : line.line;
  process.stdout.write(`${text}\n`);
}

/** Header, prompt and transcript as they land, then the run summary and the answer; exits with the task's outcome. */
async function printWatch(
  watch: TaskWatch,
  cwd: string,
  opts: { json?: boolean; trim?: number | 'none' },
  next: (result: unknown) => void,
): Promise<never> {
  const trim =
    opts.trim === undefined ? OUTPUT_PREVIEW_CHARS : opts.trim === 'none' ? Infinity : opts.trim;
  const task = watch.task;

  // Display budget for tool output and thinking, applied to text and JSON
  // alike (the task log keeps full entries). --trim <n> names a budget and
  // lifts the line cap with it; --trim none shows everything.
  const renderer = await LogRenderer.create({
    cwd: task.cwd ?? cwd,
    startedAt: Date.parse(task.createdAt ?? '') || undefined,
    trim,
    explicitTrim: opts.trim !== undefined,
    width: termCols(),
  });

  if (!opts.json) {
    // Header, prompt, transcript: three blocks, blank-line separated, so the
    // stream doesn't read as a continuation of the cwd line.
    const head = [
      ...taskHeaderLines(task, { status: task.status }),
      ...(ACTIVE_STATUSES.includes(task.status)
        ? [outStyle.dim('Watching. Press Ctrl-C to stop.')]
        : []),
      ...(task.prompt ? promptBlock(task.prompt, outStyle, { truncate: false }) : []),
      '',
    ];
    process.stdout.write(`${head.join('\n')}\n`);
  }

  // Latest token snapshot seen on the wire, so a task that is cancelled or
  // killed before it writes a result still reports what it spent.
  let liveTokens: TokenUsage | null = null;
  // The last assistant message is held back one entry: if nothing follows it,
  // it was the answer, and the answer belongs below the run summary rather
  // than above it. Anything that does follow flushes it straight through.
  let held: TaskLogEntry | null = null;
  const emit = (entry: TaskLogEntry) => {
    const lines = renderer.render(entry);
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  };
  for await (const event of watch.events) {
    const entry = event as TaskLogEntry;
    if (entry.kind === 'usage' && entry.tokens) {
      liveTokens = entry.tokens as TokenUsage;
    }
    if (opts.json) {
      // Steers are user instructions, like the initial prompt: never trimmed,
      // so a watcher can audit exactly what changed the active turn.
      const entryTrim = entry.kind === 'steer' ? Infinity : trim;
      const out = entry.message
        ? { ...entry, message: trimStep(entry.message, entryTrim, { plain: true }) }
        : entry;
      process.stdout.write(`${JSON.stringify(out)}\n`);
      continue;
    }
    // Token snapshots are bookkeeping, not a reply. They must not decide that
    // a held message was mid-conversation.
    if (entry.kind === 'usage') continue;
    if (held) {
      emit(held);
      held = null;
    }
    if (entry.kind === 'assistant') held = entry;
    else emit(entry);
  }
  const {
    status,
    result,
    task: current,
  } = (await watch.final()) as { status: string; result: any; task: Task };

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ taskId: task.id, status, result }, null, 2)}\n`);
  } else {
    const done = status === 'completed';
    const fallback = done ? '(no final message)' : `(task ${status})`;
    // The run summary closes the transcript in the same shape the header
    // opened it, and the answer goes last. What you came for should not be
    // buried above the bookkeeping.
    const summary = taskSummaryLines(current, {
      tokens: result?.tokens ?? liveTokens,
      tokenModel: result?.model,
      statusChanged: status !== task.status,
    });
    if (summary.length) process.stderr.write(`\n${summary.join('\n')}\n`);
    // The held entry and the recorded final message are the same answer;
    // print it once, from the result when there is one.
    const answer = finalMessageLine(result, current.error, fallback);
    const streamed = held ? String(held.message ?? '') : '';
    process.stdout.write(`\n${answer.trim() ? answer : streamed}\n`);
  }
  process.exit(status === 'completed' ? 0 : 1);
}

/** A slice of a task's log from `--from`, and the command that continues it while the task runs. */
type LogSlice = {
  taskId: string;
  status: string;
  events: TaskLogEntry[];
  next?: string;
};

async function logSlice(
  watch: TaskWatch,
  from: number,
  server: string | true | undefined,
): Promise<LogSlice> {
  const events: LogSlice['events'] = [];
  for await (const event of watch.events) events.push(event);
  const { task } = watch;
  const flag = server === undefined ? '' : server === true ? ' --server' : ` --server ${server}`;

  return {
    taskId: task.id,
    status: task.status,
    events,
    ...(ACTIVE_STATUSES.includes(task.status)
      ? { next: `coder task watch ${task.id} --from ${from + events.length}${flag}` }
      : {}),
  };
}

async function printSlice(slice: LogSlice, cwd: string): Promise<void> {
  const renderer = await LogRenderer.create({
    cwd,
    trim: OUTPUT_PREVIEW_CHARS,
    explicitTrim: false,
    width: termCols(),
  });
  for (const event of slice.events) {
    const lines = renderer.render(event);
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  }
}

export const commandWatch = command({
  name: 'watch',
  description: "stream a task's live transcript",
  usage:
    "Stream a running task's transcript live (for you/debugging), then print its\nfinal answer. Replays the last line first so the current step is visible;\n--tail <n> replays the last n lines (--tail all for the whole transcript).\nBlocks until it finishes; exits 0 on success, 1 otherwise. For the answer\nalone, prefer `coder result`. Alias: stream.\n\nWith --from <n>, or as a tool, it returns the log from event n on without\nfollowing, and `next`: the command that continues it while the task runs.",
  access: 'read',
  args: {
    'task-id': str('the task (default: the most recent)'),
    tail: tailOption('replay the last n log lines first (default: 1)'),
    trim: arg(
      z.optional(
        z.union([z.literal('none'), z.coerce.number().check(z.int(), z.positive())], {
          error: 'expected a positive integer or "none"',
        }),
      ),
      'budget for tool output and thinking (default: 1200 chars, 12 lines)',
      '<n|none>',
    ),
    from: arg(
      z.optional(z.coerce.number().check(z.int(), z.nonnegative())),
      'return the log from event n on instead of following it',
      '<n>',
    ),
    ...serverOptions,
  },
  cli: {
    positional: ['task-id'],
    examples: [
      'coder task watch  # follow the most recent task to completion',
      'coder task watch <task-id> --from 0 --json  # the log so far, and the command that continues it',
    ],
  },
  async run({ options, args: [id], cwd, tool, next }) {
    const { tasks } = await import('../../core/task');

    const from = options.from ?? (tool ? 0 : undefined);
    const watch = await tasks.watch(id, { ...options, from, organization: options.workspace });
    if (from !== undefined) return logSlice(watch, from, options.server);
    await printWatch(watch, cwd, options, next);
  },
  next({ result, args }) {
    if (!result) return [];
    return result.next ? nextSteps([`Continue: ${result.next}`]) : [];
  },
  print: (slice, { cwd }) => slice && printSlice(slice, cwd),
});
