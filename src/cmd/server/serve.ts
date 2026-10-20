/** `coder server serve`: parse options, start the core server, then print its address. */
import process from 'node:process';

import * as z from 'zod/mini';

import type { RunnerKind } from '../../agent/types';
import { CoderError } from '../../core/dispatch';
import { coderHome } from '../../core/state';
import type { ServeDetails } from '../../server/serve';
import { outStyle } from '../../tui/output';
import { openUrl } from '../../tui/prompt';
import { arg, flag, str } from '../../utils/args';
import { command, nextSteps } from '../../cli';

function printServe(result: ServeDetails): void {
  const s = outStyle;
  const rows: Array<[string, string]> = [
    ...(result.publicUrl !== result.address
      ? [['public', result.publicUrl] as [string, string]]
      : []),
    ['store', result.database ?? (result.mode === 'local' ? coderHome() : result.store)],
    ['runner', result.runner],
    ...(result.signIn ? [['sign-in', result.signIn] as [string, string]] : []),
    ...(result.mintedToken ? [['token', result.mintedToken] as [string, string]] : []),
  ];
  const width = Math.max(...rows.map(([key]) => key.length)) + 2;
  process.stdout.write(
    `${s.bold({ local: 'Coder local server', memory: 'Coder test server', cloud: 'Coder server' }[result.mode])} ${s.dim(`listening on ${result.address}`)}\n`,
  );
  for (const [key, value] of rows)
    process.stdout.write(`  ${s.light(key.padEnd(width))}${value}\n`);
  if (result.warnings.length) process.stdout.write('\n');
  for (const warning of result.warnings) process.stdout.write(`  ${s.yellow('!')} ${warning}\n`);

  void result.cacheMigration
    ?.then(migration => {
      if (migration.tasks || migration.flows || migration.files)
        process.stdout.write(
          `\n  moved ${migration.tasks.toLocaleString('en-US')} archived tasks to ${migration.cache}\n`,
        );
    })
    .catch(error =>
      process.stderr.write(
        `\n  Cache migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
      ),
    );
}

export const commandServerServe = command({
  name: 'serve',
  description: 'run the server',
  usage:
    "Run the Coder server on Bun: the address platforms deliver events to, the dashboard, and the worker that runs tasks. With DATABASE_URL it is a full server with sign-in and workspaces. Without one it is the dashboard for this machine's CLI: its config, agents, tasks and engine logins, on loopback only. --memory makes a throwaway test server that keeps everything in memory. Configured through the environment; every variable is in coder docs self-host.",
  access: 'write',
  args: {
    port: arg(
      z.optional(z.coerce.number().check(z.int(), z.positive())),
      'listen port (default: PORT, else the port in a localhost PUBLIC_URL, else 8787)',
      '<n>',
    ),
    host: str(
      'listen address (default: HOST, else 127.0.0.1 without a database, else every interface)',
      '<address>',
    ),
    memory: flag('a throwaway test server: everything in memory, no sign-in, admin token only'),
    runner: str('local, local-docker, vercel-sandbox, github-actions, or http', '<name>'),
  },
  mcp: false,
  cli: {
    env: [
      [
        'PUBLIC_URL',
        'the address platforms and browsers reach the server at (default http://localhost:<port>)',
      ],
      ['PORT', 'listen port, as hosts set it (default 8787)'],
      ['HOST', 'listen address, as --host'],
      ['DATABASE_URL', 'Postgres, set up with drizzle-kit push; turns on sign-in and workspaces'],
      [
        'AUTH_WULAR_URL',
        'the Wular Auth issuer people sign in with (default https://auth.wular.ai)',
      ],
      [
        'SERVER_ENCRYPTION_KEY',
        'encrypts stored secrets and derives the sign-in keys; required with DATABASE_URL (openssl rand -base64 32)',
      ],
      [
        'RUNNER',
        'where tasks run: local (default), local-docker, vercel-sandbox, github-actions, http',
      ],
      [
        'MAX_TASKS, TASK_TIMEOUT, TASK_STALL, TASK_ATTEMPTS',
        'runner capacity and lifecycle limits',
      ],
      [
        'ADMIN_TOKEN',
        'local and memory servers: the dashboard and CLI key; minted and shown when unset',
      ],
      [
        'CODER_CACHE_HOME',
        'archived tasks, flows and usage (default OS cache directory/wular-coder)',
      ],
      ['WORK_DIR', 'where the local runner keeps task work folders'],
      ['SERVER_NAME', 'what the dashboard calls this server (default Coder)'],
    ],
    examples: [
      'PUBLIC_URL=https://abc.ngrok.app coder server serve  # receive GitHub and Slack events through a tunnel; the tunnel serves only their webhooks and callbacks',
      'PUBLIC_URL=https://agents.example.com DATABASE_URL=postgres://... coder server serve  # on your own host, backed by Postgres',
    ],
  },
  async run({ options, cwd }) {
    const { rerunUnderBun } = await import('../../server/env');

    await rerunUnderBun();
    if (options.memory && !process.env.ADMIN_TOKEN && !process.stdout.isTTY)
      throw new CoderError(
        'invalid-option',
        'Memory server needs an admin token: set ADMIN_TOKEN, or run in a terminal to get a printed one.',
      );

    const { serve } = await import('../../server/serve');
    const result = await serve({
      cwd,
      port: options.port,
      ...(options.host ? { host: options.host } : {}),
      ...(options.runner ? { runner: options.runner as RunnerKind } : {}),
      ...(options.memory ? { memory: true } : {}),
    });
    const shutdown = () => void result.close().finally(() => process.exit(0));
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    return result;
  },
  json: result => ({
    ok: true,
    address: result.address,
    publicUrl: result.publicUrl,
    runner: result.runner,
    store: result.store,
    mode: result.mode,
    maxTasks: result.maxTasks,
    ...(result.signIn ? { signIn: result.signIn } : {}),
    ...(result.mintedToken ? { adminToken: result.mintedToken } : {}),
    warnings: result.warnings,
  }),
  next: ({ result }) =>
    result.mode === 'memory'
      ? nextSteps([
          `the CLI reaches this server with its token in ADMIN_TOKEN: coder task list --server ${result.publicUrl}`,
        ])
      : [],
  print: printServe,
  afterNext(result) {
    const s = outStyle;
    if (result.dashboard) {
      const opened = process.stdout.isTTY && openUrl(result.dashboard);
      process.stdout.write(
        opened
          ? `\nOpening the dashboard in your browser. If it doesn't open, go to:\n  ${result.dashboard}\n`
          : `\n  ${s.light('dashboard')}  ${result.dashboard}\n`,
      );
    }
  },
});
