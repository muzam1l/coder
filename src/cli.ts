#!/usr/bin/env node
/**
 * The Coder CLI: the router over the command tree in ./cmd, plus the helpers every command is built with.
 * A command is one contextjsx definition: argv parsing, help, docs, skills and `coder mcp` all come from it.
 */
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import {
  defineCommand,
  defineNamespace,
  jsx,
  type Access,
  type Args,
  type Command,
  type Namespace,
  type Next,
  type Shape,
} from 'contextjsx';
import { parse, ParseError, resolve, walk } from 'contextjsx/emit';

import {
  DEFAULT_SERVER,
  isKnownServer,
  rememberServer,
  validateServer,
} from './client/auth/session';
import { TOP_HELP } from './cmd/help';
import { actionLines } from './core/approvals';
import { CoderError, type FallbackPayload } from './core/dispatch';
import { CLI_PATH, readVersion } from './core/runtime';
import { newerVersion } from './core/update-check';
import {
  flagRow,
  keyRows,
  renderCommandHelp,
  renderGroupHelp,
  renderTopHelp as renderTop,
  wantsHelp,
} from './tui/help';
import { bad, errStyle, fail, formatHints, good, outStyle, printJson } from './tui/output';
import { canPrompt, pick, PromptCancelled } from './tui/prompt';
import { flag, serverSuffix, str } from './utils/args';

export const MODEL_HINT =
  'Use luna or sonnet for mechanical work; sol or opus is the default.\nUse astra or fable for the hardest work; they cost the most.';

const GLOBALS = {
  json: flag('JSON output'),
  cwd: str('workspace directory; default current', '<dir>'),
};

type Globals = typeof GLOBALS;

type Flags = {
  json?: boolean;
  cwd?: string;
  server?: string | true;
  workspace?: string;
  yes?: boolean;
};

export type CommandInput<S extends Shape> = {
  options: Args<S & Globals>;
  /** Positional values in order, a last list spread. */
  args: string[];
  cwd: string;
  /** Run as an MCP tool: no terminal output, the result is the answer. */
  tool: boolean;
  /** Render this command's next steps at a live CLI boundary. */
  next(result: unknown, display?: HintDisplay): void;
};

type HintDisplay = {
  layout?: 'plain' | 'rows' | 'inline' | 'good' | 'bad';
  slot?: string;
  hidden?: boolean;
  title?: string;
  stream?: 'stderr';
  style?: 'stdout';
  force?: boolean;
  prefix?: string;
  dim?: boolean;
  paint?: 'cyan';
};

export type CommandNext = Next & { cli?: HintDisplay & { text?: string } };

/** Keep a CLI hint's spelling while exposing its command and explanation to MCP. */
export function nextSteps(lines: string[], display?: HintDisplay): CommandNext[] {
  return lines.map(text => {
    const at = text.search(/(?:\b[A-Z][A-Z0-9_]*=\S+\s+)*coder /);
    return {
      usage: at < 0 ? '' : text.slice(at),
      blurb: at < 0 ? text : text.slice(0, at).trim().replace(/:$/, ''),
      cli: { ...display, text },
    };
  });
}

function printNext(steps: CommandNext[], display: HintDisplay = {}): void {
  steps = steps.filter(step => !step.cli?.hidden && step.cli?.slot === display.slot);
  const rows = keyRows(
    steps.map(step => ({
      ...step,
      blurb: step.cli?.layout === 'rows' ? (step.cli.text ?? step.blurb) : step.blurb,
    })),
    outStyle,
    outStyle.blue,
  );
  for (let at = 0; at < steps.length;) {
    const { text: _text, ...first } = steps[at]!.cli ?? {};
    const style = { ...first, ...display };
    let end = at + 1;
    while (end < steps.length) {
      const { text: _nextText, ...other } = steps[end]!.cli ?? {};
      if (JSON.stringify({ ...other, ...display }) !== JSON.stringify(style)) break;
      end++;
    }
    const stream = style.stream === 'stderr' ? process.stderr : process.stdout;
    const s = style.stream === 'stderr' && style.style !== 'stdout' ? errStyle : outStyle;
    const lines = steps
      .slice(at, end)
      .map(step => step.cli?.text ?? `${step.blurb}: ${step.usage}`);
    const body =
      style.layout === 'plain'
        ? style.dim
          ? s.dim(lines.join('\n'))
          : lines.join('\n')
        : style.layout === 'good' || style.layout === 'bad'
          ? lines.map(style.layout === 'good' ? good : bad).join('\n')
          : style.layout === 'inline'
            ? steps
                .slice(at, end)
                .map(step => `${s.bold(step.usage)}  ${s.dim(step.blurb)}`)
                .join('\n')
            : style.layout === 'rows'
              ? [s.bold(`${style.title ?? 'Related'}:`), ...rows.slice(at, end)].join('\n')
              : formatHints(lines, s, style.paint === 'cyan' ? s.cyan : s.blue, style.title);
    stream.write(`${style.prefix ?? '\n'}${body}\n`);
    at = end;
  }
}

/** A contextjsx command that also runs as the CLI on argv. */
export type CoderCommand = Command & ((argv: string[]) => Promise<void>);

/** A contextjsx group that also routes argv to its commands. */
export type CoderGroup = Namespace & ((argv: string[]) => Promise<void>);

const loginHint = (server: string) =>
  server === DEFAULT_SERVER
    ? 'Sign in: coder auth login'
    : `Sign in: coder auth login --server ${server}`;

/** A Coder server used for the first time is confirmed once, then remembered. */
export async function confirmServer(
  option: string | true | undefined,
  yes = false,
): Promise<string> {
  const server = validateServer(option);
  if (isKnownServer(server)) return server;
  if (!yes) {
    if (!canPrompt())
      throw new CoderError(
        'invalid-option',
        `First use of Coder server ${new URL(server).origin} needs confirmation.`,
        {
          hint: 'Inspect the origin, then repeat with --yes.',
        },
      );
    const selected = await pick({
      title: `Connect to ${new URL(server).origin}?`,
      hint: 'This server can receive task and agent data.',
      options: [
        { value: 'yes', label: 'Continue' },
        { value: 'no', label: 'Cancel' },
      ],
    });
    if (selected[0] !== 'yes')
      throw new CoderError('invalid-option', 'Server connection cancelled.');
  }
  rememberServer(server);
  return server;
}

function printFallback(payload: FallbackPayload): void {
  process.stderr.write(
    '[coder] No engine could start. Follow fallback.instructions with a native subagent.\n',
  );
  printJson(payload);
}

// read-only leans on the OS sandbox; if it cannot start, the mode itself is
// unavailable here. Reported (exit 1) rather than chained.
function readOnlyUnavailable(detail: string, json = false): never {
  const hint =
    'read-only unavailable on this host: the OS sandbox failed to start ' +
    '(Linux/WSL2 needs bubblewrap + socat). Re-dispatch with --permissions auto ' +
    '(or workspace-write) if writes are acceptable, or install the sandbox deps.';
  if (json) {
    printJson({ error: hint, code: 'read-only-unavailable', detail });
  } else {
    process.stderr.write(`[coder] ${hint}\n`);
  }
  process.exit(1);
}

// Exit code for "a --wait stopped because the task is waiting on an approval."
// Coder-specific 4 is deliberately not 2. Two is the conventional CLI usage-error code.
const EXIT_APPROVAL_NEEDED = 4;

function approvalNext(
  cwd: string,
  taskId: string,
  approval: NonNullable<CoderError['approval']>,
  flags: Flags,
) {
  const server = serverSuffix(flags);

  return nextSteps([
    `Approve: coder task approve ${taskId} ${approval.id}${server}`,
    `Deny: coder task approve ${taskId} ${approval.id} --deny --reason "<why>"${server}`,
    `Then wait again in its own background shell, one per task: coder task result ${taskId} --wait${server}`,
    'The decision reaches the task as a message, any time.',
  ]);
}

function toolError(output: unknown, steps: CommandNext[]): Error {
  const result = typeof output === 'object' && output !== null ? output : { result: output };

  return new Error(
    JSON.stringify({
      ...result,
      next: steps.map(({ usage, blurb }) => ({ usage, blurb })),
    }),
  );
}

// Surface a pending approval hit during a --wait, then exit so a background
// host caller is re-invoked to answer it (`coder task approve`) and re-wait, instead
// of blocking silently until the worker's configured auto-decline timeout.
function surfaceApproval(
  cwd: string,
  taskId: string,
  approval: NonNullable<CoderError['approval']>,
  flags: Flags,
): never {
  if (flags.json) {
    printJson({ taskId, status: 'awaiting-approval', approval });
  } else {
    const hints = approvalNext(cwd, taskId, approval, flags).map(step => step.cli!.text!);
    process.stdout.write(`Approval needed for task ${taskId}: ${approval.reason}\n`);
    process.stdout.write(`${actionLines(approval.actions)}\n`);
    process.stderr.write(`\n${formatHints(hints, errStyle, errStyle.blue, 'Next steps')}\n`);
  }
  process.exit(EXIT_APPROVAL_NEEDED);
}

/** How the CLI shows a typed failure: its exit code, output and next steps. */
function report(error: CoderError, cwd: string, options: Flags): never {
  switch (error.code) {
    case 'chain-exhausted':
      printFallback(error.payload!);
      process.exit(3);
    case 'read-only-unavailable':
      readOnlyUnavailable(error.message, options.json);
    case 'approval-pending':
      surfaceApproval(cwd, error.taskId!, error.approval!, options);
    case 'startup-failed':
      if (options.json) {
        printJson({ taskId: error.taskId, status: 'failed', detail: error.message });
        process.exit(1);
      }
      fail(`Task ${error.taskId} failed to start.${error.message ? `\n${error.message}` : ''}`, {
        hint: `See: coder task result ${error.taskId}`,
      });
    case 'login-failed':
      fail(error.message, {
        hint: [
          loginHint(validateServer(options.server)),
          'Or, for a memory server, set the same ADMIN_TOKEN it was started with',
        ],
      });
    case 'server':
      fail(error.message, {
        hint:
          error.hint ??
          (error.status === 401 ? loginHint(validateServer(options.server)) : undefined),
      });
    default:
      fail(error.message, error.hint ? { hint: error.hint } : {});
  }
}

export function command<S extends Shape, R>(spec: {
  name: string;
  /** One paragraph: help's description, the docs line and the MCP tool description. */
  description: string;
  /** Further paragraphs, kept as written. */
  usage?: string;
  access: Access;
  args?: S;
  cli?: Command<S & Globals>['cli'];
  globalFlags?: { json?: false; cwd?: false };
  mcp?: false;
  run(input: CommandInput<S>): Promise<R> | R;
  /** Human output. */
  print?(result: R, input: CommandInput<S>): unknown;
  afterNext?(result: R, input: CommandInput<S>): unknown;
  /** What `--json` prints and a tool returns, when not the result itself. */
  json?(result: R, input: CommandInput<S>): unknown;
  next?(input: { result: R; args: Args<S & Globals> }): CommandNext[];
  /** The exit code the result means, in both outputs. */
  exit?(result: R, input: CommandInput<S>): number | undefined;
}): CoderCommand {
  const globals = Object.entries(GLOBALS).filter(
    ([name]) => spec.globalFlags?.[name as keyof Globals] !== false,
  );
  const shape = { ...spec.args, ...Object.fromEntries(globals) } as S & Globals;
  const positional: string[] = spec.cli?.positional ?? [];
  const input = (options: Args<S & Globals>, tool: boolean): CommandInput<S> => {
    const { cwd } = options as Flags;
    const values = options as Record<string, string | string[] | undefined>;

    return {
      options,
      args: positional.flatMap(name => values[name] ?? []),
      cwd: cwd ? path.resolve(cwd) : process.cwd(),
      tool,
      next(result, display) {
        if (!tool && (!(options as Flags).json || display?.force))
          printNext(spec.next?.({ result: result as R, args: options }) ?? [], display);
      },
    };
  };
  const call = async (given: CommandInput<S>) => {
    const flags = given.options as Flags;
    if (flags.server !== undefined) await confirmServer(flags.server, flags.yes);
    return spec.run(given);
  };

  const definition = defineCommand({
    name: spec.name,
    description: spec.description,
    ...(spec.usage ? { usage: spec.usage } : {}),
    access: spec.access,
    args: shape,
    ...(spec.cli ? { cli: spec.cli } : {}),
    ...(spec.mcp === false ? { mcp: false as const } : {}),
    ...(spec.mcp === false
      ? {}
      : {
          mcp: {
            text: (result: { value: R; output: unknown }) =>
              typeof result.output === 'string'
                ? result.output
                : (JSON.stringify(result.output) ?? ''),
          },
        }),
    async run(options) {
      const given = input(options, true);
      let result: R;
      try {
        result = await call(given);
      } catch (error) {
        if (
          error instanceof CoderError &&
          error.code === 'approval-pending' &&
          error.taskId &&
          error.approval
        )
          throw toolError(
            { taskId: error.taskId, status: 'awaiting-approval', approval: error.approval },
            approvalNext(given.cwd, error.taskId, error.approval, given.options as Flags),
          );
        throw error;
      }
      const output = spec.json ? spec.json(result, given) : result;
      // contextjsx marks thrown tool failures as isError and preserves their message.
      if (spec.exit?.(result, given))
        throw toolError(output, spec.next?.({ result, args: options }) ?? []);
      // Keep the raw result for next(), even when JSON omits presentation metadata.
      return { value: result, output };
    },
    next: ({ result, args }) => spec.next?.({ result: result.value, args }) ?? [],
  });

  const invoke = async (argv: string[]) => {
    let options: Args<S & Globals>;
    try {
      options = parse(definition, argv);
    } catch (error) {
      if (!(error instanceof ParseError)) throw error;
      const { cli } = await import('./cmd');
      const parts = walk(cli).commands.find(entry => entry.command.run === definition.run)
        ?.path ?? [spec.name];
      throw new CoderError('invalid-option', error.message, {
        hint: `Help: coder ${parts.join(' ')} --help`,
      });
    }
    const given = input(options, false);

    let result: R;
    try {
      result = await call(given);
    } catch (error) {
      if (error instanceof CoderError) report(error, given.cwd, given.options as Flags);
      throw error;
    }

    if ((options as Flags).json && result !== undefined)
      printJson(spec.json ? spec.json(result, given) : result);
    else {
      const printing = spec.print?.(result, given);
      // Keep synchronous hints ahead of progress queued by the printer.
      if (printing && typeof (printing as PromiseLike<unknown>).then === 'function') await printing;
      given.next(result);
      await spec.afterNext?.(result, given);
    }
    const code = spec.exit?.(result, given);
    if (code !== undefined) process.exitCode = code;
  };
  Object.defineProperty(invoke, 'name', { value: spec.name, writable: true, enumerable: true });

  return Object.assign(invoke, definition) as CoderCommand;
}

/** A command group: `coder <group> <sub>` routes to its commands; the work is in them. */
export function group({
  usage,
  ...spec
}: Omit<Namespace, 'usage'> & { usage?: string }): CoderGroup {
  const invoke = async (argv: string[]): Promise<void> => {
    const { cli } = await import('./cmd');
    const parts = walk(cli).namespaces.find(
      entry => entry.namespace.name === spec.name && entry.namespace.commands === spec.commands,
    )?.path ?? [spec.name];

    return dispatch([...parts, ...argv]);
  };
  Object.defineProperty(invoke, 'name', { value: spec.name, writable: true, enumerable: true });

  return Object.assign(invoke, defineNamespace({ ...spec, ...(usage ? { usage } : {}) }));
}

/** Commands that engines and detached processes run, loaded alone: never listed, never tools. */
const INTERNAL: Record<string, () => Promise<CoderCommand>> = {
  'task worker': async () => (await import('./cmd/task/worker')).commandWorker,
  'task mcp': async () => (await import('./cmd/task/mcp')).commandTaskMcp,
  'task hook': async () => (await import('./cmd/task/hook')).commandTaskHook,
  'task tools': async () => (await import('./cmd/task/tools')).commandTools,
  'task tools-search': async () => (await import('./cmd/task/tools-search')).commandToolsSearch,
  'flow drive': async () => (await import('./cmd/flow/drive')).commandDrive,
  'upgrade refresh': async () => (await import('./cmd/upgrade/refresh')).commandRefreshUpdate,
};

type Found = NonNullable<ReturnType<typeof resolve>>;

/** The command or group argv names, top-level shortcuts expanded. */
async function find(words: string[]): Promise<Found | undefined> {
  const { cli, SHORTCUTS } = await import('./cmd');
  const shortcut = SHORTCUTS[words[0]!];

  return resolve(cli, shortcut ? [...shortcut, ...words.slice(1)] : words);
}

async function render(found: Found): Promise<string> {
  const { cli, SHORTCUTS } = await import('./cmd');
  if ('command' in found) return renderCommandHelp(found.command, cli);

  return renderGroupHelp(found.namespace, cli, SHORTCUTS);
}

/** Help for a command or group id such as `task run`, or null when there is none. */
export async function renderHelp(id: string): Promise<string | null> {
  const found = await find(id.split(' '));

  return found && !found.rest.length ? render(found) : null;
}

export const renderTopHelp = () =>
  renderTop(
    {
      ...TOP_HELP,
      globals: [
        { usage: '-h, --help', blurb: 'show help (top-level, or for a command)' },
        { usage: '-v, --version', blurb: 'print the coder version' },
        ...Object.entries(GLOBALS).map(([name, schema]) => flagRow(name, schema)),
      ],
    },
    readVersion(),
  );

/** Run one Coder command line: help, a group's menu, an internal command or a command. */
export async function dispatch(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;

  if (first === '--version' || first === '-v') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  // Top-level help: `coder`, `coder help [topic]`, `coder --help`, `coder -h`.
  if (first === undefined || first === 'help' || first === '--help' || first === '-h') {
    const found = rest.length ? await find(rest) : undefined;
    return void process.stdout.write(found ? await render(found) : renderTopHelp());
  }

  const id = argv.slice(0, 2).join(' ');
  // Passive, non-blocking update notice. Skip internal and MCP commands so the
  // detached refresher never re-triggers itself and stdio servers stay quiet.
  if (!INTERNAL[id] && first !== 'mcp') {
    const latest = newerVersion(readVersion(), CLI_PATH);
    if (latest)
      process.stderr.write(
        errStyle.dim(`coder ${readVersion()} -> `) +
          errStyle.bold(latest) +
          errStyle.dim(' available. run: coder upgrade\n\n'),
      );
  }
  if (INTERNAL[id]) return (await INTERNAL[id]())(argv.slice(2));

  const found = await find(argv);
  if (!found) {
    process.stdout.write(renderTopHelp());
    process.stdout.write('\n');
    fail(`Unknown command "${first}".`, { hint: 'See all commands: coder --help' });
  }
  if ('namespace' in found) {
    const [sub] = found.rest;
    const name = found.path.join(' ');
    process.stdout.write(await render(found));
    if (sub && !['help', '-h', '--help'].includes(sub))
      fail(`Unknown ${name} subcommand "${sub}".`, { hint: `Help: coder ${name} --help` });
    return;
  }
  if (wantsHelp(found.rest)) return void process.stdout.write(await render(found));

  await (found.command as CoderCommand)(found.rest);
}

/** Run the CLI on `process.argv`. */
export function main(): Promise<void> {
  // A downstream pipe closing early (`coder ... | head`) is a normal way to stop
  // reading. Exit quietly instead of crashing with an EPIPE stack trace.
  process.stdout.on('error', err => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
    throw err;
  });
  return dispatch(process.argv.slice(2)).catch(error => {
    if (error instanceof PromptCancelled) process.exit(130);
    if (error instanceof CoderError && error.hint) fail(error.message, { hint: error.hint });
    // Wrapped errors (drizzle's "Failed query") only make sense with their cause.
    const cause =
      error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : '';
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}${cause}\n`);
    process.exit(1);
  });
}

// Run directly (this file in development, or dist/cli.js, whose code the bundle moves into a chunk beside it); bin/coder.mjs calls main() itself.
const entry = process.argv[1] && pathToFileURL(process.argv[1]).href;
if (entry && [import.meta.url, new URL('./cli.js', import.meta.url).href].includes(entry))
  void main();
