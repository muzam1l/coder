/** `coder task <sub>`: the task command group. */
import { group } from '../../cli';
import type { HelpRow } from '../../core/types';

export const TASK_FLAGS: HelpRow[] = [
  ['--wait', 'run in the foreground and block until the answer is ready'],
  [
    '--engine <codex|claude|custom>',
    'engine to use; custom runs your configured custom models (default: first in the chain)',
  ],
  [
    '--model <alias|slug>',
    'luna/sol/astra (codex) · sonnet/opus/fable (claude) · a custom model (coder model list)',
  ],
  ['--effort <low|medium|high>', 'reasoning effort'],
  ['--permissions <mode>', 'read-only · workspace-write · auto (default: auto)'],
  ['--resume <task-id>', "continue that task's thread instead of a fresh run"],
  [
    '--mcp <names|all|json>',
    'attach MCP servers from `mcp` in .coder/config.json by name (or all), or an inline JSON array [{"name","command","args","env","tools"}]; none by default, all adds your engine\'s own MCP servers',
  ],
  [
    '--add-dir <dir>',
    'give the task another directory beyond --cwd (repeatable); read-only can only read it, other modes can also write',
  ],
];

export const TASK_MENU: {
  sub: string;
  usage: string;
  blurb: string;
  alias?: string;
}[] = [
  {
    sub: 'run',
    usage: 'run "<text>"',
    blurb: 'run a task (background; --wait blocks)',
    alias: 'run',
  },
  {
    sub: 'list',
    usage: 'list',
    blurb: 'list recent tasks (by default running + just stopped)',
    alias: 'list',
  },
  {
    sub: 'result',
    usage: 'result [task-id]',
    blurb: 'status + final answer (--wait blocks)',
    alias: 'result',
  },
  {
    sub: 'watch',
    usage: 'watch [task-id]',
    blurb: "stream a task's live transcript",
  },
  {
    sub: 'steer',
    usage: 'steer <task-id> "<follow-up>"',
    blurb: "continue a task's thread",
  },
  {
    sub: 'ask',
    usage: 'ask <task-id> "<question>"',
    blurb: 'ask about a task without interrupting it',
  },
  { sub: 'stop', usage: 'stop <task-id>', blurb: 'interrupt a running task' },
  {
    sub: 'archive',
    usage: 'archive <task-id>',
    blurb: 'archive a session (or --all-stopped)',
  },
  {
    sub: 'delete',
    usage: 'delete <task-id>',
    blurb: 'delete a session (or --all-archived)',
  },
  {
    sub: 'approvals',
    usage: 'approvals [task-id]',
    blurb: 'pending approvals (all tasks, or one)',
  },
  {
    sub: 'approve',
    usage: 'approve <id>',
    blurb: 'answer an escalated permission',
  },
];

// Creating a task needs `run` (or `coder run`), so an unknown first arg is an error, not a task.
export const commandTaskGroup = group(
  'task',
  {
    'archive-sweep': async () => (await import('./archive-sweep')).commandArchiveSweep,
    worker: async () => (await import('./worker')).commandWorker,
    run: async () => (await import('./run')).commandTask,
    list: async () => (await import('./list')).commandTasks,
    ls: async () => (await import('./list')).commandTasks,
    watch: async () => (await import('./watch')).commandWatch,
    stream: async () => (await import('./watch')).commandWatch, // silent alias for watch
    result: async () => (await import('./result')).commandResult,
    steer: async () => (await import('./steer')).commandSteer,
    ask: async () => (await import('./ask')).commandAsk,
    stop: async () => (await import('./stop')).commandStop,
    archive: async () => (await import('./archive')).commandArchive,
    delete: async () => (await import('./delete')).commandDelete,
    approvals: async () => (await import('./approvals')).commandApprovals,
    approve: async () => (await import('./approve')).commandApprove,
  },
  {
    menu: TASK_MENU.map(m => ({
      usage: m.usage,
      blurb: m.blurb,
      ...(m.alias ? { note: `(coder ${m.alias})` } : {}),
    })),
  },
  { aliases: { stream: 'watch', ls: 'list' }, hint: 'Run a task: coder run "<text>"' },
);
