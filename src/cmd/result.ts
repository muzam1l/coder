import process from 'node:process';

import * as z from 'zod/mini';

import { baseOptions, flag, parseArgs, tailOption } from '../lib/args.js';
import { readTask } from '../lib/dispatch.js';
import { lastActivityAt, readJobLog, readTurnResults, resolveJobDir } from '../lib/state.js';
import { waitForTaskAttention } from '../lib/wait.js';
import { listPendingApprovals } from '../lib/approvals.js';
import {
  LogRenderer,
  STALL_MS,
  ageMs,
  finalMessageLine,
  formatAge,
  formatHints,
  outStyle,
  printJson,
  rejectExtraArgs,
  requireJob,
  resolveCwd,
  promptBlock,
  surfaceApproval,
  taskHeaderLines,
  termCols,
  trimStep,
} from '../lib/ui.js';
import { shortPath } from '../lib/fsx.js';
import { ACTIVE_STATUSES, type TokenUsage } from '../lib/types.js';

// The one inspect command: status + final answer. While a task runs it shows the
// status (result pending); once finished it shows the answer. --wait blocks until
// then. Defaults to the most recent task.
export async function commandResult(argv: string[]) {
  const { options, positionals } = parseArgs(
    argv,
    z.object({
      ...baseOptions,
      tail: tailOption,
      wait: flag,
      turns: flag,
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

  // --tail <n|all>: include the last n progress-log steps (same as stream
  // --tail). readTask fills `steps`, so CLI --tail and SDK tail are one path.
  const { steps, result } = readTask(cwd, job.id, { tail: options.tail });
  const turns = readTurnResults(cwd, job.id);

  const pending = listPendingApprovals(resolveJobDir(cwd, job.id)).filter(a => !a.response);
  const running = ACTIVE_STATUSES.includes(job.status);
  const status = running && pending.length ? 'waiting-approval' : job.status;
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
      status,
      agent: job.agent,
      model: job.model ?? null,
      effort: job.effort ?? null,
      permissions: job.permissions ?? null,
      cwd: job.cwd ?? null,
      createdAt: job.createdAt ?? null,
      completedAt: job.completedAt ?? null,
      ...(running ? { idleMs: idle, lastActivityAt: lastActivity ?? null, stalled } : {}),
      pendingApprovals: pending.map(a => ({ id: a.id, summary: a.summary })),
      ...(steps.length ? { steps } : {}),
      turnCount: turns.length,
      ...(options.turns ? { turns } : {}),
      result,
    });
    return exit();
  }

  const s = outStyle;
  // A task still in flight has no result to quote tokens from; its latest
  // usage snapshot on the progress log is the running count.
  const liveTokens = running
    ? ((readJobLog(cwd, job.id, 200)
        .reverse()
        .find(entry => entry.kind === 'usage')?.tokens as TokenUsage | undefined) ?? null)
    : null;
  const lines = taskHeaderLines(job, {
    status,
    tokens: result?.tokens ?? liveTokens,
    tokenModel: result?.model,
    files: result?.touchedFiles?.map((file: string) => shortPath(job.cwd ?? cwd, file)),
    live: !result?.tokens && Boolean(liveTokens),
    style: s,
  });
  // The prompt gets its own block (not a header field) so longer task text
  // stays readable — but it closes the header, it doesn't stand apart from it.
  if (job.prompt) {
    lines.push(...promptBlock(job.prompt, s));
  }
  if (pending.length) {
    lines.push('', s.dim('pending approvals:'));
    for (const a of pending) {
      lines.push(`  ${s.cyan(a.id)}  ${a.summary}`);
      lines.push(`  ${s.bold(`coder approve ${job.id} ${a.id}`)}  ${s.dim('(--deny to reject)')}`);
    }
  }
  if (steps.length) {
    lines.push('', s.dim('steps:'));
    // Same transcript renderer `watch` streams through, so a recap and a live
    // follow read identically.
    const renderer = new LogRenderer({
      cwd: job.cwd ?? cwd,
      startedAt: Date.parse(job.createdAt ?? '') || undefined,
      width: termCols(),
      style: s,
    });
    // The answer is printed below in full; leaving its copy at the end of the
    // transcript would just say everything twice.
    const shown =
      result?.finalMessage &&
      String(steps.at(-1)?.message ?? '').trim() === String(result.finalMessage).trim()
        ? steps.slice(0, -1)
        : steps;
    for (const entry of shown) lines.push(...renderer.render(entry));
  }
  lines.push('');
  if (options.turns && turns.length) {
    turns.forEach((turn, i) => {
      if (i) lines.push('');
      lines.push(s.dim(`— turn ${i + 1} of ${turns.length}: ${trimStep(String(turn.prompt ?? ''))}`));
      lines.push(String(turn.finalMessage || s.dim('(no final message)')));
    });
  } else if (result) {
    lines.push(finalMessageLine({ ...result, error: result.error ?? undefined }, job.error, '(no final message)', s));
    if (turns.length > 1) {
      lines.push(s.dim(`(turn ${turns.length} of ${turns.length} — all answers: coder task result ${job.id} --turns)`));
    }
  } else if (running) {
    lines.push(
      s.dim(
        stalled
          ? `Result pending, but no progress for ${formatAge(idle)} — the task may be stalled.${
              lastLog ? ` Last: ${trimStep(lastLog.message ?? lastLog.kind ?? '')}` : ''
            }`
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
      `Follow live: coder task watch ${job.id}`,
    ];
    if (stalled) hints.push(`Check the transcript: coder task result ${job.id} --tail all`);
    lines.push('', formatHints(hints, s));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return exit();
}
