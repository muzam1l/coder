/** `coder server <serve|migrate|rotate-key|app>`: a group; the work is in the subcommands. */
import { group } from '../../cli';

const SERVER_MENU: { usage: string; blurb: string }[] = [
  { usage: 'serve [--port <n>]', blurb: 'run the server' },
  { usage: 'migrate', blurb: 'apply pending database migrations' },
  { usage: 'rotate-key', blurb: 're-seal secrets with SERVER_ENCRYPTION_KEY' },
  { usage: 'app create <integration>', blurb: "create the built-in agent's public app" },
  { usage: 'workflow', blurb: 'print the GitHub Actions workflow for RUNNER=github-actions' },
];

// Loaded on use, since the server's database stack costs every other command a second.
export const commandServer = group(
  'server',
  {
    serve: async () => (await import('./serve')).commandServerServe,
    migrate: async () => (await import('./migrate')).commandServerMigrate,
    'rotate-key': async () => (await import('./rotate-key')).commandServerRotateKey,
    app: async () => (await import('./app')).commandServerApp,
    workflow: async () => (await import('./workflow')).commandServerWorkflow,
  },
  {
    menu: SERVER_MENU,
    description: [
      'Self-host Coder: the server your agents and platform apps talk to, with a dashboard and sign-in. We run one as the hosted service; you can run your own.',
    ],
    exampleCommand: 'server serve',
  },
  { nested: ['app'] },
);
