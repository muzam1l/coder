/** `coder task steer`: send a follow-up to a task, live or by resuming it. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import type { SteerOutcome } from '../../core/task/actions';
import type { TaskStatus } from '../../server/store/types';
import { errStyle, outStyle } from '../../tui/output';
import { flag, serverOptions, str, strList } from '../../utils/args';
import { command, nextSteps } from '../../cli';
import { finishedNext, printOutcome, serverTaskJson, waitingNext } from './result';

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
        `\n${outStyle.dim('[coder] --wait is not available for a queued follow-up.')}\n`,
      );
    return;
  }
  if (!wait) {
    process.stdout.write(
      steered === 'live'
        ? `${outStyle.dim('[coder]')} steered follow-up into running task ${outStyle.cyan(taskId)}.\n`
        : `${outStyle.dim('[coder]')} resumed task ${outStyle.cyan(taskId)} with the follow-up (same thread, same id).\n`,
    );
    return;
  }
  process.stdout.write(`\n${outcome.finalMessage || '(no final message)'}\n\n`);
  process.stderr.write(
    `${outStyle.dim(`[coder] task=${taskId} status=${outcome.status ?? 'unknown'}`)}\n`,
  );
}

export const commandSteer = command({
  name: 'steer',
  description: "continue a task's thread",
  usage:
    "Continue a task's thread with new instructions. They are injected into a live Codex or\nClaude turn at its next tool boundary and queued across a startup or completion race.\nA stopped, finished, or archived task resumes on the same task id. It reuses the\ntask's engine, model, and permissions unless overridden.",
  access: 'write',
  args: {
    'task-id': str('the task to continue'),
    text: strList('the follow-up instructions'),
    wait: flag('run in the foreground and block until the answer is ready'),
    model: str("override the task's model for this follow-up", '<alias|slug>'),
    effort: str("override the task's reasoning effort", '<low|medium|high>'),
    permissions: str('read-only · workspace-write · auto', '<mode>'),
    ...serverOptions,
  },
  cli: {
    positional: ['task-id', 'text'],
    examples: ['coder task steer task-abc "now add tests"  # continue that task with a follow-up'],
  },
  async run({ options, args }) {
    const { tasks } = await import('../../core/task');

    const { id, text } = idAndText(args, 'Missing task id or follow-up text.', [
      'Usage: coder task steer <task-id> "<follow-up>" [--wait]',
      'Help: coder task steer --help',
    ]);
    return tasks.steer(id, text, { ...options, organization: options.workspace });
  },
  json(result, { options }) {
    if ('attempts' in result) return serverTaskJson(result as unknown as TaskStatus);
    const outcome = result as Steered;
    return options.server !== undefined || !options.wait || outcome.steered === 'queued'
      ? result
      : {
          taskId: outcome.taskId,
          status: outcome.status ?? null,
          finalMessage: outcome.finalMessage ?? null,
        };
  },
  next({ result, args }) {
    const outcome = result as Steered;
    if (args.server !== undefined)
      return args.wait && ['completed', 'failed', 'cancelled'].includes(outcome.status ?? '')
        ? finishedNext((result as unknown as TaskStatus).task.id, args)
        : [];
    if (outcome.steered === 'queued' && !args.wait) return [];
    if (args.wait && outcome.steered !== 'queued')
      return finishedNext(outcome.taskId).map(step => ({
        ...step,
        cli: { ...step.cli, stream: 'stderr' as const },
      }));
    return [
      waitingNext(
        outcome.taskId,
        args,
        `Wait in its own background shell, one per task: coder task result ${outcome.taskId} --wait`,
      ),
    ];
  },
  print(result, { options, args: [id] }) {
    if (options.server === undefined) return printSteer(result as Steered, options.wait);
    if (options.wait) return printOutcome(result as unknown as TaskStatus, outStyle);
    process.stdout.write(`Steered server task ${outStyle.cyan(id!)}.\n`);
  },
  exit(result, { options }) {
    const outcome = result as Steered;
    if (options.wait && (options.server !== undefined || outcome.steered !== 'queued'))
      return outcome.status === 'completed' ? 0 : 1;
  },
});
