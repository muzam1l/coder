/** `coder agent run <agent> <event.json>`: run an event through an agent; `--task <id>` is the runner's form. */
import process from 'node:process';

import type { agents } from '../../agent';
import type { TaskStatus } from '../../server/store/types';
import { validateServer } from '../../client/auth/session';
import { outStyle } from '../../tui/output';
import { flag, optStr, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';
import { finishedNext, printOutcome, serverTaskJson } from '../task/result';
import { printLine } from '../task/watch';

export const commandAgentRun = command({
  name: 'run',
  description: 'run a recorded event through an agent, offline or on a server',
  usage:
    "Run a recorded platform event (AgentEvent JSON) through an agent. With --server it goes through your Coder server exactly like a webhook: real app, tokens, runner, and the reply is posted. Without it the engine runs here on the agent's prompt and this checkout, platform tools off, and the reply is printed.",
  access: 'write',
  args: {
    agent: str('the agent id'),
    file: str('the event JSON file'),
    server: optStr('act on your Coder server', '[url]'),
    workspace: str('with --server: the workspace to act in (default: the saved one)', '<slug>'),
    yes: flag('with --server: connect to a server used for the first time without asking'),
    wait: flag('with --server: follow the task log here until it finishes, then print the reply'),
    flow: str('override the matched flow', '<name>'),
    task: str("a runner's form: run that server task here", '<id>'),
  },
  cli: {
    positional: ['agent', 'file'],
    examples: [
      'coder agent run helper sample-slack-mention.json  # offline: print what the agent would reply',
      'coder agent run helper event.json --server  # for real, through the server',
    ],
  },
  run: async ({ options, args: [name, file], cwd, tool, next }) => {
    const { agents } = await import('../../agent');

    if (options.task) return agents.runTask(options.task, { cwd });
    return agents.run(name, file, {
      ...options,
      cwd,
      organization: options.workspace,
      ...(options.json || tool
        ? {}
        : {
            onLog: line => printLine(line, outStyle),
            onDone: status => {
              printOutcome(status, outStyle);
              next(status);
            },
          }),
    });
  },
  json(result) {
    if (!Array.isArray(result)) return result;
    const rows = (result as TaskStatus[]).map(serverTaskJson);
    return rows.length === 1 ? rows[0] : rows;
  },
  next({ result, args }) {
    if (args.task) return [];
    const done = result as Awaited<ReturnType<typeof agents.run>> | TaskStatus;
    if (Array.isArray(done))
      return args.wait
        ? done.flatMap(status =>
            ['completed', 'failed', 'cancelled'].includes(status.status)
              ? finishedNext(status.task.id, args).map(step => ({
                  ...step,
                  cli: { ...step.cli, hidden: true },
                }))
              : [],
          )
        : [];
    if ('attempts' in done) {
      const status = done as TaskStatus;
      return ['completed', 'failed', 'cancelled'].includes(status.status)
        ? finishedNext(status.task.id, args)
        : [];
    }
    return 'tasks' in done && done.tasks.length
      ? nextSteps([
          `Watch it: coder task watch ${done.tasks[0]} --server ${validateServer(args.server)}`,
        ])
      : [];
  },
  print(done, { options }) {
    const result = done as Awaited<ReturnType<typeof agents.run>>;
    if (options.task || Array.isArray(result)) return;
    if ('tasks' in result) {
      if (!result.tasks.length)
        return void process.stdout.write(
          'The server accepted the event but no agent matched it.\n',
        );
      return void process.stdout.write(
        `${outStyle.bold('Queued on the server')} as task ${result.tasks.join(', ')}.\n`,
      );
    }
    if (result.reply !== undefined) process.stdout.write(`${result.reply.trim()}\n`);
    else if (result.result !== undefined)
      process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`);
  },
});
