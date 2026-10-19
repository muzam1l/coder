/** `coder --help`: the top-level sections, kept apart from the app so they load alone. */
import type { TopHelpSpec } from '../tui/help';

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
    { usage: 'credentials <cmd>', blurb: 'engine credentials: list, add, login, remove' },
    { usage: 'server <cmd>', blurb: 'self-host Coder: serve, rotate-key' },
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
      usage: 'connection <cmd>',
      blurb: 'platform accounts, API keys and MCP servers tasks use: add, list, rm, ...',
    },
    { usage: 'docs [topic]', blurb: 'print bundled documentation (for agents to read)' },
    {
      usage: 'upgrade [--cli-only|--plugins-only]',
      blurb: 'update the CLI and host plugins',
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
  agents: [
    { usage: 'coder docs skill [--claude]', blurb: 'load the skill once' },
    { usage: 'coder mcp', blurb: 'the MCP server your host runs (setup-host adds it)' },
  ],
  cloudIntro:
    'Your agents, always on at coder.wular.ai, connected to GitHub, Slack and any other app.',
  cloud: [
    { usage: 'coder auth login', blurb: 'sign in' },
    {
      usage: 'coder <command> --server',
      blurb: 'the same commands on your Coder server, e.g. coder run --server "<task>"',
    },
  ],
  usage: [{ usage: 'coder <command> --help', blurb: 'flags and details for any command' }],
};
