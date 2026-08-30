import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, parseArgs, tailOption } from '../lib/args.js';
import {
  readJob,
  reconcileJob,
  resolveJobDir,
  type JobLogEntry,
} from '../lib/state.js';
import { createJsonlTail, readJsonFile, shortPath } from '../lib/fsx.js';
import {
  LogRenderer,
  OUTPUT_PREVIEW_CHARS,
  finalMessageLine,
  outStyle,
  printJson,
  promptBlock,
  rejectExtraArgs,
  requireJob,
  resolveCwd,
  taskHeaderLines,
  taskSummaryLines,
  termCols,
  trimStep,
} from '../lib/ui.js';
import { ACTIVE_STATUSES, type TokenUsage } from '../lib/types.js';

// Print-free core (SDK `task.stream`): follow a task's progress log, yielding
// each JobLogEntry until the task reaches a terminal state. `tail` replays only
// the last n entries already logged ('all' for the whole transcript; default 1,
// so just the step in progress).
export async function* streamTaskCore(
  cwd: string,
  taskId: string,
  opts: { tail?: number | 'all' } = {},
): AsyncGenerator<JobLogEntry> {
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  let current = readJob(cwd, taskId);
  if (!current) {
    throw new Error(`No task found for "${taskId}".`);
  }
  // Skip everything older than the last `tail` entries, then follow the file
  // incrementally — each tick reads only the appended bytes instead of
  // re-parsing the whole (unbounded) log.
  const tail = opts.tail ?? 1;
  const tailLines = createJsonlTail(path.join(resolveJobDir(cwd, taskId), 'log.jsonl'));
  let first = true;
  const drain = (): JobLogEntry[] => {
    let lines = tailLines();
    if (first) {
      first = false;
      if (tail !== 'all') lines = tail === 0 ? [] : lines.slice(-tail);
    }
    return lines.map((line): JobLogEntry => {
      try {
        return JSON.parse(line) as JobLogEntry;
      } catch {
        return { message: line };
      }
    });
  };
  yield* drain();
  while (!terminal.has(current.status)) {
    await new Promise(resolve => setTimeout(resolve, 400));
    current = reconcileJob(cwd, readJob(cwd, taskId) ?? current);
    yield* drain();
  }
  yield* drain();
}

export async function commandWatch(argv: string[]) {
  const { options, positionals } = parseArgs(
    argv,
    z.object({
      ...baseOptions,
      tail: tailOption,
      trim: z.optional(
        z.union([z.literal('none'), z.coerce.number().check(z.int(), z.positive())], {
          error: 'expected a positive integer or "none"',
        }),
      ),
    }),
  );
  rejectExtraArgs(positionals, 1, 'task watch');
  const cwd = resolveCwd(options);
  const job = requireJob(cwd, positionals[0]);

  // How many prior log lines to replay before following: streamTaskCore's
  // default of 1 keeps the step in progress visible; `--tail all` replays the
  // whole transcript.
  const tail = options.tail;

  // Display budget for tool output and thinking, applied to text and JSON
  // alike (the job log keeps full entries). --trim <n> names a budget and
  // lifts the line cap with it; --trim none shows everything.
  const trimOpt = options.trim;
  const trim = trimOpt === undefined ? OUTPUT_PREVIEW_CHARS : trimOpt === 'none' ? Infinity : trimOpt;

  const renderer = new LogRenderer({
    cwd: job.cwd ?? cwd,
    startedAt: Date.parse(job.createdAt ?? '') || undefined,
    trim,
    explicitTrim: trimOpt !== undefined,
    width: termCols(),
  });

  if (!options.json) {
    // Header, prompt, transcript: three blocks, blank-line separated, so the
    // stream doesn't read as a continuation of the cwd line.
    const head = [
      ...taskHeaderLines(job, { status: job.status }),
      ...(ACTIVE_STATUSES.includes(job.status) ? [outStyle.dim('watching — Ctrl-C to stop')] : []),
      ...(job.prompt ? promptBlock(job.prompt, outStyle, { truncate: false }) : []),
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
  let held: JobLogEntry | null = null;
  const emit = (entry: JobLogEntry) => {
    const lines = renderer.render(entry);
    if (lines.length) process.stdout.write(`${lines.join('\n')}\n`);
  };
  for await (const entry of streamTaskCore(cwd, job.id, { tail })) {
    if (entry.kind === 'usage' && entry.tokens) {
      liveTokens = entry.tokens as TokenUsage;
    }
    if (options.json) {
      // Steers are user instructions, like the initial prompt: never trimmed,
      // so a watcher can audit exactly what changed the active turn.
      const entryTrim = entry.kind === 'steer' ? Infinity : trim;
      const out = entry.message
        ? { ...entry, message: trimStep(entry.message, entryTrim, { plain: true }) }
        : entry;
      process.stdout.write(`${JSON.stringify(out)}\n`);
      continue;
    }
    // Token snapshots are bookkeeping, not a reply — they must not decide that
    // a held message was mid-conversation.
    if (entry.kind === 'usage') continue;
    if (held) {
      emit(held);
      held = null;
    }
    if (entry.kind === 'assistant') held = entry;
    else emit(entry);
  }
  const current = reconcileJob(cwd, readJob(cwd, job.id) ?? job);

  const result = readJsonFile<any>(path.join(resolveJobDir(cwd, job.id), 'result.json'));
  if (options.json) {
    printJson({ taskId: job.id, status: current.status, result });
  } else {
    const done = current.status === 'completed';
    const fallback = done ? '(no final message)' : `(task ${current.status})`;
    // The run summary closes the transcript in the same shape the header
    // opened it, and the answer goes last — what you came for shouldn't be
    // buried above the bookkeeping.
    const summary = taskSummaryLines(current, {
      tokens: result?.tokens ?? liveTokens,
      tokenModel: result?.model,
      files: result?.touchedFiles?.map((file: string) => shortPath(job.cwd ?? cwd, file)),
      statusChanged: current.status !== job.status,
    });
    if (summary.length) process.stderr.write(`\n${summary.join('\n')}\n`);
    // The held entry and the recorded final message are the same answer;
    // print it once, from the result when there is one.
    const answer = finalMessageLine(result, current.error, fallback);
    const streamed = held ? String(held.message ?? '') : '';
    process.stdout.write(`\n${answer.trim() ? answer : streamed}\n`);
  }
  process.exit(current.status === 'completed' ? 0 : 1);
}
