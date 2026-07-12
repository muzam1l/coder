/**
 * Data-driven help. Task operations live under the `coder task <subcommand>`
 * namespace; several have top-level shortcut aliases (coder run/list/result/
 * stream). Specs are keyed by their canonical id ('task run', 'task
 * list', 'config', ...) so both the namespace and the shortcuts render the same
 * page.
 */
import { outStyle } from './ui.js';
import { readVersion } from './runtime.js';
import type { CommandHelpSpec, HelpRow, Style } from './types.js';

// Shared flag descriptions. task run and task steer accept the same run flags.
export const TASK_FLAGS: HelpRow[] = [
  ['--wait', 'run in the foreground and block until the answer is ready'],
  ['--agent <codex|claude>', 'engine to use (default: first in the configured chain)'],
  ['--model <alias|slug>', 'spark/luna/terra/sol (codex) · opus/sonnet/fable (claude)'],
  ['--effort <low|medium|high>', 'reasoning effort'],
  ['--permissions <mode>', 'read-only · workspace-write · auto (default: auto)'],
  ['--resume <task-id>', "continue that task's thread instead of a fresh run"],
  ['--json', 'machine-readable JSON output'],
];
const CWD_FLAG: HelpRow = ['--cwd <dir>', 'workspace directory (default: current)'];
const JSON_FLAG: HelpRow = ['--json', 'JSON output'];

// Task subcommands in display order. `alias` is the top-level shortcut (if any).
export const TASK_MENU: { sub: string; usage: string; blurb: string; alias?: string }[] = [
  {
    sub: 'run',
    usage: 'run "<text>"',
    blurb: 'run a task (background; --wait blocks)',
    alias: 'run',
  },
  { sub: 'list', usage: 'list', blurb: 'list running tasks (--all for all)', alias: 'list' },
  {
    sub: 'result',
    usage: 'result [task-id]',
    blurb: 'status + final answer (--wait blocks)',
    alias: 'result',
  },
  {
    sub: 'stream',
    usage: 'stream [task-id]',
    blurb: 'watch a task live (progress log)',
    alias: 'stream',
  },
  { sub: 'steer', usage: 'steer <task-id> "<follow-up>"', blurb: "continue a task's thread" },
  { sub: 'stop', usage: 'stop <task-id>', blurb: 'interrupt a running task' },
  { sub: 'archive', usage: 'archive <task-id>', blurb: 'archive a session (or --all-stopped)' },
  { sub: 'delete', usage: 'delete <task-id>', blurb: 'delete a session (or --all-archived)' },
  { sub: 'approvals', usage: 'approvals <task-id>', blurb: 'list escalated approvals' },
  { sub: 'approve', usage: 'approve <task-id> <id>', blurb: 'answer an escalated permission' },
];

// Detailed specs, keyed by canonical id.
export const COMMAND_HELP: Record<string, CommandHelpSpec> = {
  'task run': {
    list: ['task run "<text>"', 'run a coding task (background; --wait blocks)'],
    usage: 'coder task run [flags] "<task text>"',
    summary:
      'Dispatch a coding task to the configured engine. Backgrounds by default and\nprints a task id; --wait runs in the foreground and prints the answer.\nShortcut: `coder run "<text>"`.',
    flags: [['--name <name>', 'label the task (shown in list/result)'], ...TASK_FLAGS, CWD_FLAG],
    examples: [
      ['coder run "add a /health endpoint"', 'dispatch in the background, print a task id'],
      ['coder run --wait "fix the failing test"', 'block until done, print the answer'],
      ['coder task run --model spark "rename foo to bar"', 'pick an engine via its model alias'],
    ],
    seeAlso: 'task result · task steer · task stop · task stream',
  },
  'task list': {
    list: ['task list [--all|--stopped|--archived]', 'list tasks (running by default)'],
    usage: 'coder task list [--all] [--stopped] [--archived]',
    summary:
      'List tasks across all workspaces, most recent first. Shows running tasks by\ndefault; --all adds finished tasks, --stopped shows only finished ones, and\n--archived opens the archive. Archived tasks stay out of --all. Shortcut: `coder list`.',
    flags: [
      ['--all', 'show running and finished tasks (archived excluded)'],
      ['--stopped', 'show only finished tasks (completed/failed/cancelled)'],
      ['--archived', 'show only archived tasks'],
      ['--dir <dir>', 'only tasks launched in that workspace'],
      JSON_FLAG,
    ],
    seeAlso: 'task result · task archive · task delete',
  },
  'task result': {
    list: ['task result [task-id]', 'status + final answer of a task'],
    usage: 'coder task result [task-id]',
    summary:
      "Show a task's status and its final answer (result pending while it runs), plus\nany pending approvals. --wait blocks until it finishes, then prints. Defaults to\nthe most recent task. Shortcut: `coder result`.",
    flags: [['--wait', 'block until the task finishes, then print'], JSON_FLAG, CWD_FLAG],
    seeAlso: 'task list · task steer · task stream',
  },
  'task stream': {
    list: ['task stream [task-id]', 'watch a task live (progress log)'],
    usage: 'coder task stream [task-id]',
    summary:
      "Watch a running task's progress log live (for you/debugging), then print its\nfinal answer. Starts from the current point; --tail <n> replays the last n lines\nfirst (--tail all for the whole transcript). Blocks until it finishes; exits 0 on\nsuccess, 1 otherwise. For the answer alone, prefer `coder result`.",
    flags: [
      ['--tail <n|all>', 'replay the last n log lines first (default: 0)'],
      ['--json', 'emit each log entry as a JSON line, then the result'],
      CWD_FLAG,
    ],
    examples: [['coder stream', 'follow the most recent task to completion']],
    seeAlso: 'task result · task run',
  },
  'task steer': {
    list: ['task steer <task-id> "<follow-up>"', "continue a task's thread"],
    usage: 'coder task steer <task-id> "<follow-up instructions>" [--wait]',
    summary:
      "Continue a finished task's thread with new instructions. Reuses the task's\nengine, model, and permissions unless you override them.",
    flags: [
      ['--wait', 'run in the foreground and block until the answer is ready'],
      ['--model <alias|slug>', "override the task's model for this follow-up"],
      ['--effort <low|medium|high>', "override the task's reasoning effort"],
      ['--permissions <mode>', 'read-only · workspace-write · auto'],
      CWD_FLAG,
    ],
    examples: [
      ['coder task steer coder-abc "now add tests"', 'continue that task with a follow-up'],
    ],
    seeAlso: 'task run · task stop',
  },
  'task stop': {
    list: ['task stop <task-id>', 'interrupt a running task'],
    usage: 'coder task stop <task-id>',
    summary: 'Interrupt a running task and mark it cancelled.',
    flags: [JSON_FLAG, CWD_FLAG],
    seeAlso: 'task result · task steer',
  },
  'task archive': {
    list: ['task archive <task-id> | --all-stopped', 'hide a task (or all stopped) from the list'],
    usage: 'coder task archive <task-id> | coder task archive --all-stopped',
    summary:
      'Archive a task session so it drops out of the default list (see it again with\n`coder task list --archived`). Pass --all-stopped to archive every finished task.',
    flags: [['--all-stopped', 'archive every stopped (finished) task'], JSON_FLAG, CWD_FLAG],
    seeAlso: 'task list · task delete',
  },
  'task delete': {
    list: ['task delete <task-id> | --all-archived', 'delete a task session (or all archived)'],
    usage: 'coder task delete <task-id> | coder task delete --all-archived',
    summary:
      "Delete a task's session from disk. This is permanent. Pass --all-archived to\ndelete every archived task at once. A running task must be stopped first.",
    flags: [['--all-archived', 'delete every archived task'], JSON_FLAG, CWD_FLAG],
    seeAlso: 'task archive · task stop',
  },
  'task approvals': {
    list: ['task approvals <task-id>', 'list escalated approvals'],
    usage: 'coder task approvals <task-id>',
    summary: 'List permission escalations a task has raised, and how each was answered.',
    flags: [JSON_FLAG, CWD_FLAG],
    seeAlso: 'task approve',
  },
  'task approve': {
    list: ['task approve <task-id> <id> [--deny]', 'answer an escalated permission'],
    usage: 'coder task approve <task-id> <approval-id> [--deny]',
    summary: 'Answer an escalated permission request. Accepts by default; --deny rejects it.',
    flags: [['--deny', 'reject the request instead of accepting'], JSON_FLAG, CWD_FLAG],
    seeAlso: 'task approvals · task result',
  },
  config: {
    list: ['config [get|set|unset] <key> [value]', 'read or write config'],
    usage: 'coder config [get|set|unset] <key> [value] [--workspace]',
    summary:
      'Read or write configuration. No args prints the effective config; get/set/unset\ntarget a dotted key (e.g. agents.codex.model). Writes go to ~/.coder/config.json.',
    flags: [
      ['--workspace', 'target <repo>/coder.config.json instead of the user file'],
      JSON_FLAG,
      CWD_FLAG,
    ],
    examples: [
      ['coder config', 'print the effective config'],
      ['coder config set chain codex,claude', 'set the engine fallback chain'],
      ['coder config get agents.codex.model', 'read one value'],
    ],
  },
  'host-setup': {
    list: [
      'host-setup [--claude|--codex]',
      'set up the host: check engines, write config, install plugin',
    ],
    usage: 'coder host-setup [--claude] [--codex] [--json]',
    summary:
      'Set up coder in your host (Claude Code or Codex): check engine availability and\nauth, seed the config, and optionally install the host plugin for Claude Code\n(--claude) or Codex (--codex). (Formerly `setup`, still accepted as an alias.)',
    flags: [
      ['--claude', 'install the Claude Code plugin'],
      ['--codex', 'install the Codex plugin'],
      ['--json', 'machine-readable output'],
    ],
  },
  upgrade: {
    list: [
      'upgrade [--cli-only|--plugins-only]',
      'update the CLI and host plugins (alias: update)',
    ],
    usage: 'coder upgrade [--cli-only] [--plugins-only] [--codex] [--claude] [--pm <mgr>]',
    summary:
      'Update the coder CLI through whichever package manager installed it, then refresh\nthe host plugins to match. Alias: update.',
    flags: [
      ['--cli-only', 'update just the CLI'],
      ['--plugins-only', 'refresh just the host plugins'],
      ['--codex', 'limit plugin refresh to Codex'],
      ['--claude', 'limit plugin refresh to Claude Code'],
      ['--pm <npm|pnpm|yarn|bun>', 'force a package manager instead of auto-detecting'],
    ],
  },
};

// Top-level tokens (shortcuts and back-compat) -> canonical spec id.
export const HELP_ALIASES: Record<string, string> = {
  run: 'task run',
  list: 'task list',
  stream: 'task stream',
  watch: 'task stream',
  result: 'task result',
  steer: 'task steer',
  stop: 'task stop',
  archive: 'task archive',
  delete: 'task delete',
  approvals: 'task approvals',
  approve: 'task approve',
  setup: 'host-setup',
  update: 'upgrade',
};

function renderFlags(flags: HelpRow[], style: Style): string[] {
  return flags.map(([flag, desc]) => `  ${style.cyan(flag.padEnd(30))}${style.dim(desc)}`);
}

// `coder <command> --help` / `coder task <sub> --help`. Null for unknown ids.
export function renderCommandHelp(id: string): string | null {
  const spec = COMMAND_HELP[id];
  if (!spec) {
    return null;
  }
  const s = outStyle;
  const lines = [s.bold('Usage:'), `  ${spec.usage}`];
  if (spec.summary) {
    lines.push('', spec.summary);
  }
  if (spec.flags?.length) {
    lines.push('', s.bold('Flags:'), ...renderFlags(spec.flags, s));
  }
  if (spec.examples?.length) {
    lines.push('', s.bold('Examples:'));
    for (const [cmd, desc] of spec.examples) {
      lines.push(`  ${s.cyan(cmd)}`, `    ${s.dim(desc)}`);
    }
  }
  if (spec.seeAlso) {
    lines.push('', s.dim(`Related: ${spec.seeAlso}`));
  }
  return `${lines.join('\n')}\n`;
}

// `coder task` / `coder task --help`: the task-namespace overview.
export function renderTaskGroupHelp(): string {
  const s = outStyle;
  const rows = TASK_MENU.map(m => {
    const alias = m.alias ? s.dim(`  (coder ${m.alias})`) : '';
    return `  ${s.cyan(m.usage.padEnd(30))}${s.dim(m.blurb)}${alias}`;
  });
  return `${[
    s.bold('Usage:'),
    '  coder task <subcommand> [flags]',
    '',
    s.bold('Subcommands:'),
    ...rows,
    '',
    s.dim("Run 'coder task <subcommand> --help' for details on any subcommand."),
  ].join('\n')}\n`;
}

// Top-level `coder` / `coder help` / `coder --help`.
export function renderTopHelp(): string {
  const s = outStyle;
  const row = ([left, right]: HelpRow) => `  ${s.cyan(left.padEnd(38))}${s.dim(right)}`;
  // Top-level command rows: the task subcommands that have a shortcut alias,
  // shown under their alias (e.g. `tasks`, not `task list`).
  const shortcutRows = TASK_MENU.filter(m => m.alias).map(m =>
    row([m.usage.replace(/^\S+/, m.alias!), m.blurb]),
  );
  const moreSubs = TASK_MENU.filter(m => !m.alias)
    .map(m => m.sub)
    .join(', ');
  return `${[
    `${s.bold('Coder')} ${s.dim(`v${readVersion()}`)}`,
    'Delegate a coding task to the best available engine and steer it while it runs.',
    '',
    s.bold('Get started:'),
    `  ${s.cyan('coder host-setup --claude')}   ${s.dim('# or --codex; installs the host plugin')}`,
    `  ${s.cyan('coder run "explain this repo\'s layout"')}`,
    '',
    s.bold('Usage:'),
    '  coder <command> [flags]',
    '',
    s.bold('Commands:'),
    ...shortcutRows,
    `  ${s.dim(`More task commands (${moreSubs}): `)}${s.cyan('coder task --help')}`,
    row(COMMAND_HELP.config!.list),
    row(COMMAND_HELP.upgrade!.list),
    '',
    s.bold('Global:'),
    row(['-h, --help', 'show help (top-level, or for a command)']),
    row(['-v, --version', 'print the coder version']),
    row(['--json', 'JSON output instead of human-readable text']),
    row(CWD_FLAG),
  ].join('\n')}\n`;
}

// A help flag counts only before a `--` passthrough, so a literal "--help" in
// task text (coder task run -- "... --help ...") is not mistaken for a request.
export function wantsHelp(argv: string[]): boolean {
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  return head.includes('-h') || head.includes('--help');
}
