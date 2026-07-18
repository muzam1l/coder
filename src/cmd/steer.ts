import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs, str } from '../lib/args.js';
import { enqueueSteer, readJob, resolveJobDir, waitForTerminalJob } from '../lib/state.js';
import { steerTurn } from '../lib/codex-core.js';
import { fail, outStyle, printJson, requireJob, resolveCwd } from '../lib/ui.js';
import { ACTIVE_STATUSES } from '../lib/types.js';
import { commandTask } from './task.js';

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
      hint: `Wait for it to start: coder task stream ${job.id}`,
    });
  }

  // A running task steers into its live turn rather than starting a new one.
  if (job.status === 'running') {
    // Codex (and custom models, which run on the codex engine) can inject the
    // follow-up straight into the active turn over the shared broker.
    if (job.engine !== 'claude') {
      const result = await steerTurn(cwd, { threadId: job.threadId, text: prompt });
      if (result.steered) {
        return reportRunningSteer(cwd, job.id, { queued: false, options });
      }
    }
    // Not injectable live — a codex non-steerable window (e.g. compaction) or
    // the claude engine, which has no live steering. Re-read: if the turn just
    // finished, drop through to the resume path; otherwise queue the follow-up
    // for the worker to run when the current turn ends.
    const fresh = readJob(cwd, job.id) ?? job;
    if (ACTIVE_STATUSES.includes(fresh.status)) {
      enqueueSteer(cwd, fresh.id, prompt);
      return reportRunningSteer(cwd, fresh.id, { queued: true, options });
    }
  }

  // Stopped (or just-finished) task: resume as a fresh turn on its thread.
  const forwarded = [
    prompt,
    '--resume',
    job.id,
    '--cwd',
    cwd,
    ...(job.agent ? ['--agent', job.agent] : []),
    ...(options.model ? ['--model', options.model] : job.model ? ['--model', job.model] : []),
    ...(options.effort ? ['--effort', options.effort] : job.effort ? ['--effort', job.effort] : []),
    ...(options.permissions
      ? ['--permissions', options.permissions]
      : job.permissions
        ? ['--permissions', job.permissions]
        : []),
    ...(options.wait ? ['--wait'] : []),
  ];
  await commandTask(forwarded);
}

// Report the outcome of steering a running task. A live-steered follow-up joins
// the active turn (so --wait blocks on that turn finishing); a queued one runs
// later, after the current turn ends, so --wait is not meaningful for it.
async function reportRunningSteer(
  cwd: string,
  jobId: string,
  { queued, options }: { queued: boolean; options: Record<string, any> },
): Promise<void> {
  if (queued) {
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
      printJson({ taskId: jobId, steered: 'live' });
      return;
    }
    process.stdout.write(
      `${outStyle.dim('[coder]')} steered follow-up into running task ${outStyle.cyan(jobId)}.\n`,
    );
    process.stdout.write(`\n${outStyle.dim(`  result:  coder task result ${jobId}`)}\n`);
    return;
  }

  // --wait: block on the (now-extended) live turn reaching a terminal status.
  const current = readJob(cwd, jobId);
  const final = current ? await waitForTerminalJob(cwd, current) : null;
  const resultFile = path.join(resolveJobDir(cwd, jobId), 'result.json');
  const result = fs.existsSync(resultFile)
    ? JSON.parse(fs.readFileSync(resultFile, 'utf8'))
    : null;
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
