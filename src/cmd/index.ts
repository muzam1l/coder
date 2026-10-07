/** The command tree: each top-level command, loaded only when it runs. */
import type { Load } from '../cli';
import type { TopHelpSpec } from '../tui/help';

const task: Load = async () => (await import('./task')).commandTaskGroup;
const setupHost: Load = async () => (await import('./setup-host')).commandSetupHost;
const server: Load = async () => (await import('./server')).commandServer;
const upgrade: Load = async () => (await import('./upgrade')).commandUpgrade;

export const COMMANDS: Record<string, Load> = {
  task,
  flow: async () => (await import('./flow')).commandFlow,
  // Top-level shortcuts for the common task commands.
  run: async () => (await import('./task/run')).commandTask,
  list: async () => (await import('./task/list')).commandTasks,
  result: async () => (await import('./task/result')).commandResult,
  // Standalone commands.
  config: async () => (await import('./config')).commandConfig,
  'setup-host': setupHost,
  'host-setup': setupHost, // alias for setup-host
  setup: setupHost, // back-compat alias for setup-host
  model: async () => (await import('./model')).commandModel,
  mcp: async () => (await import('./mcp')).commandMcpConfig,
  docs: async () => (await import('./docs')).commandDocs,
  review: async () => (await import('./review')).commandReview,
  agent: async () => (await import('./agent')).commandAgent,
  server,
  dash: async () => {
    const serve = await server();
    const handler = await serve.subcommands!.serve!();
    return Object.assign((argv: string[]) => serve(['serve', ...argv]), {
      commandName: handler.commandName,
      help: handler.help,
    });
  },
  runner: async () => (await import('./runner')).commandRunner,
  auth: async () => (await import('./auth')).commandAuth,
  credentials: async () => (await import('./credentials')).commandCredentials,
  upgrade,
  update: upgrade,
};

export const TOP_HELP: Omit<TopHelpSpec, 'globals'> = {
  title: 'Coder',
  usageLine: 'coder <command>',
  description: 'Delegate a coding task to the best available engine and steer it while it runs.',
  commands: [
    { usage: 'dash', blurb: 'your tasks, agents and settings in the browser' },
    { usage: 'run "<text>"', blurb: 'run a task (background; --wait blocks)' },
    { usage: 'list', blurb: 'list recent tasks (by default running + just stopped)' },
    { usage: 'result [task-id]', blurb: 'status + final answer (--wait blocks)' },
    { usage: 'task <cmd>', blurb: 'run, list, result, watch, steer, stop, approve, ...' },
    { usage: 'flow <cmd>', blurb: 'run, list, watch, result, resume, stop, discover, ...' },
    { usage: 'agent <cmd>', blurb: 'list, show, init, push, run, usage, integrations' },
    { usage: 'credentials <cmd>', blurb: 'engine credentials: list, add, login, remove, default' },
    { usage: 'server <cmd>', blurb: 'self-host Coder: serve, migrate, rotate-key' },
    { usage: 'runner <cmd>', blurb: "run your server's tasks on this machine: serve, list, ..." },
    { usage: 'auth <cmd>', blurb: 'sign in to Coder: login, logout, status' },
    {
      usage: 'review [--base <ref> | --pr <n>]',
      blurb: 'review changed code with a built-in flow',
    },
    { usage: 'config <list|get|set|unset> [<key> [value]]', blurb: 'read or write config' },
    {
      usage: 'model <list|add|alias|disable>',
      blurb: 'manage models: built-ins, aliases, custom endpoints',
    },
    {
      usage: 'mcp <add|add-json|list|rm>',
      blurb: 'MCP servers tasks can attach by name (--mcp <name>)',
    },
    { usage: 'docs [topic]', blurb: 'print bundled documentation (for agents to read)' },
    {
      usage: 'upgrade [--cli-only|--plugins-only]',
      blurb: 'update the CLI and host plugins (alias: update)',
    },
  ],
  start: [
    {
      usage: 'coder setup-host [claude|agents]',
      blurb: '"claude" for Claude Code, "agents" for any ~/.agents host (Codex, Pi, ...)',
    },
    {
      usage: 'coder run --engine [codex|claude] "<task>"',
      blurb: "run a task on that engine's default model",
    },
    {
      usage: 'coder task result <task-id> --wait',
      blurb: 'wait for the answer; returns early if the task needs your approval',
    },
  ],
  agents: [{ usage: 'coder docs skill [--claude]', blurb: 'load the skill once' }],
  usage: [{ usage: 'coder <command> --help', blurb: 'flags and details for any command' }],
};
