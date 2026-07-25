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
  [
    '--agent <codex|claude|custom>',
    'engine to use; custom runs your configured custom models (default: first in the chain)',
  ],
  [
    '--model <alias|slug>',
    'spark/luna/terra/sol (codex) · opus/sonnet/fable (claude) · a custom model (coder model list)',
  ],
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
  {
    sub: 'list',
    usage: 'list',
    blurb: 'list recent tasks (running + just stopped)',
    alias: 'list',
  },
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
    usage: 'coder task run "<task text>"',
    summary:
      'Dispatch a coding task to the configured engine. Backgrounds by default and\nprints a task id; --wait runs in the foreground and prints the answer.\nShortcut: `coder run "<text>"`.',
    flags: [
      ['--name <name>', 'label the task (shown in list/result)'],
      [
        '--system <text>',
        'standing instructions prepended to the task (kept out of prompt previews)',
      ],
      ...TASK_FLAGS,
      CWD_FLAG,
    ],
    examples: [
      ['coder run "add a /health endpoint"', 'dispatch in the background, print a task id'],
      ['coder run --wait "fix the failing test"', 'block until done, print the answer'],
      [
        'coder task run --model spark --system "tests live in test/, don\'t touch anything outside of it" "rename foo to bar"',
        'pick an engine via its model alias; --system adds standing instructions',
      ],
    ],
    seeAlso: 'task result · task steer · task stop · task stream',
  },
  'task list': {
    list: [
      'task list [--running|--stopped|--archived]',
      'list recent tasks (running + just stopped)',
    ],
    usage: 'coder task list [--running] [--stopped] [--archived [--limit N]]',
    summary:
      'List recent tasks across all workspaces, most recent first: running tasks plus\nones stopped within the last 10 minutes. Older stopped tasks auto-archive and\nmove to --archived. Shortcut: `coder list`.',
    flags: [
      ['--running', 'show only running tasks'],
      ['--stopped', 'show only recently stopped tasks (not yet archived)'],
      ['--archived', 'show only archived tasks (auto-archived or via task archive)'],
      ['--limit <n|all>', 'show at most n tasks (default all)'],
      ['--dir <dir>', 'only tasks launched in that workspace'],
      JSON_FLAG,
    ],
    seeAlso: 'task result · task archive · task delete',
  },
  'task result': {
    list: ['task result [task-id]', 'status + final answer of a task'],
    usage: 'coder task result [task-id]',
    summary:
      "Show a task's status and its final answer (result pending while it runs), plus\nany pending approvals. --wait blocks until it finishes, then prints. --tail <n>\nincludes the last n progress-log steps (--tail all for the whole transcript).\nDefaults to the most recent task. Shortcut: `coder result`.",
    flags: [
      ['--wait', 'block until the task finishes, then print'],
      ['--tail <n|all>', 'include the last n progress-log steps (default: 0, final result only)'],
      JSON_FLAG,
      CWD_FLAG,
    ],
    seeAlso: 'task list · task steer · task stream',
  },
  'task stream': {
    list: ['task stream [task-id]', 'watch a task live (progress log)'],
    usage: 'coder task stream [task-id]',
    summary:
      "Watch a running task's progress log live (for you/debugging), then print its\nfinal answer. Replays the last line first so the current step is visible;\n--tail <n> replays the last n lines (--tail all for the whole transcript).\nBlocks until it finishes; exits 0 on success, 1 otherwise. For the answer\nalone, prefer `coder result`.",
    flags: [
      ['--tail <n|all>', 'replay the last n log lines first (default: 1)'],
      ['--trim <n|none>', 'cap each step at n chars, text and JSON alike (default: 128)'],
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
      ['coder task steer task-abc "now add tests"', 'continue that task with a follow-up'],
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
      'Archive a task session so it drops out of the default list (see it again with\n`coder task list --archived [--limit N]`). Pass --all-stopped to archive every\nfinished task.',
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
  'flow run': {
    list: [
      'flow run <name|path> [--args | key=value...]',
      'run a flow (orchestrate a wave of tasks)',
    ],
    usage:
      "coder flow run <name|path> [--args '<json>' | key=value...] [--wait] [--concurrency N] [--max-tasks N] [--json] [--dry-run]",
    summary:
      'Run a flow: a TypeScript file that orchestrates many coder tasks with gates,\njournaling, and resume. Prints the run id and orchestrates in the background;\n--wait follows the run in the foreground with live progress (Ctrl-C detaches;\nit keeps running), and `coder flow stream` shows the same lines any time.\nStop a run with `coder flow stop`.',
    flags: [
      ['--wait', 'follow the run in the foreground (Ctrl-C detaches; it keeps running)'],
      ['--args <json>', "the flow's input as a JSON value (or pass bare key=value pairs)"],
      ['--concurrency <n>', 'tasks running at once (default: CPU count)'],
      ['--max-tasks <n>', 'total tasks the run may dispatch (default: CPU count x 10)'],
      ['--dry-run', 'print every resolved prompt and gate command without dispatching'],
      JSON_FLAG,
      CWD_FLAG,
    ],
    examples: [
      ['coder flow run audit-routes --wait', 'run a discovered flow'],
      ['coder flow run ./scratch/one-off.ts --wait', 'run a flow by path'],
      ['coder flow run verify --args \'{"clusters":["a","b"]}\' --wait', 'pass structured input'],
    ],
    seeAlso: 'flow list · flow discover · flow result · flow resume',
  },
  'flow list': {
    list: ['flow list', 'recent flow runs (running + just stopped)'],
    usage: 'coder flow list [--archived] [--limit N] [--json]',
    summary:
      'List recent flow runs, most recent first: running runs plus ones that ended\nwithin the last 10 minutes. Older runs auto-archive and move to --archived.',
    flags: [
      ['--archived', 'show archived runs (auto-archived or via flow archive)'],
      ['--limit <n|all>', 'show at most n runs (default all)'],
      JSON_FLAG,
      CWD_FLAG,
    ],
    seeAlso: 'flow run · flow result · flow resume',
  },
  'flow discover': {
    list: ['flow discover', 'list flows runnable here (workspace + global)'],
    usage: 'coder flow discover [--json]',
    summary:
      'List every flow discoverable from the current directory: workspace flows in\n.coder/flows/ (walking up to the repo root) and global flows in ~/.coder/flows/.',
    flags: [JSON_FLAG, CWD_FLAG],
    seeAlso: 'flow run · flow result',
  },
  'flow result': {
    list: ['flow result [run-id]', 'progress and result of a flow run'],
    usage: 'coder flow result [run-id] [--tail <n|all>] [--json]',
    summary:
      "Show a flow run's status and result, with its tasks, gates, and token ledger.\n--tail <n> caps the step rows (0 for the result alone). Defaults to the most\nrecent run. To watch a run live, prefer `coder flow stream`.",
    flags: [
      ['--tail <n|all>', 'show the last n step rows (default: all; 0 hides them)'],
      JSON_FLAG,
      CWD_FLAG,
    ],
    examples: [['coder flow result --tail 0', "the most recent run's result, no step rows"]],
    seeAlso: 'flow run · flow stream · flow resume',
  },
  'flow stream': {
    list: ['flow stream [run-id]', 'watch a flow run live (replay + follow)'],
    usage: 'coder flow stream [run-id] [--tail <n|all>] [--json]',
    summary:
      'Watch a flow run live: replay its progress lines from the start, then keep\nfollowing while it runs (Ctrl-C detaches; it keeps running). Blocks until it\nfinishes; exits 0 on success, 1 otherwise. Defaults to the most recent run.\nFor the result alone, prefer `coder flow result`.',
    flags: [
      ['--tail <n|all>', 'replay only the last n events first (default: all)'],
      ['--json', 'emit each event as a JSON line, then the result'],
      CWD_FLAG,
    ],
    examples: [['coder flow stream', 'follow the most recent run to completion']],
    seeAlso: 'flow result · flow run',
  },
  'flow stop': {
    list: ['flow stop [run-id]', 'stop a run and its still-running tasks'],
    usage: 'coder flow stop [run-id] [--keep-tasks] [--json]',
    summary:
      'Stop a running flow: signal the orchestrator so it stops dispatching, stamp the\nrun stopped, and stop its still-running tasks. Defaults to the most recent run;\nthe journal stays ready for `coder flow resume`.',
    flags: [
      ['--keep-tasks', "leave the run's still-running tasks running"],
      ['--json', 'print { runId, status, stoppedTasks, keptTasks }'],
    ],
    seeAlso: 'flow resume · flow result',
  },
  'flow resume': {
    list: ['flow resume [run-id]', 'continue a stopped or edited run'],
    usage: 'coder flow resume [run-id] [--wait] [--json] [--dry-run]',
    summary:
      'Re-run a flow from its journal: finished steps replay instantly, the first\nchanged or new step onward runs live. Defaults to the most recent run.\nAccepts the same flags as flow run.',
    flags: [
      ['--wait', 'follow the run in the foreground (Ctrl-C detaches; it keeps running)'],
      ['--concurrency <n>', 'tasks running at once'],
      ['--max-tasks <n>', 'total tasks the run may dispatch'],
      JSON_FLAG,
      CWD_FLAG,
    ],
    examples: [['coder flow resume', 'continue the most recent run']],
    seeAlso: 'flow run · flow result',
  },
  'flow archive': {
    list: ['flow archive <run-id> | --all-stopped', 'hide a run (or all stopped) from the list'],
    usage: 'coder flow archive <run-id> | coder flow archive --all-stopped',
    summary:
      'Archive a flow run so it drops out of the default list (see it again with\n`coder flow list --archived [--limit N]`). Pass --all-stopped to archive every\nfinished run. A running run must be stopped first.',
    flags: [['--all-stopped', 'archive every stopped (finished) run'], JSON_FLAG],
    seeAlso: 'flow list · flow delete',
  },
  'flow delete': {
    list: ['flow delete <run-id> | --all-archived', "delete a run's record (or all archived)"],
    usage: 'coder flow delete <run-id> | coder flow delete --all-archived',
    summary:
      "Delete a flow run's record from disk (its journal, events, and logs). This is\npermanent; the run's tasks are ordinary tasks and are not touched. Pass\n--all-archived to delete every archived run at once. A running run must be\nstopped first.",
    flags: [['--all-archived', 'delete every archived run'], JSON_FLAG],
    seeAlso: 'flow archive · flow stop',
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
  'setup-host': {
    list: [
      'setup-host [claude|codex|agents]',
      'set up the host: check engines, write config, install plugin',
    ],
    usage: 'coder setup-host [claude] [codex] [agents] [--json]',
    summary:
      'Set up coder in your host: check engines and auth, seed the config, and\ninstall the host plugin/skill for the named host(s). Claude Code gets its\nmarketplace plugin; "agents" installs a skill into ~/.agents/skills for\nevery host that reads the Agent Skills standard dir (Codex, Pi, OpenCode,\n...). "codex" is an alias for agents. With no host, checks and seeds.',
    flags: [['--json', 'machine-readable output']],
    examples: [
      ['coder setup-host claude', 'install the Claude Code plugin'],
      [
        'coder setup-host agents',
        'install the skill into ~/.agents/skills (Codex, Pi, OpenCode, ...)',
      ],
    ],
  },
  'model list': {
    list: ['model list', 'list built-ins, custom models, and aliases'],
    usage: 'coder model list [--json]',
    summary:
      'List built-in aliases, configured custom models, and user aliases. Only custom\nmodels are probed. Also the default when `coder model` is run bare.',
    flags: [JSON_FLAG, CWD_FLAG],
    seeAlso: 'model add · model remove',
  },
  'model add': {
    list: [
      'model add <name> --base-url <url> --model <id>',
      'connect a local or third-party model (OpenAI-compatible)',
    ],
    usage: 'coder model add <name> --base-url <url> --model <id> [--env-key VAR]',
    summary:
      'Connect a custom model behind an OpenAI-compatible endpoint (Ollama, LM Studio,\nvLLM, OpenRouter, ...). It currently runs on the codex engine pointed at your\nURL and is usable anywhere a model is: --model <name>, --agent custom, or as an\nagent default in config. Alias: `coder model setup`.',
    flags: [
      ['--base-url <url>', 'OpenAI-compatible API base (e.g. http://localhost:11434/v1)'],
      ['--model <id>', "the provider's model id (e.g. qwen2.5-coder:32b)"],
      ['--env-key <VAR>', 'env var holding the API key (omit for keyless local endpoints)'],
      ['--workspace', 'write to <repo>/coder.config.json instead of the user file'],
      JSON_FLAG,
    ],
    examples: [
      [
        'coder model add qwen --base-url http://localhost:11434/v1 --model qwen2.5-coder:32b',
        'local Ollama model, no key',
      ],
      [
        'coder model add kimi --base-url https://openrouter.ai/api/v1 --model moonshotai/kimi-k2 --env-key OPENROUTER_API_KEY',
        'third-party provider via OpenRouter',
      ],
      ['coder run --model qwen "explain this repo"', 'dispatch a task on it'],
    ],
    seeAlso: 'model list · model update · setup-host · config',
  },
  'model update': {
    list: ['model update <name> [--base-url|--model|--env-key]', 'change a custom model in place'],
    usage: 'coder model update <name> [--base-url <url>] [--model <id>] [--env-key VAR]',
    summary:
      'Update a configured custom model. Only the flags you pass change; the endpoint\nis re-probed and the wire protocol re-detected.',
    flags: [
      ['--base-url <url>', 'new API base'],
      ['--model <id>', 'new provider model id'],
      ['--env-key <VAR>', 'new API-key env var'],
      ['--workspace', 'write to <repo>/coder.config.json instead of the user file'],
      JSON_FLAG,
    ],
    seeAlso: 'model list · model remove',
  },
  'model remove': {
    list: ['model remove <name>', 'delete a custom model'],
    usage: 'coder model remove <name>',
    summary: 'Remove a configured custom model.',
    flags: [['--workspace', 'target <repo>/coder.config.json instead of the user file'], JSON_FLAG],
    seeAlso: 'model list · model add',
  },
  'model disable': {
    list: ['model disable <name>', 'turn off a model (built-in, custom, or alias)'],
    usage: 'coder model disable <name> [--workspace]',
    summary: 'Disable a model - built-in, custom, or alias. Requests for it fail until re-enabled.',
    flags: [['--workspace', 'target <repo>/coder.config.json instead of the user file'], JSON_FLAG],
    seeAlso: 'model enable · model list',
  },
  'model enable': {
    list: ['model enable <name>', 're-enable a disabled model'],
    usage: 'coder model enable <name> [--workspace]',
    summary: 'Re-enable a disabled model.',
    flags: [['--workspace', 'target <repo>/coder.config.json instead of the user file'], JSON_FLAG],
    seeAlso: 'model disable · model list',
  },
  'model alias': {
    list: ['model alias <name> <spec>', 'add or replace a user alias'],
    usage: 'coder model alias <name> <spec> [--workspace]',
    summary:
      'Save an alias for an agent spec, e.g. fast -> codex:spark. An alias may reuse a\nbuilt-in name to override it.',
    flags: [['--workspace', 'target <repo>/coder.config.json instead of the user file'], JSON_FLAG],
    seeAlso: 'model unalias · model list',
  },
  'model unalias': {
    list: ['model unalias <name>', 'remove a user alias'],
    usage: 'coder model unalias <name> [--workspace]',
    summary: 'Remove a user-defined alias.',
    flags: [['--workspace', 'target <repo>/coder.config.json instead of the user file'], JSON_FLAG],
    seeAlso: 'model alias · model list',
  },
  docs: {
    list: ['docs [topic]', 'print bundled documentation (for agents to read)'],
    usage: 'coder docs [topic] [--json]',
    summary:
      "Print bundled documentation. With no topic, list the available topics; with a\ntopic, print that doc's raw markdown to stdout (unstyled, for an agent to\nconsume).",
    flags: [['--json', 'list topics as JSON (bare listing only)']],
    examples: [
      ['coder docs', 'list the available topics'],
      ['coder docs flows', 'print the Flows doc'],
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
      ['--codex', 'limit the refresh to the Agent Skills copy (Codex, Pi, ...)'],
      ['--claude', 'limit the refresh to the Claude Code plugin'],
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
  setup: 'setup-host',
  'host-setup': 'setup-host',
  update: 'upgrade',
};

// Model subcommands in display order, for the `coder model` overview.
const MODEL_MENU: { usage: string; blurb: string }[] = [
  { usage: 'list', blurb: 'list built-ins, custom models, and aliases' },
  {
    usage: 'add <name> --base-url <url> --model <id> [--env-key VAR]',
    blurb: 'connect a model (alias: setup)',
  },
  { usage: 'update <name> [--base-url|--model|--env-key]', blurb: 'change a model in place' },
  { usage: 'remove <name>', blurb: 'delete a custom model' },
  { usage: 'disable <name>', blurb: 'turn off a model (built-in, custom, or alias)' },
  { usage: 'enable <name>', blurb: 're-enable a disabled model' },
  { usage: 'alias <name> <spec>', blurb: 'name a spec, e.g. fast codex:spark' },
  { usage: 'unalias <name>', blurb: 'remove an alias' },
];

// Flow subcommands in display order, for the `coder flow` overview.
const FLOW_MENU: { usage: string; blurb: string }[] = [
  {
    usage: 'run <name|path> [--wait] [--args ...]',
    blurb: 'run a flow in the background (--wait to follow it live)',
  },
  { usage: 'list', blurb: 'recent flow runs (running + just stopped)' },
  { usage: 'discover', blurb: 'list flows runnable here (workspace + global)' },
  { usage: 'result [run-id]', blurb: 'progress and result of a run' },
  { usage: 'stream [run-id]', blurb: 'watch a run live (replay + follow)' },
  { usage: 'stop [run-id]', blurb: 'stop a run and its still-running tasks' },
  { usage: 'resume [run-id]', blurb: 'continue a stopped or edited run' },
  {
    usage: 'archive <run-id> | --all-stopped',
    blurb: 'hide a run (or all stopped) from the list',
  },
  {
    usage: 'delete <run-id> | --all-archived',
    blurb: "delete a run's record (or all archived)",
  },
];

// `coder flow` / `coder flow --help`: the flow-namespace overview.
export function renderFlowGroupHelp(): string {
  const s = outStyle;
  const rows = FLOW_MENU.map(m => `  ${s.cyan(m.usage.padEnd(44))}${s.dim(m.blurb)}`);
  return `${[
    s.bold('Usage:'),
    '  coder flow <subcommand>',
    '',
    'Orchestrate many coder tasks with a plain TypeScript file: dispatch, gates,',
    'concurrency, journaling, and resume. Flows live in .coder/flows/ (workspace)',
    'or ~/.coder/flows/ (global). See `coder docs flows`.',
    '',
    s.bold('Subcommands:'),
    ...rows,
    '',
    s.dim("Run 'coder flow <subcommand> --help' for details on any subcommand."),
  ].join('\n')}\n`;
}

// `coder model --help` / `coder help model`: the model-namespace overview.
export function renderModelGroupHelp(): string {
  const s = outStyle;
  const rows = MODEL_MENU.map(m => `  ${s.cyan(m.usage.padEnd(60))}${s.dim(m.blurb)}`);
  return `${[
    s.bold('Usage:'),
    '  coder model <subcommand>',
    '',
    'Manage the models coder can dispatch to. `add` connects any OpenAI-compatible',
    'endpoint (Ollama, vLLM, OpenRouter, ...) as the custom agent, alongside the',
    'built-in codex/claude models. Name your own shortcuts with `alias`',
    '(e.g. fast -> codex:spark); disable/enable turns any model off and on.',
    '',
    s.bold('Subcommands:'),
    ...rows,
    '',
    s.dim("Run 'coder model <subcommand> --help' for details on any subcommand."),
  ].join('\n')}\n`;
}

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
    '  coder task <subcommand>',
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
  const row = ([left, right]: HelpRow) => `  ${s.cyan(left.padEnd(41))}${s.dim(right)}`;
  // Top-level command rows: the task subcommands that have a shortcut alias,
  // shown under their alias (e.g. `tasks`, not `task list`).
  const shortcutRows = TASK_MENU.filter(m => m.alias).map(m =>
    row([m.usage.replace(/^\S+/, m.alias!), m.blurb]),
  );
  return `${[
    `${s.bold('Coder')} ${s.dim(`v${readVersion()}`)}`,
    'Delegate a coding task to the best available engine and steer it while it runs.',
    '',
    s.bold('Get started:'),
    `  ${s.cyan('coder setup-host claude')}   ${s.dim('# or agents (Codex, Pi, ...); installs the host plugin/skill')}`,
    `  ${s.cyan('coder run "explain this repo\'s layout"')}`,
    '',
    s.bold('Usage:'),
    '  coder <command>',
    '',
    s.bold('Commands:'),
    ...shortcutRows,
    `  ${s.cyan('task <cmd>'.padEnd(41))}${s.dim('more task commands (steer, stop, approve, ...): ')}${s.light('coder task --help')}`,
    `  ${s.cyan('flow <cmd>'.padEnd(41))}${s.dim('orchestrate a wave of tasks: ')}${s.light('coder flow --help')}`,
    row(COMMAND_HELP.config!.list),
    row(['model <list|add|alias|disable>', 'manage models: built-ins, aliases, custom endpoints']),
    row(COMMAND_HELP.docs!.list),
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
