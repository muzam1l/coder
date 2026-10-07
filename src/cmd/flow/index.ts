/** `coder flow <sub>`: the flow command group. See docs/flows.md. */
import { group } from '../../cli';

const FLOW_MENU: { usage: string; blurb: string }[] = [
  {
    usage: 'run <name|path> [--wait] [--args ...]',
    blurb: 'run a flow in the background (--wait to follow it live)',
  },
  { usage: 'list', blurb: 'recent flow runs (by default running + just stopped)' },
  { usage: 'discover', blurb: 'list flows runnable here (workspace + global)' },
  { usage: 'result [run-id]', blurb: 'progress and result of a run' },
  { usage: 'watch [run-id]', blurb: 'watch a run live (replay + follow)' },
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

export const commandFlow = group(
  'flow',
  {
    run: async () => (await import('./run')).commandRun,
    list: async () => (await import('./list')).commandList,
    ls: async () => (await import('./list')).commandList,
    discover: async () => (await import('./discover')).commandDiscover,
    result: async () => (await import('./result')).commandResult,
    watch: async () => (await import('./watch')).commandWatch,
    stream: async () => (await import('./watch')).commandWatch, // silent alias for watch
    stop: async () => (await import('./stop')).commandStop,
    resume: async () => (await import('./resume')).commandResume,
    archive: async () => (await import('./archive')).commandArchive,
    delete: async () => (await import('./delete')).commandDelete,
  },
  {
    menu: FLOW_MENU,
    description: [
      'Orchestrate many coder tasks with a plain TypeScript file: dispatch, gates,',
      'concurrency, journaling, and resume. Flows live in .coder/flows/ (workspace)',
      'or ~/.coder/flows/ (global). See `coder docs flows`.',
    ],
  },
  { aliases: { stream: 'watch', ls: 'list' }, hint: 'Run a flow: coder flow run <name>' },
);
