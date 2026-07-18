import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, parseArgs } from '../lib/args.js';
import { readJob, readJobLog, reconcileJob, resolveJobDir } from '../lib/state.js';
import {
  formatTokens,
  outStyle,
  printJson,
  promptBlock,
  rejectExtraArgs,
  requireJob,
  resolveCwd,
  STEP_PREVIEW_CHARS,
  trimStep,
} from '../lib/ui.js';

// Follow a job's progress log live, then print its final answer. Useful for a
// background task: `coder task stream <job>` attaches after the fact and blocks until
// the job reaches a terminal state, exiting 0 on success and 1 otherwise.
// By default it replays the last log line (so the current step is visible);
// --tail <n> replays the last n log lines first, --tail all replays everything.
// --json emits each new log entry as a JSON line, then the full result object.
export async function commandStream(argv: string[]) {
  const { options, positionals } = parseArgs(
    argv,
    z.object({
      ...baseOptions,
      tail: z.optional(
        z.union([z.literal('all'), z.coerce.number().check(z.int(), z.nonnegative())], {
          error: 'expected a number or "all"',
        }),
      ),
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
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  const ALL = Number.MAX_SAFE_INTEGER;

  // How many prior log lines to replay before following. Default 1, so the
  // step in progress is visible; `--tail all` replays the whole transcript.
  const tailOpt = options.tail;
  const tail = tailOpt === undefined ? 1 : tailOpt === 'all' ? ALL : tailOpt;

  // Per-step display cap, applied to text and JSON alike (the job log keeps
  // full entries). --trim <n> overrides the default; --trim none disables it.
  const trimOpt = options.trim;
  const trim = trimOpt === undefined ? STEP_PREVIEW_CHARS : trimOpt === 'none' ? Number.MAX_SAFE_INTEGER : trimOpt;

  // Skip everything older than the last `tail` entries.
  let printed = Math.max(0, readJobLog(cwd, job.id, ALL).length - tail);
  const flush = () => {
    const entries = readJobLog(cwd, job.id, ALL);
    for (const entry of entries.slice(printed)) {
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
    printed = entries.length;
  };

  let current = job;
  if (!options.json) {
    process.stdout.write(
      `${outStyle.dim(`[coder] task ${job.id} ${current.status} — streaming (Ctrl-C to stop)`)}\n`,
    );
    if (job.prompt) {
      process.stdout.write(`${promptBlock(job.prompt, outStyle).join('\n')}\n`);
    }
  }
  flush();
  while (!terminal.has(current.status)) {
    await new Promise(resolve => setTimeout(resolve, 400));
    // reconcileJob flips a zombie (dead worker) to failed, so we never poll a
    // task that can no longer finish.
    current = reconcileJob(cwd, readJob(cwd, job.id) ?? current);
    flush();
  }
  flush();

  const resultFile = path.join(resolveJobDir(cwd, job.id), 'result.json');
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  if (options.json) {
    printJson({ taskId: job.id, status: current.status, result });
  } else {
    const done = current.status === 'completed';
    process.stdout.write(
      `\n${result?.finalMessage || (done ? '(no final message)' : `(task ${current.status})`)}\n`,
    );
    const tokensNote = result?.tokens
      ? ` tokens=${formatTokens(result.tokens, result.model ?? current.model)}`
      : '';
    process.stderr.write(
      `${outStyle.dim(`[coder] task=${job.id} status=${current.status}${tokensNote}`)}\n`,
    );
  }
  process.exit(current.status === 'completed' ? 0 : 1);
}
