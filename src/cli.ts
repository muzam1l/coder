#!/usr/bin/env node
/**
 * The Coder CLI: the router over the command tree in ./cmd, plus the helpers every command is built with.
 * A command parses argv, runs one core call and prints the result (JSON with `--json`); a group routes to its subcommands.
 */
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

import * as z from 'zod/mini';

import {
  DEFAULT_SERVER,
  isKnownServer,
  rememberServer,
  validateServer,
} from './client/auth/session';
import { COMMANDS, TOP_HELP } from './cmd';
import { loadConfig } from './core/config';
import { CoderError, type FallbackPayload } from './core/dispatch';
import { CLI_PATH, readVersion } from './core/runtime';
import type { CommandHandler, CommandHelpSpec, HelpRow } from './core/types';
import { newerVersion } from './core/update-check';
import {
  renderCommandHelp,
  renderGroupHelp,
  renderTopHelp as renderTop,
  wantsHelp,
  type GroupHelpSpec,
} from './tui/help';
import { errStyle, fail, formatHints, printJson } from './tui/output';
import { canPrompt, pick, PromptCancelled } from './tui/prompt';
import { parseArgs } from './utils/args';

export const MODEL_HINT =
  'Use luna or sonnet for mechanical work; sol or opus is the default.\nUse astra or fable for the hardest work; they cost the most.';

const GLOBAL_FLAGS: Record<'json' | 'cwd', HelpRow> = {
  json: ['--json', 'JSON output'],
  cwd: ['--cwd <dir>', 'workspace directory (default: current)'],
};

export const SERVER_FLAG: HelpRow = [
  '--server [url] [--workspace <slug>]',
  'act on your Coder server; --workspace overrides the saved workspace for this command',
];

export const CREDENTIAL_SERVER_FLAG: HelpRow = [
  '--server [url]',
  'act on your Coder server, in the saved workspace',
];

export type CliCommand = CommandHandler & {
  commandName?: string;
  help?: CommandHelpSpec;
  groupHelp?: GroupHelpSpec;
  subcommands?: Record<string, Load>;
};

export type Load = () => Promise<CliCommand>;

export type CommandInput<S extends z.core.$ZodShape> = {
  options: z.output<z.ZodMiniObject<S>>;
  args: string[];
  cwd: string;
};

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

// Resolve the workspace for commands that accept --cwd.
function resolveCwd(options: { cwd?: unknown }): string {
  return options.cwd ? path.resolve(String(options.cwd)) : process.cwd();
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

// Surface a pending approval hit during a --wait, then exit so a background
// host caller is re-invoked to answer it (`coder task approve`) and re-wait, instead
// of blocking silently until the worker's configured auto-decline timeout.
function surfaceApproval(
  cwd: string,
  taskId: string,
  approval: { id: string; summary: string; cwd?: string | null; networkHost?: string | null },
  json = false,
): never {
  if (json) {
    printJson({ taskId, status: 'awaiting-approval', approval });
  } else {
    const timeoutSeconds = loadConfig(cwd).approvals.escalationTimeoutMs / 1000;
    const hints = [
      `Approve: coder task approve ${taskId} ${approval.id}`,
      `Deny: coder task approve ${taskId} ${approval.id} --deny`,
      `Then wait again: coder task result ${taskId} --wait`,
      `Unanswered approvals auto-deny after ${timeoutSeconds} seconds.`,
    ];
    if (approval.networkHost) {
      hints.push(
        `Network access to ${approval.networkHost} can be pre-approved with approvals.allowedNetworkHosts.`,
      );
    }
    process.stdout.write(`Approval needed for task ${taskId}: ${approval.summary}\n`);
    if (approval.cwd) {
      process.stdout.write(`Runs in: ${approval.cwd}\n`);
    }
    process.stderr.write(`\n${formatHints(hints, errStyle, errStyle.blue, 'Next steps')}\n`);
  }
  process.exit(EXIT_APPROVAL_NEEDED);
}

/** How the CLI shows a typed failure: its exit code, output and next steps. */
function report(
  error: CoderError,
  cwd: string,
  options: { json?: boolean; server?: string | true },
): never {
  switch (error.code) {
    case 'chain-exhausted':
      printFallback(error.payload!);
      process.exit(3);
    case 'read-only-unavailable':
      readOnlyUnavailable(error.message, options.json);
    case 'approval-pending':
      surfaceApproval(cwd, error.taskId!, error.approval!, options.json);
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

export function command<S extends z.core.$ZodShape, R>(spec: {
  /** The command's words, such as `task stop`, for its help and error hints. */
  name: string;
  helpName?: string;
  globalFlags?: { json?: false; cwd?: false };
  help?: CommandHelpSpec;
  options: S;
  /** The most positional arguments it takes. */
  args?: number;
  run(input: CommandInput<S>): Promise<R> | R;
  /** Human output. */
  print?(result: R, input: CommandInput<S>): void;
  /** What `--json` prints, when not the result itself. */
  json?(result: R, input: CommandInput<S>): unknown;
  /** The exit code the result means, in both outputs. */
  exit?(result: R, input: CommandInput<S>): number | undefined;
}): CliCommand {
  return Object.assign(
    async (argv: string[]) => {
      const { options, positionals } = parseArgs(argv, z.object(spec.options), {
        positionals: spec.args ?? 0,
        command: spec.name,
      });
      const input = { options, args: positionals, cwd: resolveCwd(options) };
      const flags = options as { json?: boolean; server?: string | true; yes?: boolean };

      let result: R;
      try {
        if (flags.server !== undefined) await confirmServer(flags.server, flags.yes);
        result = await spec.run(input);
      } catch (error) {
        if (error instanceof CoderError) report(error, input.cwd, flags);
        throw error;
      }

      if (flags.json && result !== undefined)
        printJson(spec.json ? spec.json(result, input) : result);
      else await spec.print?.(result, input);
      const code = spec.exit?.(result, input);
      if (code !== undefined) process.exitCode = code;
    },
    {
      commandName: spec.helpName ?? spec.name,
      help: spec.help && {
        ...spec.help,
        globalFlags: (Object.keys(GLOBAL_FLAGS) as (keyof typeof GLOBAL_FLAGS)[])
          .filter(name => spec.globalFlags?.[name] !== false)
          .map(name => GLOBAL_FLAGS[name]),
      },
    },
  );
}

/** A command group: routes `coder <group> <sub>` and prints its help; the work is in the subcommands. */
export function group(
  name: string,
  subcommands: Record<string, Load>,
  groupHelp?: GroupHelpSpec,
  {
    aliases = {},
    nested = [],
    hint = `Help: coder ${name} --help`,
    help,
  }: {
    aliases?: Record<string, string>;
    // Subcommands that are groups themselves and route their own help.
    nested?: string[];
    hint?: string;
    help?: CommandHelpSpec;
  } = {},
): CliCommand {
  return Object.assign(
    async (argv: string[]) => {
      const [sub, ...rest] = argv;
      if (!sub || sub === 'help' || sub === '-h' || sub === '--help')
        return void process.stdout.write((await renderHelp(name))!);

      const load = subcommands[sub];
      if (!load) {
        process.stdout.write((await renderHelp(name))!);
        fail(`Unknown ${name} subcommand "${sub}".`, { hint });
      }
      if (!nested.includes(sub) && wantsHelp(rest)) {
        const id = `${name} ${aliases[sub] ?? sub}`;
        return void process.stdout.write(
          renderCommandHelp(id, await getCommandHelp(id)) ?? (await renderHelp(name))!,
        );
      }

      await (
        await load()
      )(rest);
    },
    { commandName: name, help, groupHelp, subcommands },
  );
}

async function findCommand(id: string): Promise<CliCommand | undefined> {
  const [name, ...words] = id.split(' ');
  const load = COMMANDS[name!];
  if (!load) return undefined;
  let handler = await load();
  for (const word of words) {
    const child = handler.subcommands?.[word];
    if (!child) return undefined;
    handler = await child();
  }
  return handler;
}

export async function getCommandHelp(id: string): Promise<CommandHelpSpec | undefined> {
  const handler = await findCommand(id);
  return handler && (handler.commandName === id || COMMANDS[id]) ? handler.help : undefined;
}

export async function renderHelp(id: string): Promise<string | null> {
  const handler = await findCommand(id);
  if (!handler) return null;
  if (!handler.groupHelp) return renderCommandHelp(handler.commandName ?? id, handler.help);
  const spec = handler.groupHelp;
  return renderGroupHelp(id, spec.menu, {
    ...spec,
    ...(spec.details
      ? {
          description: [handler.help!.summary!],
          examples: handler.help!.examples,
          seeAlso: handler.help!.seeAlso,
        }
      : {}),
    ...(spec.exampleCommand
      ? { examples: (await getCommandHelp(spec.exampleCommand))?.examples }
      : {}),
  });
}

export const renderTopHelp = () =>
  renderTop(
    {
      ...TOP_HELP,
      globals: [
        { usage: '-h, --help', blurb: 'show help (top-level, or for a command)' },
        { usage: '-v, --version', blurb: 'print the coder version' },
        ...Object.values(GLOBAL_FLAGS).map(([usage, blurb]) => ({ usage, blurb })),
      ],
    },
    readVersion(),
  );

// Groups route their own subcommand help.
const GROUP_HELP = new Set([
  'task',
  'model',
  'flow',
  'agent',
  'server',
  'runner',
  'auth',
  'credentials',
]);

async function route(): Promise<void> {
  const [subcommand, ...argv] = process.argv.slice(2);

  if (subcommand === '--version' || subcommand === '-v') {
    process.stdout.write(`${readVersion()}\n`);
    return;
  }

  // Top-level help: `coder`, `coder help [topic]`, `coder --help`, `coder -h`.
  if (
    subcommand === undefined ||
    subcommand === 'help' ||
    subcommand === '--help' ||
    subcommand === '-h'
  ) {
    // `coder help <group>` -> its overview; `coder help <cmd>` -> its page.
    const group = argv[0] && GROUP_HELP.has(argv[0]);
    if (group && argv[1] === undefined)
      return void process.stdout.write((await renderHelp(argv[0]!))!);
    for (const words of [argv.slice(0, 3), argv.slice(0, 2), ...argv.map(token => [token])]) {
      const id = words.join(' ');
      const spec = await getCommandHelp(id);
      if (spec) {
        const handler = await findCommand(id);
        process.stdout.write(renderCommandHelp(handler!.commandName!, spec)!);
        return;
      }
    }
    process.stdout.write(renderTopHelp());
    return;
  }

  // Passive, non-blocking update notice. Skip internal/refresh commands so the
  // detached refresher never re-triggers itself.
  if (
    ![
      'task worker',
      'task archive-sweep',
      'mcp serve',
      'agent tools',
      'upgrade refresh',
      'update refresh',
    ].includes(`${subcommand} ${argv[0]}`)
  ) {
    const latest = newerVersion(readVersion(), CLI_PATH);
    if (latest)
      process.stderr.write(
        errStyle.dim(`coder ${readVersion()} -> `) +
          errStyle.bold(latest) +
          errStyle.dim(' available. run: coder upgrade\n\n'),
      );
  }

  const load = COMMANDS[subcommand];
  if (!load) {
    process.stdout.write(renderTopHelp());
    process.stdout.write('\n');
    fail(`Unknown command "${subcommand}".`, {
      hint: 'See all commands: coder --help',
    });
  }

  if (!GROUP_HELP.has(subcommand) && wantsHelp(argv)) {
    const handler = await load();
    process.stdout.write(
      renderCommandHelp(handler.commandName ?? subcommand, handler.help) ?? renderTopHelp(),
    );
    return;
  }

  try {
    await (
      await load()
    )(argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // parseArgs throws "Unknown option ..." or "Missing value ...". Steer the
    // user to that command's help rather than a bare stack trace.
    if (/^(Unknown option|Missing value)/.test(message)) {
      if (await getCommandHelp(subcommand)) {
        fail(message, { hint: `Help: coder ${subcommand} --help` });
      }
    }
    if (error instanceof CoderError && error.hint) fail(error.message, { hint: error.hint });
    throw error;
  }
}

/** Run the CLI on `process.argv`. */
export function main(): Promise<void> {
  // A downstream pipe closing early (`coder ... | head`) is a normal way to stop
  // reading. Exit quietly instead of crashing with an EPIPE stack trace.
  process.stdout.on('error', err => {
    if ((err as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
    throw err;
  });
  return route().catch(error => {
    if (error instanceof PromptCancelled) process.exit(130);
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
