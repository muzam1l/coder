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
import { createJsonlTail, readJsonFile } from '../lib/fsx.js';
import {
  finalMessageLine,
  formatTokens,
  formatAgentSpec,
  jobOptionLines,
  outStyle,
  printJson,
  promptBlock,
  rejectExtraArgs,
  requireJob,
  resolveCwd,
  STEP_PREVIEW_CHARS,
  trimStep,
} from '../lib/ui.js';

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

export async function commandStream(argv: string[]) {
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
  rejectExtraArgs(positionals, 1, 'task stream');
  const cwd = resolveCwd(options);
  const job = requireJob(cwd, positionals[0]);

  // How many prior log lines to replay before following: streamTaskCore's
  // default of 1 keeps the step in progress visible; `--tail all` replays the
  // whole transcript.
  const tail = options.tail;

  // Per-step display cap, applied to text and JSON alike (the job log keeps
  // full entries). --trim <n> overrides the default; --trim none disables it.
  const trimOpt = options.trim;
  const trim = trimOpt === undefined ? STEP_PREVIEW_CHARS : trimOpt === 'none' ? Number.MAX_SAFE_INTEGER : trimOpt;

  if (!options.json) {
    process.stdout.write(
      `${outStyle.dim(`[coder] task ${job.id} ${job.status} — streaming (Ctrl-C to stop)`)}\n`,
    );
    const header = [
      `${outStyle.dim('agent'.padEnd(8))} ${formatAgentSpec(job)}`,
      ...jobOptionLines(job, outStyle),
    ];
    process.stdout.write(`${header.join('\n')}\n`);
    if (job.prompt) {
      process.stdout.write(`${promptBlock(job.prompt, outStyle).join('\n')}\n`);
    }
  }
  for await (const entry of streamTaskCore(cwd, job.id, { tail })) {
    if (options.json) {
      const out = entry.message ? { ...entry, message: trimStep(entry.message, trim, { plain: true }) } : entry;
      process.stdout.write(`${JSON.stringify(out)}\n`);
    } else {
      const message = entry.message ?? entry.kind;
      if (message) {
        process.stdout.write(`${outStyle.dim('[coder]')} ${trimStep(message, trim)}\n`);
      }
    }
  }
  const current = reconcileJob(cwd, readJob(cwd, job.id) ?? job);

  const result = readJsonFile<any>(path.join(resolveJobDir(cwd, job.id), 'result.json'));
  if (options.json) {
    printJson({ taskId: job.id, status: current.status, result });
  } else {
    const done = current.status === 'completed';
    const fallback = done ? '(no final message)' : `(task ${current.status})`;
    process.stdout.write(`\n${finalMessageLine(result, current.error, fallback)}\n`);
    const tokensNote = result?.tokens
      ? ` tokens=${formatTokens(result.tokens, result.model ?? current.model)}`
      : '';
    process.stderr.write(
      `${outStyle.dim(`[coder] task=${job.id} status=${current.status}${tokensNote}`)}\n`,
    );
  }
  process.exit(current.status === 'completed' ? 0 : 1);
}
