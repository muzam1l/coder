/** `coder runner <serve|list|rename|remove>`: a group; the work is in the subcommands. */
import { group } from '../../cli';

// `serve` loads the server's database stack, so only on use.
export const commandRunner = group(
  'runner',
  {
    add: async () => (await import('./add')).commandRunnerAdd,
    default: async () => (await import('./default')).commandRunnerDefault,
    test: async () => (await import('./test')).commandRunnerTest,
    serve: async () => (await import('./serve')).commandRunnerServe,
    list: async () => (await import('./list')).commandRunnerList,
    rename: async () => (await import('./rename')).commandRunnerRename,
    remove: async () => (await import('./remove')).commandRunnerRemove,
  },
  {
    menu: [
      { usage: 'add <kind>', blurb: 'connect a runner' },
      { usage: 'default <id>', blurb: 'set the default in its scope' },
      { usage: 'test <id>', blurb: 'check a runner connection' },
      { usage: 'serve --url <public url>', blurb: "run your server's tasks on this machine" },
      { usage: 'list', blurb: "list your runners and the workspace's" },
      { usage: 'rename <id> <name>', blurb: 'rename a runner' },
      { usage: 'remove <id>', blurb: 'remove a runner' },
    ],
    description: ["Run your Coder server's tasks on your own machine, reached through any tunnel."],
    exampleCommand: 'runner serve',
  },
);
