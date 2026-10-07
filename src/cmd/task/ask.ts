/** `coder task ask`: ask about a task in a read-only sidecar without interrupting it. */
import process from 'node:process';

import { outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { idAndText } from './steer';

const serverOptions = { server: optStr, workspace: str, yes: flag };

type Answered = { answer: string | null; error?: string; ok: boolean };

export const commandAsk = command({
  name: 'task ask',
  help: {
    usage: 'coder task ask <task-id> "<question>" [--server [url]]',
    summary:
      "Answer a question ABOUT a task without touching it: a read-only sidecar reads\nthe task's progress log, result, and workspace and answers; the task never\nsees the question and its thread is not steered. Works whether the task is\nrunning or stopped. To change what the task does, use `coder task steer`.",
    flags: [
      ['--model <alias|slug>', "sidecar model (default: the task's own)"],
      ['--effort <low|medium|high>', 'sidecar reasoning effort'],
      SERVER_FLAG,
    ],
    examples: [
      [
        'coder task ask task-abc "what approach did you take and why?"',
        'probe a decision without derailing the task',
      ],
    ],
  },
  options: { ...baseOptions, model: str, effort: str, ...serverOptions },
  args: Number.POSITIVE_INFINITY,
  async run({ options, args }) {
    const { tasks } = await import('../../core/task');

    const { id, text } = idAndText(args, 'Missing task id or question.', [
      'Usage: coder task ask <task-id> "<question>"',
      'Help: coder task ask --help',
    ]);
    return tasks.ask(id, text, {
      ...options,
      organization: options.workspace,
      onAsking: taskId =>
        options.json ||
        process.stderr.write(
          `${outStyle.dim('[coder]')} asking about task ${outStyle.cyan(taskId)} (read-only sidecar; the task is not interrupted)...\n`,
        ),
    });
  },
  json: ({ ok: _ok, ...answer }) => answer,
  print(result, { options, args: [id] }) {
    if (options.server !== undefined)
      return void process.stdout.write(`Asked server task ${outStyle.cyan(id!)}.\n`);
    const { answer, error } = result as Answered;
    if (answer) process.stdout.write(`\n${answer}\n`);
    else
      process.stdout.write(
        `${outStyle.dim('(no answer)')}${error ? ` ${outStyle.red(error)}` : ''}\n`,
      );
  },
  exit: (result, { options }) =>
    options.server === undefined ? ((result as Answered).ok ? 0 : 1) : undefined,
});
