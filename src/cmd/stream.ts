import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { parseArgs } from '../lib/args.js';
import { readJob, readJobLog, reconcileJob, resolveJobDir } from '../lib/state.js';
import { outStyle, printJson, rejectExtraArgs, requireJob, resolveCwd } from '../lib/ui.js';

// Follow a job's progress log live, then print its final answer. Useful for a
// background task: `coder task stream <job>` attaches after the fact and blocks until
// the job reaches a terminal state, exiting 0 on success and 1 otherwise.
// --json emits each new log entry as a JSON line, then the full result object.
export async function commandStream(argv: string[]) {
  const { options, positionals } = parseArgs(argv, {
    valueOptions: ['cwd'],
    booleanOptions: ['json'],
  });
  rejectExtraArgs(positionals, 1, 'task stream');
  const cwd = resolveCwd(options);
  const job = requireJob(cwd, positionals[0]);
  const terminal = new Set(['completed', 'failed', 'cancelled']);
  const ALL = Number.MAX_SAFE_INTEGER;

  let printed = 0;
  const flush = () => {
    const entries = readJobLog(cwd, job.id, ALL);
    for (const entry of entries.slice(printed)) {
      if (options.json) {
        process.stdout.write(`${JSON.stringify(entry)}\n`);
      } else {
        const message = entry.message ?? entry.kind;
        if (message) {
          process.stdout.write(`${outStyle.dim('[coder]')} ${message}\n`);
        }
      }
    }
    printed = entries.length;
  };

  let current = job;
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
    process.stderr.write(`${outStyle.dim(`[coder] task=${job.id} status=${current.status}`)}\n`);
  }
  process.exit(current.status === 'completed' ? 0 : 1);
}
