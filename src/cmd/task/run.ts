/** `coder task run` (also `coder run`): dispatch a task, in the background or waiting for its answer. */
import process from 'node:process';

import type { TokenUsage } from '../../core/types';
import type { TaskStatus } from '../../server/store/types';
import { keyRows, section } from '../../tui/help';
import { errStyle, formatHints, formatTokens, outStyle } from '../../tui/output';
import { baseOptions, flag, optStr, str, strList } from '../../utils/args';
import { TASK_FLAGS } from '.';
import { command, MODEL_HINT } from '../../cli';
import { printOutcome } from './result';
import { printLine } from './watch';

export function taskRunNextSteps(taskId: string): string {
  const rows = keyRows(
    [
      {
        usage: `coder task result ${taskId} --wait`,
        blurb: 'run in a background shell; returns with the answer or a pending approval',
      },
      {
        usage: `coder task steer ${taskId} "<follow-up>"`,
        blurb: "steer the task with a message (use 'ask' without interrupting main thread)",
      },
      { usage: `coder task stop ${taskId}`, blurb: 'stop the task' },
      { usage: 'coder task list', blurb: 'recent tasks' },
      { usage: 'coder task --help', blurb: 'all task commands' },
    ],
    outStyle,
    outStyle.blue,
  );
  return [
    ...section('Next step', rows.slice(0, 1), outStyle),
    ...section('Related', rows.slice(1), outStyle),
  ].join('\n');
}

/** Without --wait: the id and the commands to manage it. */
function printStarted(taskId: string, status: string): void {
  process.stdout.write(
    `${outStyle.dim('[coder]')} task ${outStyle.blue(taskId)} started in the background (${status}).\n`,
  );
  process.stdout.write(`${taskRunNextSteps(taskId)}\n`);
}

/** With --wait: the banner before blocking, and what Ctrl-C leaves running. */
function printWaiting(taskId: string): void {
  process.stderr.write(
    `${outStyle.dim('[coder]')} Task ${outStyle.cyan(taskId)} started and is waiting to finish. Press Ctrl-C to detach. It keeps running.\n`,
  );
  process.stderr.write(`${taskRunNextSteps(taskId)}\n`);
}

function printDetached(taskId: string): void {
  process.stderr.write(
    `\n${outStyle.dim('[coder] Detached. The task is still running.')}\n\n${formatHints([`Wait for the answer: coder task result ${taskId} --wait`], errStyle)}\n`,
  );
}

/** A finished --wait run: the answer, then its status line. */
function printFinished(done: {
  taskId: string;
  status: string;
  finalMessage?: string | null;
  error?: string;
  tokens?: TokenUsage | null;
  model?: string | null;
}): void {
  // Blank lines around the answer so it stands apart from the [coder] chrome.
  process.stdout.write(
    `\n${done.finalMessage || (done.error ? `${outStyle.red('error:')} ${done.error}` : '(no final message)')}\n\n`,
  );
  const tokensNote = done.tokens ? ` tokens=${formatTokens(done.tokens, done.model)}` : '';
  process.stderr.write(
    `${outStyle.dim(`[coder] task=${done.taskId} status=${done.status}${tokensNote}`)}\n`,
  );
}

export const commandTask = command({
  name: 'task run',
  help: {
    usage: 'coder task run "<task text>"',
    summary: `Dispatch a coding task to the configured engine. Backgrounds by default and\nprints a task id; --wait runs in the foreground and prints the answer.\nShortcut: \`coder run "<text>"\`.\n\nWriting a task: one task per focused goal, independent goals as parallel runs.\nThe worker starts with nothing but the text, so include the goal, file paths,\nconstraints and any context only you have. Delegate rather than doing the work\nyourself first, however small it looks.\n\n${MODEL_HINT}`,
    flags: [
      ['--output-schema <json>', 'JSON Schema for the task answer'],
      ['--name <name>', 'label the task (shown in list/result)'],
      [
        '--agent <id>',
        'run as that agent: its system.md, engine settings, MCP servers and flows; flags override them',
      ],
      [
        '--system <text>',
        'standing instructions prepended to the task (kept out of prompt previews)',
      ],
      ...TASK_FLAGS,
      [
        '--server [url] [--workspace <slug>]',
        'run the task on your Coder server and follow it here (--background prints its id); --resume continues a finished server task',
      ],
      ['--repo <owner/name>', "with --server: check out a repo from the workspace's installs"],
      ['--runner <name>', 'with --server: where it runs (a runner kind or a registered runner)'],
    ],
    exitCodes: [
      ['0', 'The task started, or --wait printed a successful answer.'],
      ['1', 'Dispatch or the task failed.'],
      ['3', 'No engine could start; follow fallback.instructions in the JSON payload.'],
      ['4', 'An approval is pending; answer it, then run result --wait again.'],
      ['130', 'The foreground wait was detached and the task is still running.'],
    ],
    examples: [
      ['coder run "add a /health endpoint"', 'dispatch in the background, print a task id'],
      ['coder result <task-id> --wait', 'then block until it finishes and print the answer'],
      ['coder run --wait "fix the failing test"', 'or block on the run itself'],
      [
        'coder task run --model luna --system "tests live in test/, don\'t touch anything outside of it" "rename foo to bar"',
        'pick an engine via its model alias; --system adds standing instructions',
      ],
      [
        'coder task run --agent reviewer "review the last commit"',
        'run a repo agent from .coder/agents/reviewer',
      ],
      [
        'coder run --add-dir ../api --add-dir ../shared "update the client for the new endpoint"',
        'let the task reach sibling repos too',
      ],
    ],
  },
  options: {
    ...baseOptions,
    agent: str,
    'output-schema': str,
    engine: str,
    model: str,
    effort: str,
    permissions: str,
    resume: str,
    // Older plugin skills still pass --host; every engine now runs through the runtime's own CLI path.
    host: str,
    name: str,
    system: str,
    mcp: str,
    'add-dir': strList,
    background: flag,
    wait: flag,
    'simulate-approval': flag,
    server: optStr,
    workspace: str,
    yes: flag,
    repo: str,
    runner: str,
  },
  args: Number.POSITIVE_INFINITY,
  async run({ options, args }) {
    const { tasks } = await import('../../core/task');

    const json = options.json;
    let waiting: string | undefined;
    process.on('SIGINT', () => {
      if (waiting) printDetached(waiting);
      process.exit(130);
    });
    return tasks.run(args.join(' ').trim(), {
      cwd: options.cwd,
      agent: options.agent,
      outputSchema: options['output-schema'] ? JSON.parse(options['output-schema']) : undefined,
      engine: options.engine,
      model: options.model,
      effort: options.effort,
      permissions: options.permissions,
      name: options.name,
      system: options.system,
      resume: options.resume,
      mcp: options.mcp,
      addDirs: options['add-dir'],
      // A server task is followed until it ends unless --background; a local one only with --wait.
      wait: options.server !== undefined ? !options.background : options.wait,
      simulateApproval: options['simulate-approval'],
      repo: options.repo,
      runner: options.runner,
      server: options.server,
      yes: options.yes,
      organization: options.workspace,
      onFallback: ({ engine, detail, next }) =>
        process.stderr.write(
          `[coder] ${engine} failed to start (${detail}); falling back to ${next}.\n`,
        ),
      onNote: note => process.stderr.write(`[coder] ${note}\n`),
      onWaiting: taskId => {
        waiting = taskId;
        if (!json) printWaiting(taskId);
      },
      onLog: line =>
        json
          ? process.stdout.write(`${JSON.stringify(line, null, 2)}\n`)
          : printLine(line, outStyle),
    });
  },
  print(done, { options }) {
    if ('attempts' in done) {
      if (options.background) return void process.stdout.write(`${done.task.id}\n`);
      return printOutcome(done as TaskStatus, outStyle);
    }
    if (options.wait) printFinished(done);
    else printStarted(done.taskId, done.status);
  },
  exit: (done, { options }) =>
    ('attempts' in done ? !options.background : options.wait)
      ? done.status === 'completed'
        ? 0
        : 1
      : undefined,
});
