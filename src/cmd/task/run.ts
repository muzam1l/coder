/** `coder task run` (also `coder run`): dispatch a task, in the background or waiting for its answer. */
import process from 'node:process';

import type { Access, TokenUsage } from '../../core/types';
import { formatTokens, outStyle } from '../../tui/output';
import { flag, modelOption, optStr, serverSuffix, str, strList } from '../../utils/args';
import { command, MODEL_HINT } from '../../cli';
import { finalMessageLine, finishedNext, waitingNext } from './result';

export function taskRunNext(
  taskId: string,
  args: { server?: string | true; workspace?: string } = {},
) {
  const wait = waitingNext(
    taskId,
    args,
    'run this in its own background shell, one per task (never wait on several tasks in one call). Returns with the answer or a pending approval.',
  );
  wait.cli = { ...wait.cli, layout: 'rows', title: 'Next step' };
  const flags = serverSuffix(args);
  return [
    wait,
    ...[
      {
        usage: `coder task steer ${taskId} "<follow-up>"${flags}`,
        blurb: "steer the task with a message (use 'ask' without interrupting main thread)",
      },
      { usage: `coder task stop ${taskId}${flags}`, blurb: 'stop the task' },
      { usage: `coder task list${flags}`, blurb: 'recent tasks' },
      { usage: 'coder task --help', blurb: 'all task commands' },
    ].map(step => ({ ...step, cli: { layout: 'rows' as const, title: 'Related' } })),
  ];
}

/** Without --wait: the id and the commands to manage it. */
function printStarted(taskId: string, status: string): void {
  process.stdout.write(
    `${outStyle.dim('[coder]')} task ${outStyle.blue(taskId)} started in the background (${status}).\n`,
  );
}

/** With --wait: the banner before blocking, and what Ctrl-C leaves running. */
function printWaiting(taskId: string): void {
  process.stderr.write(
    `${outStyle.dim('[coder]')} Task ${outStyle.cyan(taskId)} started and is waiting to finish. Press Ctrl-C to detach. It keeps running.\n`,
  );
}

function printDetached(taskId: string): void {
  process.stderr.write(`\n${outStyle.dim('[coder] Detached. The task is still running.')}\n`);
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
    `\n${finalMessageLine({ finalMessage: done.finalMessage ?? undefined }, done.error, '(no final message)')}\n\n`,
  );
  const tokensNote = done.tokens ? ` tokens=${formatTokens(done.tokens, done.model)}` : '';
  process.stderr.write(
    `${outStyle.dim(`[coder] task=${done.taskId} status=${done.status}${tokensNote}`)}\n`,
  );
}

export const commandTask = command({
  name: 'run',
  description: 'run a task (background; --wait blocks)',
  usage: `Dispatch a coding task to the configured engine. Backgrounds by default and\nprints a task id locally or with --server; --wait follows it to the answer.\nShortcut: \`coder run "<text>"\`.\n\nWriting a task: one task per focused goal, independent goals as parallel runs.\nThe worker starts with nothing but the text, so include the goal, file paths,\nconstraints and any context only you have. Delegate rather than doing the work\nyourself first, however small it looks.\n\nWaiting: run \`coder task result <task-id> --wait\` in its own background shell, one\nper task. Never wait on several tasks in one call, or their approvals and answers\nnever reach you one by one.\n\n${MODEL_HINT}`,
  access: 'write',
  args: {
    prompt: strList('the task text'),
    'output-schema': str('JSON Schema for the task answer', '<json>'),
    name: str('label the task (shown in list/result)'),
    agent: str(
      'run as that agent: its system.md, engine settings, MCP servers and flows; flags override them',
      '<id>',
    ),
    'append-system': str(
      "standing instructions appended to Coder's system prompt (kept out of prompt previews)",
      '<text>',
    ),
    wait: flag('follow the task until the answer is ready'),
    model: modelOption(),
    access: str(
      'read-only also restricts platforms and connections; auto lets the engine review what leaves the sandbox (default: auto)',
      '<read-only|auto>',
    ),
    mcp: str(
      'attach MCP servers from `mcp` in .coder/config.json by name (or all), or an inline JSON array [{"name","command","args","env","tools"}]; none by default, all adds your engine\'s own MCP servers',
      '<names|all|json>',
    ),
    connections: str(
      "use only these connections (coder connection list), within the agent's",
      '<ids>',
    ),
    'add-dir': strList(
      'give the task another directory beyond --cwd (repeatable); read-only can only read it, auto can also write',
      '<dir>',
    ),
    server: optStr(
      'run the task on your Coder server and print its id (--wait follows it)',
      '[url]',
    ),
    workspace: str('with --server: the workspace to run in (default: the saved one)', '<slug>'),
    yes: flag('with --server: connect to a server used for the first time without asking'),
    repo: str("with --server: check out a repo from the workspace's installs", '<owner/name>'),
    runner: str('with --server: where it runs (a runner kind or a registered runner)'),
  },
  cli: {
    positional: ['prompt'],
    exit: [
      [0, 'The task started, or --wait printed a successful answer.'],
      [1, 'Dispatch or the task failed.'],
      [3, 'No engine could start; follow fallback.instructions in the JSON payload.'],
      [4, 'An approval is pending; answer it, then run result --wait again.'],
      [130, 'The foreground wait was detached and the task is still running.'],
    ],
    examples: [
      'coder run "add a /health endpoint"  # dispatch in the background, print a task id',
      'coder result <task-id> --wait  # then block until it finishes and print the answer',
      'coder run --wait "fix the failing test"  # or block on the run itself',
      'coder task run --model luna --append-system "tests live in test/, don\'t touch anything outside of it" "rename foo to bar"  # pick an engine via its model alias; --append-system adds standing instructions',
      'coder task run --agent reviewer "review the last commit"  # run a repo agent from .coder/agents/reviewer',
      'coder run --add-dir ../api --add-dir ../shared "update the client for the new endpoint"  # let the task reach sibling repos too',
    ],
  },
  async run({ options, args, tool, next }) {
    const { tasks } = await import('../../core/task');

    const json = options.json;
    let waiting: string | undefined;
    if (!tool)
      process.on('SIGINT', () => {
        if (waiting) {
          printDetached(waiting);
          next({ taskId: waiting, phase: 'detached' }, { stream: 'stderr', force: true });
        }
        process.exit(130);
      });
    return tasks.run(args.join(' ').trim(), {
      cwd: options.cwd,
      agent: options.agent,
      outputSchema: options['output-schema'] ? JSON.parse(options['output-schema']) : undefined,
      model: options.model,
      access: options.access as Access | undefined,
      name: options.name,
      appendSystem: options['append-system'],
      mcp: options.mcp,
      connections: options.connections
        ?.split(',')
        .map(id => id.trim())
        .filter(Boolean),
      addDirs: options['add-dir'],
      wait: Boolean(options.wait),
      repo: options.repo,
      runner: options.runner,
      server: options.server,
      yes: options.yes,
      organization: options.workspace,
      onFallback: ({ model, detail, next }) =>
        process.stderr.write(`[coder] ${model} failed (${detail}); falling back to ${next}.\n`),
      onNote: note => process.stderr.write(`[coder] ${note}\n`),
      onWaiting: taskId => {
        waiting = taskId;
        if (!json && !tool) {
          printWaiting(taskId);
          next({ taskId, phase: 'waiting' }, { stream: 'stderr', style: 'stdout' });
        }
      },
    });
  },
  next({ result: done, args }) {
    const phase = (done as { phase?: string }).phase;
    const taskId = done.taskId;
    if (phase === 'detached')
      return [
        waitingNext(
          taskId,
          args,
          `Wait in its own background shell, one per task: coder task result ${taskId} --wait`,
        ),
      ];
    if (phase === 'waiting') return taskRunNext(taskId, args);
    if (args.wait)
      return finishedNext(taskId, args).map(step => ({
        ...step,
        cli: { ...step.cli, stream: 'stderr' as const },
      }));
    return taskRunNext(taskId, args);
  },
  print(done, { options }) {
    if (options.wait) printFinished(done);
    else printStarted(done.taskId, done.status);
  },
  exit: (done, { options }) =>
    options.wait ? (done.status === 'completed' ? 0 : 1) : undefined,
});
