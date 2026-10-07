/** `coder task watch`: follow a task live, then its summary and answer; exits with the task's outcome. */
import process from 'node:process';

import * as z from 'zod/mini';

import type { TaskWatch } from '../../core/task';
import type { TaskLogEntry } from '../../core/state';
import { ACTIVE_STATUSES, type Style, type Task, type TokenUsage } from '../../core/types';
import type { TaskLogLine, TaskStatus } from '../../server/store/types';
import { outStyle } from '../../tui/output';
import { termCols } from '../../tui/live';
import { shortPath } from '../../utils/fsx';
import { baseOptions, flag, optStr, str, tailOption } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import {
  finalMessageLine,
  LogRenderer,
  OUTPUT_PREVIEW_CHARS,
  printOutcome,
  promptBlock,
  taskHeaderLines,
  taskSummaryLines,
  trimStep,
} from './result';

const serverOptions = { server: optStr, workspace: str, yes: flag };

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
): Promise<never> {
  if ('attempts' in watch.task) {
    for await (const line of watch.events)
      opts.json
        ? process.stdout.write(`${JSON.stringify(line, null, 2)}\n`)
        : printLine(line as TaskLogLine, outStyle);
    const status = (await watch.final()) as TaskStatus;
    if (!opts.json) printOutcome(status, outStyle);
    process.exit(0);
  }
  const task = watch.task;

  // Display budget for tool output and thinking, applied to text and JSON
  // alike (the task log keeps full entries). --trim <n> names a budget and
  // lifts the line cap with it; --trim none shows everything.
  const trim =
    opts.trim === undefined ? OUTPUT_PREVIEW_CHARS : opts.trim === 'none' ? Infinity : opts.trim;
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
      files: result?.touchedFiles?.map((file: string) => shortPath(task.cwd ?? cwd, file)),
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

export const commandWatch = command({
  name: 'task watch',
  help: {
    usage: 'coder task watch [task-id] [--server [url]]',
    summary:
      "Stream a running task's transcript live (for you/debugging), then print its\nfinal answer. Replays the last line first so the current step is visible;\n--tail <n> replays the last n lines (--tail all for the whole transcript).\nBlocks until it finishes; exits 0 on success, 1 otherwise. For the answer\nalone, prefer `coder result`. Alias: stream.",
    flags: [
      ['--tail <n|all>', 'replay the last n log lines first (default: 1)'],
      ['--trim <n|none>', 'budget for tool output and thinking (default: 1200 chars, 12 lines)'],
      SERVER_FLAG,
    ],
    examples: [['coder task watch', 'follow the most recent task to completion']],
  },
  options: {
    ...baseOptions,
    tail: tailOption,
    trim: z.optional(
      z.union([z.literal('none'), z.coerce.number().check(z.int(), z.positive())], {
        error: 'expected a positive integer or "none"',
      }),
    ),
    ...serverOptions,
  },
  args: 1,
  async run({ options, args: [id], cwd }) {
    const { tasks } = await import('../../core/task');

    await printWatch(
      await tasks.watch(id, { ...options, organization: options.workspace }),
      cwd,
      options,
    );
  },
});
