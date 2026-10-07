/** `coder flow run`: start a run in a detached orchestrator (here with --dry-run), --wait follows it. */
import process from 'node:process';

import { CoderError } from '../../core/dispatch';
import type { DetachedRun } from '../../flow/runs';
import type { FlowHooks } from '../../flow/runtime';
import type { FlowEvent } from '../../flow/types';
import { formatHints, outStyle } from '../../tui/output';
import { baseOptions, flag, str } from '../../utils/args';
import { command } from '../../cli';
import { FlowStepRenderer, printFollow, printRunSummary } from './watch';

// Flags shared by flow run and flow resume.
export const RUN_FLAGS = {
  ...baseOptions,
  args: str,
  wait: flag,
  concurrency: str,
  'max-tasks': str,
  'dry-run': flag,
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
  argv: process.argv.slice(2),
  wait: options.wait,
});

// Only a --dry-run drives here, so only it paints live step rows.
export const hooks = (options: { json?: boolean; 'dry-run'?: boolean }) =>
  options['dry-run'] && !options.json ? stepHooks() : {};

export const commandRun = command({
  name: 'flow run',
  help: {
    usage:
      "coder flow run <name|path> [--args '<json>' | key=value...] [--wait] [--concurrency N] [--max-tasks N] [--json] [--dry-run]",
    summary:
      'Run a flow: a TypeScript file that orchestrates many coder tasks with gates,\njournaling, and resume. Prints the run id and orchestrates in the background;\n--wait follows the run in the foreground with live progress (Ctrl-C detaches;\nit keeps running), and `coder flow watch` shows the same lines any time.\nStop a run with `coder flow stop`.',
    flags: [
      ['--wait', 'follow the run in the foreground (Ctrl-C detaches; it keeps running)'],
      ['--args <json>', "the flow's input as a JSON value (or pass bare key=value pairs)"],
      ['--concurrency <n>', 'tasks running at once (default: CPU count)'],
      ['--max-tasks <n>', 'total tasks the run may dispatch (default: CPU count x 10)'],
      ['--dry-run', 'print every resolved prompt and gate command without dispatching'],
    ],
    examples: [
      ['coder flow run audit-routes --wait', 'run a discovered flow'],
      ['coder flow run ./scratch/one-off.ts --wait', 'run a flow by path'],
      ['coder flow run verify --args \'{"clusters":["a","b"]}\' --wait', 'pass structured input'],
    ],
  },
  options: RUN_FLAGS,
  args: Number.POSITIVE_INFINITY,
  async run({ options, args: [ref, ...rest], cwd }) {
    const { startRun } = await import('../../flow/runs');

    if (!ref) {
      throw new CoderError('invalid-option', 'Missing flow name or path.', {
        hint: ['Usage: coder flow run <name|path>', 'List: coder flow discover'],
      });
    }
    const started = await startRun(
      ref,
      { ...runOptions(options, cwd), args: parseRunArgs(options.args, rest) },
      hooks(options),
    );
    if (started.status === 'running' && started.watch) await printFollow(started.watch, options);
    return started;
  },
  print: started =>
    started.status === 'running' ? printDetached(started) : printRunSummary(started),
});

// Live step rows for a run driven in this process (--dry-run; real runs detach).
function stepHooks(): FlowHooks {
  const renderer = new FlowStepRenderer();
  const line = (e: FlowEvent) => renderer.emit(e);
  return {
    onTaskStart: info => line({ kind: 'task-start', ...info }),
    onTaskEnd: info => line({ kind: 'task-end', ...info }),
    onGateStart: info => line({ kind: 'gate-start', ...info }),
    onGate: info => line({ kind: 'gate', ...info }),
    onLog: (message, depth) => line({ kind: 'log', message, depth }),
    onFlowStart: info => line({ kind: 'flow-start', ...info }),
    onReplay: count => line({ kind: 'replay', count }),
  };
}

/** `flow run|resume`: a run handed to its detached orchestrator. */
export function printDetached(run: DetachedRun): void {
  process.stdout.write(
    `${outStyle.dim('[flow]')} run ${outStyle.cyan(run.runId)} started in the background (running).\n`,
  );
  process.stdout.write(
    `\n${formatHints([`Result: coder flow result ${run.runId}`, 'Runs: coder flow list'], outStyle)}\n`,
  );
}
