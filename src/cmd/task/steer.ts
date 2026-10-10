/** `coder task steer`: send a follow-up to a task, live or by resuming it. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import type { SteerOutcome } from '../../core/task/actions';
import { formatHints, outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';

const serverOptions = { server: optStr, workspace: str, yes: flag };

type Steered = {
  taskId: string;
  steered: SteerOutcome;
  status?: string | null;
  finalMessage?: string | null;
};

/** The task id, then the text: what `steer` and `ask` take. */
export function idAndText(args: string[], missing: string, hint: string[]) {
  const [id, ...words] = args;
  const text = words.join(' ').trim();
  if (!id || !text) throw new CoderError('invalid-option', missing, { hint });
  return { id, text };
}

/** How the follow-up landed, or with --wait its answer. */
function printSteer(outcome: Steered, wait = false): void {
  const { taskId, steered } = outcome;
  if (steered === 'queued') {
    process.stdout.write(
      `${outStyle.dim('[coder]')} follow-up queued for task ${outStyle.cyan(taskId)}; it runs when the current turn finishes.\n`,
    );
    if (wait)
      process.stdout.write(
        `\n${outStyle.dim('[coder] --wait is not available for a queued follow-up.')}\n\n${formatHints([`Wait in its own background shell, one per task: coder task result ${taskId} --wait`], outStyle)}\n`,
      );
    return;
  }
  if (!wait) {
    process.stdout.write(
      steered === 'live'
        ? `${outStyle.dim('[coder]')} steered follow-up into running task ${outStyle.cyan(taskId)}.\n`
        : `${outStyle.dim('[coder]')} resumed task ${outStyle.cyan(taskId)} with the follow-up (same thread, same id).\n`,
    );
    process.stdout.write(
      `\n${formatHints([`Wait in its own background shell, one per task: coder task result ${taskId} --wait`], outStyle)}\n`,
    );
    return;
  }
  process.stdout.write(`\n${outcome.finalMessage || '(no final message)'}\n\n`);
  process.stderr.write(
    `${outStyle.dim(`[coder] task=${taskId} status=${outcome.status ?? 'unknown'}`)}\n`,
  );
}

export const commandSteer = command({
  name: 'task steer',
  help: {
    usage: 'coder task steer <task-id> "<follow-up instructions>" [--wait] [--server [url]]',
    summary:
      "Continue a task's thread with new instructions. They are injected into a live Codex or\nClaude turn at its next tool boundary and queued across a startup or completion race.\nA stopped task resumes on the same task id. It reuses the task's engine, model, and\npermissions unless overridden.",
    flags: [
      ['--wait', 'run in the foreground and block until the answer is ready'],
      ['--model <alias|slug>', "override the task's model for this follow-up"],
      ['--effort <low|medium|high>', "override the task's reasoning effort"],
      ['--permissions <mode>', 'read-only · workspace-write · auto'],
      SERVER_FLAG,
    ],
    examples: [
      ['coder task steer task-abc "now add tests"', 'continue that task with a follow-up'],
    ],
  },
  options: {
    ...baseOptions,
    model: str,
    effort: str,
    permissions: str,
    background: flag,
    wait: flag,
    ...serverOptions,
  },
  args: Number.POSITIVE_INFINITY,
  async run({ options, args }) {
    const { tasks } = await import('../../core/task');

    const { id, text } = idAndText(args, 'Missing task id or follow-up text.', [
      'Usage: coder task steer <task-id> "<follow-up>" [--wait]',
      'Help: coder task steer --help',
    ]);
    return tasks.steer(id, text, { ...options, organization: options.workspace });
  },
  json(result, { options }) {
    const outcome = result as Steered;
    return options.server !== undefined || !options.wait || outcome.steered === 'queued'
      ? result
      : {
          taskId: outcome.taskId,
          status: outcome.status ?? null,
          finalMessage: outcome.finalMessage ?? null,
        };
  },
  print: (result, { options, args: [id] }) =>
    options.server !== undefined
      ? process.stdout.write(`Steered server task ${outStyle.cyan(id!)}.\n`)
      : printSteer(result as Steered, options.wait),
  exit(result, { options }) {
    const outcome = result as Steered;
    if (options.server === undefined && options.wait && outcome.steered !== 'queued')
      return outcome.status === 'completed' ? 0 : 1;
  },
});
