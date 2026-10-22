/** `coder credentials login <claude|codex>`: subscription sign-in through the server's runner. */
import process from 'node:process';

import * as z from 'zod/mini';

import { type LoginView } from '../../server/settings/logins';
import { errStyle, outStyle } from '../../tui/output';
import { credentialServerOptions } from '../../utils/args';
import { command, nextSteps } from '../../cli';

function printLoginLink(login: LoginView): void {
  if (login.url) process.stderr.write(`Open ${outStyle.cyan(login.url)}\n`);
  if (login.code) process.stderr.write(`Enter the code ${outStyle.bold(login.code)}\n`);
}

async function askLoginCode(): Promise<string> {
  const readline = await import('node:readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const code = (await rl.question('Paste the code from the sign-in page ')).trim();
  rl.close();
  return code;
}

function printLogin(login: LoginView): void {
  if (login.state === 'failed')
    return void process.stderr.write(`${errStyle.red(login.error ?? 'Sign-in failed.')}\n`);
  process.stdout.write(`Signed in. Your ${outStyle.bold(login.engine)} subscription is saved.\n`);
}

export const commandCredentialsLogin = command({
  name: 'login',
  description: 'sign in to a claude or codex subscription on the server',
  usage:
    "Runs the official claude or codex sign-in on the server's runner, prints the sign-in link or device code, and waits. Claude asks you to paste the code the sign-in page shows. The result replaces your subscription for that engine. Needs CLAUDE_SUBSCRIPTIONS=1 or CODEX_SUBSCRIPTIONS=1 on the server.",
  access: 'write',
  approvalPolicy: {
    handoff: {
      page: '/settings/credentials',
      label: 'Connect the engine',
      action: 'engine',
      args: ['engine'],
    },
  },
  args: {
    engine: z.optional(z.string()).check(z.describe('claude or codex')),
    ...credentialServerOptions,
  },
  globalFlags: { cwd: false },
  cli: { positional: ['engine'] },
  mcp: false,
  run: async ({ options, args: [engine] }) => {
    const { loginCredential } = await import('../../core/remote');
    return loginCredential(engine, {
      ...options,
      onStart: cancel =>
        process.once('SIGINT', () => void cancel().finally(() => process.exit(130))),
      onOpen: printLoginLink,
      code: askLoginCode,
    });
  },
  next: ({ result }) =>
    result.state === 'failed' ? nextSteps(['Try again'], { stream: 'stderr' }) : [],
  print: printLogin,
  exit: (login, { options }) => (!options.json && login.state === 'failed' ? 1 : undefined),
});
