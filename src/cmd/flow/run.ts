/** `coder flow run`: start a run in a detached orchestrator (here with --dry-run), --wait follows it. */
import process from 'node:process';

import * as z from 'zod/mini';

import { CoderError } from '../../core/errors';
import type { RunSummary } from '../../flow/executor';
import type { DetachedRun } from '../../flow/runs';
import type { FlowHooks } from '../../flow/runtime';
import { outStyle } from '../../tui/output';
import { flag, str, strList } from '../../utils/args';
import { command } from '../../cli';
import { FlowStepRenderer, printFollow, printRunSummary, flowNext } from './watch';

// Flags shared by flow run and flow resume.
export const RUN_FLAGS = {
  wait: flag('follow the run in the foreground (Ctrl-C detaches; it keeps running)'),
  args: str("the flow's input as a JSON value (or pass bare key=value pairs)", '<json>'),
  concurrency: str('tasks running at once (default: CPU count)', '<n>'),
  'max-tasks': str('total tasks the run may dispatch (default: CPU count x 10)', '<n>'),
  'dry-run': flag('print every resolved prompt and gate command without dispatching'),
};

// Bare key=value pairs -> object; each value JSON-parsed when it looks like JSON.
function parseKeyValues(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq === -1) {
      throw new CoderError('invalid-option', `Invalid argument "${pair}": expected key=value.`, {
        hint: 'Help: coder flow run --help',
      });
    }
    const key = pair.slice(0, eq);
    const raw = pair.slice(eq + 1);
    try {
      out[key] = JSON.parse(raw);
    } catch {
      out[key] = raw;
    }
  }
  return out;
}

export function parseRunArgs(argsFlag: string | undefined, positionals: string[]): unknown {
  if (argsFlag !== undefined) {
    try {
      return JSON.parse(argsFlag);
    } catch (e) {
      throw new CoderError(
        'invalid-option',
        `Invalid --args JSON: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return positionals.length ? parseKeyValues(positionals) : {};
}

const num = (value?: string): number | undefined => (value ? Number(value) : undefined);

export const runOptions = (
  options: { wait?: boolean; concurrency?: string; 'max-tasks'?: string; 'dry-run'?: boolean },
  cwd: string,
) => ({
  cwd,
  dryRun: options['dry-run'],
  concurrency: num(options.concurrency),
  maxTasks: num(options['max-tasks']),
  detached: true,
  wait: options.wait,
});

// Only a --dry-run drives here, so only it paints live step rows; a tool's stdout is the MCP stream.
export const hooks = (options: { json?: boolean; 'dry-run'?: boolean }, tool: boolean) =>
  options['dry-run'] && !options.json && !tool ? stepHooks() : {};

export const commandRun = command({
  name: 'run',
  description: 'run a flow in the background (--wait to follow it live)',
  usage:
    'Run a flow: a TypeScript file that orchestrates many coder tasks with gates,\njournaling, and resume. Prints the run id and orchestrates in the background;\n--wait follows the run in the foreground with live progress (Ctrl-C detaches;\nit keeps running), and `coder flow watch` shows the same lines any time.\nStop a run with `coder flow stop`.',
  access: 'write',
  approvalPolicy: 'deny',
  args: {
    flow: z.string().check(z.describe('the flow: a discovered name or a path')),
    inputs: strList("the flow's input as bare key=value pairs"),
    ...RUN_FLAGS,
  },
  cli: {
    positional: ['flow', 'inputs'],
    examples: [
      'coder flow run audit-routes --wait  # run a discovered flow',
      'coder flow run ./scratch/one-off.ts --wait  # run a flow by path',
      'coder flow run verify --args \'{"clusters":["a","b"]}\' --wait  # pass structured input',
    ],
  },
  async run({ options, args: [ref, ...rest], cwd, tool, next }) {
    const { startRun } = await import('../../flow/runs');

    const started = await startRun(
      ref,
      {
        ...runOptions(options, cwd),
        args: parseRunArgs(options.args, rest),
      },
      hooks(options, tool),
    );
    return finishRun(started, options, tool, next);
  },
  next: ({ result }) => flowNext(result),
  print: started =>
    started.status === 'running' ? printDetached(started) : printRunSummary(started),
});

/** A tool waits for the same flow completion without printing to its protocol stream or exiting. */
export async function finishRun(
  started: RunSummary | DetachedRun,
  options: { json?: boolean },
  tool: boolean,
  next: (result: unknown) => void,
): Promise<RunSummary | DetachedRun> {
  if (started.status !== 'running' || !started.watch) return started;
  if (!tool) return printFollow(started.watch, options, next);
  for await (const _event of started.watch.events) {
  }
  const final = started.watch.final();
  if (final.status !== 'completed')
    throw new CoderError('flow-failed', final.error ?? `Flow ${final.runId} ${final.status}.`, {
      runId: final.runId,
      hint: `Resume: coder flow resume ${final.runId}`,
    });

  return {
    runId: final.runId,
    name: final.name,
    status: 'completed',
    result: final.result,
    tokens: final.ledger,
    taskCount: final.taskCount,
  };
}

// Live step rows for a run driven in this process (--dry-run; real runs detach).
function stepHooks(): FlowHooks {
  const renderer = new FlowStepRenderer();
  return { onEvent: event => renderer.emit(event) };
}

/** `flow run|resume`: a run handed to its detached orchestrator. */
export function printDetached(run: DetachedRun): void {
  process.stdout.write(
    `${outStyle.dim('[flow]')} run ${outStyle.cyan(run.runId)} started in the background (running).\n`,
  );
}
