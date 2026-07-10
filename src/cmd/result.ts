import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { resolveJobDir, waitForTerminalJob } from '../lib/state.js';
import { listPendingApprovals } from '../lib/approvals.js';
import {
  formatHints,
  outStyle,
  paintStatus,
  printJson,
  rejectExtraArgs,
  requireJob,
  resolveCwd,
} from '../lib/ui.js';
import { ACTIVE_STATUSES } from '../lib/types.js';

// The one inspect command: status + final answer. While a task runs it shows the
// status (result pending); once finished it shows the answer. --wait blocks until
// then. Defaults to the most recent task.
export async function commandResult(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json', 'wait'],
  });
  rejectExtraArgs(positionals, 1, 'task result');
  const cwd = resolveCwd(options);
  let job = requireJob(cwd, positionals[0]);
  if (options.wait) {
    // Tell the user we're blocking (not hung) before we start polling.
    if (ACTIVE_STATUSES.includes(job.status)) {
      process.stderr.write(
        `${outStyle.dim(`[coder] waiting for task ${job.id} to finish...`)}\n`,
      );
    }
    job = await waitForTerminalJob(cwd, job);
  }

  const pending = listPendingApprovals(resolveJobDir(cwd, job.id)).filter(a => !a.response);
  const resultFile = path.join(resolveJobDir(cwd, job.id), 'result.json');
  const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
  const running = ACTIVE_STATUSES.includes(job.status);
  const exit = () => {
    if (options.wait) {
      process.exit(job.status === 'completed' ? 0 : 1);
    }
  };

  if (options.json) {
    printJson({
      taskId: job.id,
      name: job.name ?? null,
      status: job.status,
      agent: job.agent,
      pendingApprovals: pending.map(a => ({ id: a.id, summary: a.summary })),
      result,
    });
    return exit();
  }

  const s = outStyle;
  const lines = [
    `${s.dim('task')}     ${s.cyan(job.id)}`,
    ...(job.name ? [`${s.dim('name')}     ${job.name}`] : []),
    `${s.dim('status')}   ${paintStatus(job.status)}`,
    `${s.dim('agent')}    ${job.agent ?? '-'}`,
  ];
  if (pending.length) {
    lines.push('', s.dim('pending approvals:'));
    for (const a of pending) {
      lines.push(`  ${s.cyan(a.id)}  ${a.summary}`);
    }
  }
  lines.push('');
  if (result) {
    lines.push(result.finalMessage || '(no final message)');
  } else {
    lines.push(s.dim(running ? 'Result pending — task is still running.' : '(no result)'));
  }
  // While it's still running, point at --wait to block for the answer.
  if (running && !options.wait) {
    lines.push('', formatHints([`Wait for it: coder task result ${job.id} --wait`], s));
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  if (result?.touchedFiles?.length) {
    process.stderr.write(`[coder] touched files: ${result.touchedFiles.join(', ')}\n`);
  }
  return exit();
}
