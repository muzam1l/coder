import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs } from '../lib/args.js';
import { lastActivityAt, readJobLog, resolveJobDir } from '../lib/state.js';
import { waitForTaskAttention } from '../lib/wait.js';
import { listPendingApprovals } from '../lib/approvals.js';
import {
  STALL_MS,
  ageMs,
  formatAge,
  formatHints,
  formatTokens,
  outStyle,
  paintStatus,
  printJson,
  rejectExtraArgs,
  requireJob,
  resolveCwd,
  promptBlock,
  surfaceApproval,
  trimStep,
} from '../lib/ui.js';
import { ACTIVE_STATUSES } from '../lib/types.js';

// The one inspect command: status + final answer. While a task runs it shows the
// status (result pending); once finished it shows the answer. --wait blocks until
// then. Defaults to the most recent task.
export async function commandResult(argv: string[]) {
  const { options, positionals } = parseArgs(
    argv,
    z.object({
      ...baseOptions,
      tail: z.optional(
        z.union([z.literal('all'), z.coerce.number().check(z.int(), z.nonnegative())], {
          error: 'expected a number or "all"',
        }),
      ),
      wait: flag,
    }),
  );
  rejectExtraArgs(positionals, 1, 'task result');
  const cwd = resolveCwd(options);
  let job = requireJob(cwd, positionals[0]);
  if (options.wait) {
    // Tell the user we're blocking (not hung) before we start polling.
    if (ACTIVE_STATUSES.includes(job.status)) {
      process.stderr.write(`${outStyle.dim(`[coder] waiting for task ${job.id} to finish...`)}\n`);
    }
    const outcome = await waitForTaskAttention(cwd, job);
    job = outcome.job;
    if (outcome.reason === 'approval') {
      surfaceApproval(job.id, outcome.approval!, options.json);
    }
  }

  // --tail <n|all>: include the last n progress-log steps (same as stream --tail).
  const tail =
    options.tail === undefined ? 0 : options.tail === 'all' ? Number.MAX_SAFE_INTEGER : options.tail;
  const steps = tail > 0 ? readJobLog(cwd, job.id, tail) : [];

  const pending = listPendingApprovals(resolveJobDir(cwd, job.id)).filter(a => !a.response);
  const resultFile = path.join(resolveJobDir(cwd, job.id), 'result.json');
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  const running = ACTIVE_STATUSES.includes(job.status);
  // Last progress event, and how long ago — the signal for slow-vs-hung.
  const lastLog = running ? readJobLog(cwd, job.id, 1)[0] : undefined;
  // Latest sign of life (log, heartbeat, or job update) — heartbeats cover
  // activity we don't log, like output streaming from a long shell command.
  const lastActivity = running ? lastActivityAt(cwd, job) : job.updatedAt;
  const idle = ageMs(lastActivity);
  // Stalled only matters when it isn't legitimately waiting on the user.
  const stalled = running && pending.length === 0 && idle > STALL_MS;
  const exit = () => {
    if (options.wait) {
      process.exit(job.status === 'completed' ? 0 : 1);
    }
  };

  if (options.json) {
    printJson({
      taskId: job.id,
      name: job.name ?? null,
      prompt: job.prompt ?? null,
      system: job.system ?? null,
      status: job.status,
      agent: job.agent,
      model: job.model ?? null,
      ...(running ? { idleMs: idle, lastActivityAt: lastActivity ?? null, stalled } : {}),
      pendingApprovals: pending.map(a => ({ id: a.id, summary: a.summary })),
      ...(steps.length ? { steps } : {}),
      result,
    });
    return exit();
  }

  const s = outStyle;
  const lines = [
    `${s.dim('task')}     ${s.cyan(job.id)}`,
    ...(job.name ? [`${s.dim('name')}     ${job.name}`] : []),
    `${s.dim('status')}   ${paintStatus(job.status)}`,
    `${s.dim('agent')}    ${(job.agent ?? '-') + (job.model ? `/${job.model}` : '')}`,
    ...(result?.tokens
      ? [`${s.dim('tokens')}   ${formatTokens(result.tokens, result.model ?? job.model)}`]
      : []),
  ];
  // The prompt gets its own block (not a header field) so longer task text
  // stays readable.
  if (job.prompt) {
    lines.push('', ...promptBlock(job.prompt, s));
  }
  if (pending.length) {
    lines.push('', s.dim('pending approvals:'));
    for (const a of pending) {
      lines.push(`  ${s.cyan(a.id)}  ${a.summary}`);
    }
  }
  if (steps.length) {
    lines.push('', s.dim('steps:'));
    for (const entry of steps) {
      const msg = entry.message ?? entry.kind;
      if (msg) lines.push(`  ${s.dim(trimStep(msg))}`);
    }
  }
  // For a running task, surface last activity + how long ago (slow vs hung).
  if (running && lastLog) {
    const msg = lastLog.message ?? lastLog.kind ?? '';
    lines.push(`${s.dim('last')}     ${s.dim(`${trimStep(msg)} (${formatAge(idle)} ago)`)}`);
  }
  lines.push('');
  if (result) {
    const errorMessage = result.error?.message ?? job.error;
    lines.push(
      result.finalMessage ||
        (errorMessage ? `${s.red('error:')} ${errorMessage}` : '(no final message)'),
    );
  } else if (running) {
    lines.push(
      s.dim(
        stalled
          ? `Result pending, but no progress for ${formatAge(idle)} — the task may be stalled.`
          : 'Result pending — task is still running.',
      ),
    );
  } else {
    lines.push(s.dim('(no result)'));
  }
  // While it's still running, point at --wait to block for the answer (and to
  // the transcript if it looks stalled).
  if (running && !options.wait) {
    const hints = [
      `Wait for it: coder task result ${job.id} --wait`,
      `Follow live: coder task stream ${job.id}`,
    ];
    if (stalled) hints.push(`Check the transcript: coder task result ${job.id} --tail all`);
    lines.push('', formatHints(hints, s));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (result?.touchedFiles?.length) {
    process.stderr.write(`[coder] touched files: ${result.touchedFiles.join(', ')}\n`);
  }
  return exit();
}
