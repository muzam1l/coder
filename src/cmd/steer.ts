import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs, str } from '../lib/args.js';
import {
  appendJobLog,
  enqueueSteer,
  readJob,
  resolveJobDir,
  waitForTerminalJob,
  writeJob,
} from '../lib/state.js';
import { readJsonFile } from '../lib/fsx.js';
import { steerTurn } from '../lib/codex-core.js';
import { steerClaudeTurn } from '../lib/claude-core.js';
import { fail, outStyle, printJson, requireJob, resolveCwd } from '../lib/ui.js';
import { ACTIVE_STATUSES, type Job } from '../lib/types.js';
import { spawnWorker } from '../lib/dispatch.js';

/** How a steer was applied to a task. */
export type SteerOutcome = 'live' | 'queued' | 'resumed';

// Inject a follow-up into a running task's live turn, or queue it when it
// can't be injected live. Null means the task is not running (anymore): the
// caller should resume it as a fresh turn on its thread.
async function trySteerRunning(
  cwd: string,
  job: Job,
  text: string,
  adapters: {
    codex?: typeof steerTurn;
    claude?: typeof steerClaudeTurn;
  } = {},
): Promise<{ taskId: string; steered: 'live' | 'queued' } | null> {
  if (job.status !== 'running') {
    return null;
  }
  const result =
    job.engine === 'claude'
      ? await (adapters.claude ?? steerClaudeTurn)(job.steerEndpoint, text)
      : await (adapters.codex ?? steerTurn)(cwd, {
          endpoint: job.steerEndpoint,
          threadId: job.threadId,
          turnId: job.turnId,
          text,
        });
  if (result.steered) {
    appendJobLog(cwd, job.id, {
      kind: 'steer',
      message: `Steer accepted live:\n${text}`,
    });
    return { taskId: job.id, steered: 'live' };
  }
  if (!result.retryable) {
    appendJobLog(cwd, job.id, {
      kind: 'error',
      message: `Live steer failed: ${result.detail}`,
    });
    throw new Error(`Could not steer running task ${job.id}: ${result.detail}`);
  }
  // Not injectable live during a genuine startup/completion race. Re-read: if the turn just
  // finished, fall back to the resume path; otherwise queue the follow-up
  // for the worker to run when the current turn ends.
  const fresh = readJob(cwd, job.id) ?? job;
  if (ACTIVE_STATUSES.includes(fresh.status)) {
    enqueueSteer(cwd, fresh.id, text);
    appendJobLog(cwd, fresh.id, {
      kind: 'steer',
      message: `Steer queued for the next turn:\n${text}`,
    });
    return { taskId: fresh.id, steered: 'queued' };
  }
  return null;
}

// Print-free core (SDK `task.steer`).
export async function steerTaskCore(
  cwd: string,
  job: Job,
  text: string,
  opts: { model?: string; effort?: string; permissions?: string } = {},
  adapters: {
    codex?: typeof steerTurn;
    claude?: typeof steerClaudeTurn;
  } = {},
): Promise<{ taskId: string; steered: SteerOutcome }> {
  if (!job.threadId) {
    throw new Error(`Task ${job.id} has no thread to steer yet (status: ${job.status}).`);
  }
  const running = await trySteerRunning(cwd, job, text, adapters);
  if (running) {
    return running;
  }
  resumeInPlace(cwd, job, text, opts);
  return { taskId: job.id, steered: 'resumed' };
}

// A stopped task resumes on the SAME job record (never a stray new task id),
// in the job's own cwd: claude finds session transcripts per project dir.
function resumeInPlace(
  cwd: string,
  job: Job,
  text: string,
  opts: { model?: string; effort?: string; permissions?: string },
): void {
  writeJob(cwd, job.id, {
    status: 'queued',
    resumedAt: new Date().toISOString(),
    currentPrompt: text,
    resumeThreadId: job.threadId,
    steerEndpoint: null,
    model: (opts.model ?? job.model ?? null) as Job['model'],
    effort: (opts.effort ?? job.effort ?? null) as Job['effort'],
    permissions: (opts.permissions ?? job.permissions) as Job['permissions'],
    error: undefined,
  });
  appendJobLog(cwd, job.id, {
    kind: 'steer',
    message: `Resuming with steer:\n${text}`,
  });
  spawnWorker(job.cwd ?? cwd, job.id);
}

export async function commandSteer(argv: string[]) {
  const { options, positionals } = parseArgs(
    argv,
    z.object({ ...baseOptions, model: str, effort: str, permissions: str, background: flag, wait: flag }),
  );
  const cwd = resolveCwd(options);
  const [reference, ...promptParts] = positionals;
  const prompt = promptParts.join(' ').trim();
  if (!reference || !prompt) {
    fail('Missing task id or follow-up text.', {
      hint: ['Usage: coder task steer <task-id> "<follow-up>" [--wait]', 'Help: coder task steer --help'],
    });
  }
  const job = requireJob(cwd, reference);
  if (!job.threadId) {
    fail(`Task ${job.id} has no thread to steer yet (status: ${job.status}).`, {
      hint: `Wait for it to start: coder task watch ${job.id}`,
    });
  }

  const outcome = await steerTaskCore(cwd, job, prompt, {
    model: options.model,
    effort: options.effort,
    permissions: options.permissions,
  });
  return reportSteer(cwd, outcome.taskId, { steered: outcome.steered, options });
}

// A live/resumed follow-up extends the task's own turn (--wait blocks on it);
// a queued one runs after the current turn ends, so --wait can't apply.
async function reportSteer(
  cwd: string,
  jobId: string,
  { steered, options }: { steered: SteerOutcome; options: Record<string, any> },
): Promise<void> {
  if (steered === 'queued') {
    if (options.json) {
      printJson({ taskId: jobId, steered: 'queued' });
      return;
    }
    process.stdout.write(
      `${outStyle.dim('[coder]')} follow-up queued for task ${outStyle.cyan(jobId)}; it runs when the current turn finishes.\n`,
    );
    if (options.wait) {
      process.stdout.write(
        `\n${outStyle.dim(`[coder] --wait is not available for a queued follow-up; check: coder task result ${jobId}`)}\n`,
      );
    }
    return;
  }

  if (!options.wait) {
    if (options.json) {
      printJson({ taskId: jobId, steered });
      return;
    }
    process.stdout.write(
      steered === 'live'
        ? `${outStyle.dim('[coder]')} steered follow-up into running task ${outStyle.cyan(jobId)}.\n`
        : `${outStyle.dim('[coder]')} resumed task ${outStyle.cyan(jobId)} with the follow-up (same thread, same id).\n`,
    );
    process.stdout.write(`\n${outStyle.dim(`  result:  coder task result ${jobId}`)}\n`);
    return;
  }

  const current = readJob(cwd, jobId);
  const final = current ? await waitForTerminalJob(cwd, current) : null;
  const result = readJsonFile<any>(path.join(resolveJobDir(cwd, jobId), 'result.json'));
  if (options.json) {
    printJson({
      taskId: jobId,
      status: final?.status ?? null,
      finalMessage: result?.finalMessage ?? null,
    });
  } else {
    process.stdout.write(`\n${result?.finalMessage || '(no final message)'}\n\n`);
    process.stderr.write(
      `${outStyle.dim(`[coder] task=${jobId} status=${final?.status ?? 'unknown'}`)}\n`,
    );
  }
  process.exitCode = final?.status === 'completed' ? 0 : 1;
}
