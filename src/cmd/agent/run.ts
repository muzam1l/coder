/** `coder agent run <agent> <event.json>`: run an event through an agent; `--task <id>` is the runner's form. */
import process from 'node:process';

import { validateServer } from '../../client/auth/session';
import { formatHints, outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str } from '../../utils/args';
import { command, SERVER_FLAG } from '../../cli';
import { printOutcome } from '../task/result';
import { printLine } from '../task/watch';

const options = {
  ...baseOptions,
  flow: str,
  server: optStr,
  workspace: str,
  wait: flag,
  task: str,
  yes: flag,
};

const commandAgentRunTask = command({
  name: 'agent run --task',
  options,
  run: async ({ options, cwd }) => {
    const { agents } = await import('../../agent');
    return agents.runTask(options.task!, { cwd });
  },
});

const commandAgentRunEvent = command({
  name: 'agent run',
  help: {
    usage:
      'coder agent run <agent> <file> [--server [url] [--wait]] [--flow <name>] [--json] [--cwd <dir>]',
    summary:
      "Run a recorded platform event (AgentEvent JSON) through an agent. With --server it goes through your Coder server exactly like a webhook: real app, tokens, runner, and the reply is posted. Without it the engine runs here on the agent's prompt and this checkout, platform tools off, and the reply is printed.",
    flags: [
      SERVER_FLAG,
      ['--wait', 'with --server: follow the task log here until it finishes, then print the reply'],
      ['--flow <name>', 'override the matched flow'],
    ],
    examples: [
      [
        'coder agent run helper sample-slack-mention.json',
        'offline: print what the agent would reply',
      ],
      ['coder agent run helper event.json --server', 'for real, through the server'],
    ],
  },
  options,
  args: 2,
  run: async ({ options, args: [name, file], cwd }) => {
    const { agents } = await import('../../agent');
    return agents.run(name, file, {
      ...options,
      cwd,
      organization: options.workspace,
      ...(options.json
        ? {}
        : {
            onLog: line => printLine(line, outStyle),
            onDone: status => printOutcome(status, outStyle),
          }),
    });
  },
  json: result => (Array.isArray(result) && result.length === 1 ? result[0] : result),
  print(result, { options }) {
    if (Array.isArray(result)) return;
    if ('tasks' in result) {
      if (!result.tasks.length)
        return void process.stdout.write(
          'The server accepted the event but no agent matched it.\n',
        );
      return void process.stdout.write(
        `${outStyle.bold('Queued on the server')} as task ${result.tasks.join(', ')}.\n\n${formatHints([`Watch it: coder task watch ${result.tasks[0]} --server ${validateServer(options.server)}`], outStyle)}\n`,
      );
    }
    if (result.reply !== undefined) process.stdout.write(`${result.reply.trim()}\n`);
    else if (result.result !== undefined)
      process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`);
  },
});

export const commandAgentRun = Object.assign(
  (argv: string[]) =>
    (argv.some(value => value === '--task' || value.startsWith('--task='))
      ? commandAgentRunTask
      : commandAgentRunEvent)(argv),
  { commandName: 'agent run', help: commandAgentRunEvent.help },
);
